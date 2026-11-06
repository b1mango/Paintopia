import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/app/AppShell";
import { apiClient } from "../src/lib/apiClient";
const user = { email: "artist@test.local", role: "admin" as const, quota: 100 };
const model = "gpt-image-2.5-flare-c";
const providers = ["A", "B"].map((id) => ({ id, name: `来源${id}`, kind: "image" as const, baseUrl: "https://example.com", apiKey: "********", model, mode: "generations", enabled: true }));
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).startsWith("/api/assets?scope=mine&")) return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 20 }), { status: 200 });
    throw new Error("Unexpected unmocked request: " + String(input));
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  vi.spyOn(apiClient, "listQuotaPricing").mockResolvedValue([]);
  vi.spyOn(apiClient, "listImageCapabilities").mockResolvedValue({ models: providers.map((p) => ({ providerId: p.id, providerName: p.name, model, mode: p.mode, resolutions: ["1K"] })) });
});
afterEach(() => vi.restoreAllMocks());
const modelList = () => screen.getByRole("listbox", { name: "模型" });
const selectedModel = () => within(modelList()).queryByRole("option", { selected: true })?.getAttribute("aria-label") ?? "";
const pickModel = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: /^模型 / }));
  fireEvent.click(within(modelList()).getByRole("option", { name }));
};
describe("generation workflow", () => {
  it("closes an open composer popover when pressing anywhere outside it, including blank composer space", async () => {
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: `${model} · 来源A` });
    const chip = screen.getByRole("button", { name: /^画幅/ });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(screen.getByRole("button", { name: "16:9" }));
    fireEvent.click(screen.getByRole("button", { name: "16:9" }));
    expect(screen.getByRole("button", { name: /^画幅/ })).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(screen.getByLabelText("提示词"));
    expect(screen.getByRole("button", { name: /^画幅/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /^模型 / }));
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("button", { name: /^模型 / })).toHaveAttribute("aria-expanded", "false");
  });

  it("binds duplicate model IDs to their selected source and opens preview with copy feedback", async () => {
    const generate = vi.spyOn(apiClient, "generateStream").mockResolvedValue({ jobId: "job", assets: [{ id: "asset", imageUrl: "/image.png", prompt: "saved prompt", sizeBytes: 2621440, params: {actualWidth: 2048, actualHeight: 2048}, createdAt: "2026-10-09T00:00:00Z" }] });
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: `${model} · 来源A` });
    const selector = modelList();
    expect(within(selector).getByRole("group", { name: "来源A" })).toBeInTheDocument();
    expect(within(selector).getByRole("group", { name: "来源B" })).toBeInTheDocument();
    expect(screen.queryByLabelText("搜索模型或来源")).not.toBeInTheDocument();
    expect(within(selector).getByRole("option", { name: `${model} · 来源B` })).toBeInTheDocument();
    pickModel(`${model} · 来源B`);
    expect(selectedModel()).toBe(`${model} · 来源B`);
    expect(screen.getByRole("button", { name: /^模型 / })).toHaveAttribute("aria-expanded", "false");
    expect(within(selector).getByRole("option", { name: `${model} · 来源A` })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("start-generation-button"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(expect.objectContaining({ providerId: "B", params: expect.objectContaining({ model, resolution: "4K", quality: "high" }) }), expect.any(Function), expect.any(Function)));
    expect(await screen.findByAltText("生成结果")).toHaveAttribute("src", "/api/assets/asset/thumbnail");
    expect(screen.queryByAltText("完整创作图片")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "放大生成图片" }));
    const dialog = screen.getByRole("dialog", { name: "创作图片" });
    expect(within(dialog).getByText("2048 × 2048")).toBeInTheDocument();
    expect(within(dialog).getByText("2.50 MB")).toBeInTheDocument();
    expect(within(dialog).getByAltText("完整创作图片")).toHaveAttribute("src", "/image.png");
    expect(within(dialog).getByAltText("图片快速预览")).toBeInTheDocument();
    fireEvent.load(within(dialog).getByAltText("完整创作图片"));
    expect(within(dialog).queryByAltText("图片快速预览")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^复制提示词$/ }));
    expect(await within(dialog).findByText("提示词已复制")).toBeInTheDocument();
    expect(copy).toHaveBeenCalledWith("saved prompt");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("shows failed and successful generation details from the authenticated history", async () => {
    vi.spyOn(apiClient, "listGenerationHistory").mockResolvedValue({ total: 1, page: 1, pageSize: 20, items: [{ userId: "artist", userEmail: "artist@test.local", quotaCost: 0, id: "job", providerId: "B", providerName: "来源B", model, status: "failed", createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:02Z", durationMs: 2000, params: { quality: "high", resolution: "2K" }, error: "上游拒绝请求" }] });
    render(<AppShell user={user} activeModule="usage-log" />);
    const dialog = screen.getByRole("region", { name: "生图调用记录" });
    expect(await within(dialog).findByText("来源B")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "查看调用详情 job" }));
    expect(within(screen.getByRole("dialog")).getByText("上游拒绝请求")).toBeInTheDocument();
    expect(within(dialog).getByText("2K")).toBeInTheDocument();
    expect(within(dialog).getByText("0")).toBeInTheDocument();
  });
  it("disables an interface immediately and refreshes quota and exact model options", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue(providers);
    const quotas = vi.spyOn(apiClient, "listProviderQuotas").mockResolvedValue([{ providerId: "A", status: "unlimited", remaining: null, used: null, total: null, source: "newapi" }]);
    const models = vi.spyOn(apiClient, "listProviderModels").mockResolvedValue({ models: [model, "gpt-image-2.5-flare-c-4k"] });
    const update = vi.spyOn(apiClient, "updateProvider").mockResolvedValue({ ...providers[0]!, enabled: false });
    render(<AppShell user={user} activeModule="config-image" />);
    expect(screen.queryByText("令牌不限额 · 余额未知")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /^禁用接口 (来源A|新名称)$/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("A", expect.objectContaining({ enabled: false, apiKey: "" })));
    expect(await screen.findByRole("button", { name: "启用接口 来源A" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "来源A" }));
    expect(screen.getByLabelText("启用生图接口")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "关闭编辑窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新接口额度与模型" }));
    await waitFor(() => expect(screen.getByTestId("image-provider-test-status")).toHaveTextContent("额度与模型已刷新"));
    expect(quotas).toHaveBeenCalledTimes(2);
    expect(models).toHaveBeenCalledWith({ providerId: "A", baseUrl: "https://example.com" });
  });
  it("keeps freshly saved settings when disabling an interface", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue(providers);
    vi.spyOn(apiClient, "listProviderQuotas").mockResolvedValue([]);
    const update = vi.spyOn(apiClient, "updateProvider").mockImplementation(async (id, input) => ({ ...input, id }));
    render(<AppShell user={user} activeModule="config-image" />);
    fireEvent.click(await screen.findByRole("button", { name: "来源A" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新名称" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://updated.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑生图渠道" })).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("配置已保存");
    fireEvent.click(await screen.findByRole("button", { name: /^禁用接口 (来源A|新名称)$/ }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith("A", expect.objectContaining({ name: "新名称", baseUrl: "https://updated.example.com", enabled: false })));
  });
  it("saves selected models and refreshes creation capabilities immediately", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue(providers);
    vi.spyOn(apiClient, "listProviderQuotas").mockResolvedValue([]);
    vi.spyOn(apiClient, "listProviderModels").mockResolvedValue({ models: [model, "new-image-4k"] });
    const update = vi.spyOn(apiClient, "updateProvider").mockImplementation(async (id, input) => ({ ...input, id }));
    const view = render(<AppShell user={user} activeModule="config-image" />);
    fireEvent.click(await screen.findByRole("button", { name: "来源A" }));
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    await within(screen.getByRole("dialog", { name: "编辑生图渠道" })).findByText(/已获取 2 个候选模型/);
    fireEvent.click(within(screen.getByTestId("image-provider-form")).getByRole("button", { name: model }));
    const list = screen.getAllByRole("listbox").find((item) => item.getAttribute("aria-multiselectable") === "true")!;
    fireEvent.click(within(list).getByRole("option", { name: "new-image-4k" }));
    expect(within(screen.getByRole("dialog", { name: "编辑生图渠道" })).getByRole("status")).toHaveTextContent("模型选择尚未保存");
    expect(update).not.toHaveBeenCalled();
    const capabilities = vi.mocked(apiClient.listImageCapabilities);
    capabilities.mockResolvedValue({ models: [{ providerId: "A", providerName: "来源A", model: "new-image-4k", resolutions: ["4K"] }] });
    const beforeSave = capabilities.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑生图渠道" })).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("配置已保存");
    expect(update).toHaveBeenCalledWith("A", expect.objectContaining({ model: `${model}, new-image-4k` }));
    expect(screen.queryByText(/模型选择尚未保存/)).not.toBeInTheDocument();
    view.rerender(<AppShell user={user} activeModule="create" />);
    await waitFor(() => expect(capabilities.mock.calls.length).toBeGreaterThan(beforeSave));
    expect(await screen.findByRole("option", { name: "new-image-4k · 来源A" })).toBeInTheDocument();
  });
  it("refreshes on cross-tab saves and focus without stale responses overwriting newer models", async () => {
    const capabilities = vi.mocked(apiClient.listImageCapabilities);
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: `${model} · 来源A` });
    let resolveOld!: (result: Awaited<ReturnType<typeof apiClient.listImageCapabilities>>) => void;
    capabilities.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    fireEvent.focus(window);
    capabilities.mockResolvedValue({ models: [{ providerId: "B", providerName: "来源B", model: "new-image-4k", resolutions: ["4K"] }] });
    fireEvent(window, new StorageEvent("storage", { key: "paintopia:providers-changed", newValue: "updated" }));
    await screen.findByRole("option", { name: "new-image-4k · 来源B" });
    await act(async () => resolveOld({ models: [] }));
    expect(screen.getByRole("option", { name: "new-image-4k · 来源B" })).toBeInTheDocument();
  });
  it("returns a lower-resolution image visibly with its warning", async () => {
    vi.spyOn(apiClient, "generateStream").mockResolvedValue({ jobId: "low-res", assets: [{ id: "img", imageUrl: "/image.png", prompt: "test", createdAt: new Date().toISOString(), params: { actualWidth: 1536, actualHeight: 1024, resolutionWarning: "图片已保留：请求 4K，实际 1536x1024（1K）" } }] });
    render(<AppShell user={user} />);
    await waitFor(() => expect(screen.getByTestId("start-generation-button")).toBeEnabled());
    fireEvent.click(screen.getByTestId("start-generation-button"));
    expect(await screen.findByAltText("生成结果")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("图片已保留：请求 4K，实际 1536x1024（1K）");
    expect(screen.getByRole("link", { name: "下载创作图片" })).toBeInTheDocument();
  });
  it("disables a nonselected provider from its own list row", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue(providers);
    vi.spyOn(apiClient, "listProviderQuotas").mockResolvedValue([]);
    const update = vi.spyOn(apiClient, "updateProvider").mockImplementation(async (id, input) => ({ ...input, id }));
    render(<AppShell user={user} activeModule="config-image" />);
    fireEvent.click(await screen.findByRole("button", { name: "禁用接口 来源B" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("B", expect.objectContaining({ enabled: false })));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "来源A" }));
    expect(screen.getByLabelText("名称")).toHaveValue("来源A");
    expect(await screen.findByRole("button", { name: "启用接口 来源B" })).toBeInTheDocument();
  });
  it("counts elapsed wait and receives honest server stage messages", async () => {
    let finish!: (result: { assets: [] }) => void;
    vi.spyOn(apiClient, "generateStream").mockImplementation(async (_input, _preview, stage) => {
      stage?.({ type: "stage", stage: "waiting", message: "上游不支持过程预览，等待最终图片" });
      return new Promise((resolve) => { finish = resolve; });
    });
    render(<AppShell user={user} />);
    await waitFor(() => expect(screen.getByTestId("start-generation-button")).toBeEnabled());
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("start-generation-button"));
      act(() => { vi.advanceTimersByTime(32000); });
      expect(screen.getByRole("status")).toHaveTextContent("已等待 32 秒");
      expect(screen.getByRole("status")).toHaveTextContent("上游不支持过程预览");
      await act(async () => finish({ assets: [] }));
    } finally { vi.useRealTimers(); }
  });
  it("aligns a tier-specific model with its requested resolution", async () => {
    vi.spyOn(apiClient, "listImageCapabilities").mockResolvedValue({ models: [{ providerId: "B", providerName: "来源B", model: "gpt-image-2.5-2k", resolutions: ["2K"] }] });
    const generate = vi.spyOn(apiClient, "generateStream").mockResolvedValue({ assets: [] });
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: "gpt-image-2.5-2k · 来源B" });
    await waitFor(() => {
      expect(screen.getByLabelText("图片宽度")).toHaveValue(2048);
      expect(screen.getByLabelText("图片高度")).toHaveValue(2048);
    });
    expect(screen.getByRole("button", { name: "2K" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "1K" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "4K" })).toBeDisabled();
    fireEvent.click(screen.getByTestId("start-generation-button"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "B", params: expect.objectContaining({ model: "gpt-image-2.5-2k", resolution: "2K" })
    }), expect.any(Function), expect.any(Function)));
  });
  it("does not invent usable models when no provider is available", async () => {
    vi.spyOn(apiClient, "listImageCapabilities").mockResolvedValue({ models: [] });
    render(<AppShell user={user} />);
    expect(screen.getByTestId("start-generation-button")).toBeDisabled();
    expect(screen.getByText(/暂无可用模型/)).toBeInTheDocument();
  });
  it("submits aligned custom dimensions after swapping width and height", async () => {
    const generate = vi.spyOn(apiClient, "generateStream").mockResolvedValue({ assets: [] });
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: `${model} · 来源A` });
    fireEvent.click(screen.getByRole("button", { name: "2K" }));
    fireEvent.click(screen.getByRole("button", { name: "16:9" }));
    expect(screen.getByLabelText("图片宽度")).toHaveValue(2048);
    expect(screen.getByLabelText("图片高度")).toHaveValue(1152);
    fireEvent.change(screen.getByLabelText("图片宽度"), { target: { value: "2001" } });
    fireEvent.blur(screen.getByLabelText("图片宽度"));
    expect(screen.getByLabelText("图片宽度")).toHaveValue(2000);
    fireEvent.click(screen.getByRole("button", { name: "交换宽高" }));
    expect(screen.getByLabelText("图片宽度")).toHaveValue(1152);
    expect(screen.getByLabelText("图片高度")).toHaveValue(2000);
    fireEvent.click(screen.getByRole("button", { name: "中" }));
    fireEvent.click(screen.getByRole("button", { name: "2 张" }));
    fireEvent.click(screen.getByTestId("start-generation-button"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "A", params: expect.objectContaining({ model, size: "1152x2000", resolution: "2K", quality: "medium", n: 2 })
    }), expect.any(Function), expect.any(Function)));
  });

  it("exits automatic aspect ratio through 4K and 16:9 before submitting manual dimensions", async () => {
    const generate = vi.spyOn(apiClient, "generateStream").mockResolvedValue({ assets: [] });
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: `${model} · 来源A` });
    const width = screen.getByLabelText("图片宽度");
    const height = screen.getByLabelText("图片高度");
    const aspectRatioControls = screen.getByText("宽高比").parentElement!;

    fireEvent.click(within(aspectRatioControls).getByRole("button", { name: "自动" }));
    expect(width).toHaveValue(null);
    expect(height).toHaveValue(null);
    fireEvent.click(screen.getByRole("button", { name: "4K" }));
    expect(width).toHaveValue(2880);
    expect(height).toHaveValue(2880);
    fireEvent.click(within(aspectRatioControls).getByRole("button", { name: "16:9" }));
    expect(width).toHaveValue(3840);
    expect(height).toHaveValue(2160);

    fireEvent.change(width, { target: { value: "2049" } });
    fireEvent.blur(width);
    fireEvent.change(height, { target: { value: "1535" } });
    fireEvent.blur(height);
    expect(width).toHaveValue(2048);
    expect(height).toHaveValue(1536);
    expect(generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("start-generation-button"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "A",
      params: { model, size: "2048x1536", resolution: "2K", aspectRatio: "4:3", quality: "high", background: "auto", n: 1 }
    }), expect.any(Function), expect.any(Function)));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "complete saved parameters", restoredModel: model, metadata: { resolution: "2K", aspectRatio: "16:9" } },
    { label: "pixel-only history with a locked 2K model", restoredModel: "gpt-image-2.5-2k", metadata: {} }
  ])("restores a server asset without generating until explicitly submitted: $label", async ({ restoredModel, metadata }) => {
    vi.mocked(apiClient.listImageCapabilities).mockResolvedValue({ models: [
      { providerId: "A", providerName: "来源A", model, mode: "generations", resolutions: ["1K"] },
      { providerId: "B", providerName: "来源B", model: restoredModel, mode: "generations", resolutions: ["2K"] }
    ] });
    const asset = { id: "restore-asset", imageUrl: "/restored.png", thumbnailUrl: "/restored-thumb.png",
      prompt: "restore my exact prompt", createdAt: "2026-10-09T00:00:00Z",
      params: { providerId: "B", model: restoredModel, size: "2048x1152", ...metadata, quality: "medium", n: 2, background: "transparent" } };
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ items: [asset], total: 1, page: 1, pageSize: 20 }), { status: 200 }));
    const generate = vi.spyOn(apiClient, "generateStream").mockResolvedValue({ assets: [] });
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: `${restoredModel} · 来源B` });
    fireEvent.click(await screen.findByRole("button", { name: "回填参数：restore my exact prompt" }));
    expect(screen.getByLabelText("提示词")).toHaveValue(asset.prompt);
    expect(selectedModel()).toBe(`${restoredModel} · 来源B`);
    expect(screen.getByLabelText("图片宽度")).toHaveValue(2048);
    expect(screen.getByLabelText("图片高度")).toHaveValue(1152);
    expect(screen.getByAltText("生成结果")).toHaveAttribute("src", asset.thumbnailUrl);
    expect(generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("start-generation-button"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: asset.prompt, providerId: "B",
      params: expect.objectContaining({ model: restoredModel, size: "2048x1152", resolution: "2K", aspectRatio: "16:9", quality: "medium", n: 2, background: "transparent" })
    }), expect.any(Function), expect.any(Function)));
  });

  it.each([
    { label: "explicit auto size clears previous dimensions", params: { size: "auto", resolution: "2K" }, width: null, height: null, size: "auto", resolution: "auto", ratio: "auto" },
    { label: "missing quality and ratio restore defaults", params: { resolution: "2K" }, width: 2048, height: 2048, size: "2048x2048", resolution: "2K", ratio: "1:1" }
  ])("resets historical creation parameters: $label", async ({ params, width, height, size, resolution, ratio }) => {
    const asset = { id: "default-history", imageUrl: "/default.png", prompt: "restore defaults", createdAt: "2026-10-09T00:00:00Z", params: { ...params, providerId: "B", model } };
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [asset], total: 1, page: 1, pageSize: 20 }), { status: 200 }));
    const generate = vi.spyOn(apiClient, "generateStream").mockResolvedValue({ assets: [] });
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: `${model} · 来源B` });
    fireEvent.click(screen.getByRole("button", { name: "4K" }));
    fireEvent.click(screen.getByRole("button", { name: "16:9" }));
    fireEvent.click(screen.getByRole("button", { name: "高" }));
    fireEvent.click(screen.getByRole("button", { name: "3 张" }));
    fireEvent.click(await screen.findByRole("button", { name: "回填参数：restore defaults" }));
    expect(screen.getByLabelText("图片宽度")).toHaveValue(width);
    expect(screen.getByLabelText("图片高度")).toHaveValue(height);
    expect(generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("start-generation-button"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(expect.objectContaining({ providerId: "B", params: expect.objectContaining({ size, resolution, aspectRatio: ratio, quality: "auto", n: 1, background: "auto" }) }), expect.any(Function), expect.any(Function)));
  });

  it("requires explicit source selection when a restored asset used an unavailable provider", async () => {
    const asset = { id: "old-source", imageUrl: "/old.png", prompt: "old source prompt", createdAt: "2026-10-09T00:00:00Z",
      params: { providerId: "deleted-provider", model, size: "1024x1024", resolution: "1K", quality: "auto" } };
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ items: [asset], total: 1, page: 1, pageSize: 20 }), { status: 200 }));
    const generate = vi.spyOn(apiClient, "generateStream");
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: `${model} · 来源A` });
    fireEvent.click(await screen.findByRole("button", { name: "回填参数：old source prompt" }));
    expect(selectedModel()).toBe("");
    expect(screen.getByTestId("start-generation-button")).toBeDisabled();
    expect(generate).not.toHaveBeenCalled();
    const capabilities = vi.mocked(apiClient.listImageCapabilities);
    const beforeRefresh = capabilities.mock.calls.length;
    await act(async () => { fireEvent.focus(window); });
    expect(capabilities.mock.calls.length).toBeGreaterThan(beforeRefresh);
    expect(selectedModel()).toBe("");
    expect(screen.getByTestId("start-generation-button")).toBeDisabled();
    await act(async () => { fireEvent(window, new StorageEvent("storage", { key: "paintopia:providers-changed", newValue: "refreshed" })); });
    expect(selectedModel()).toBe("");
    expect(screen.getByTestId("start-generation-button")).toBeDisabled();
    pickModel(`${model} · 来源B`);
    expect(screen.getByTestId("start-generation-button")).toBeEnabled();
    await act(async () => { fireEvent.focus(window); });
    expect(selectedModel()).toBe(`${model} · 来源B`);
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    { label: "provider ID takes precedence over name", source: { providerId: "B", providerName: "来源A" }, selected: "B" },
    { label: "legacy source name matches exactly", source: { providerName: "来源B" }, selected: "B" },
    { label: "deleted provider ID cannot fall back to its old name", source: { providerId: "deleted", providerName: "来源A" }, selected: "" },
    { label: "a partial provider name is not a match", source: { providerName: "来源" }, selected: "" },
    { label: "duplicate models without source remain unselected", source: {}, selected: "" }
  ])("restores historical sources safely: $label", async ({ source, selected }) => {
    const asset = { id: "source-match", imageUrl: "/history.png", prompt: "source matching", createdAt: "2026-10-09T00:00:00Z", params: { ...source, model, resolution: "1K" } };
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [asset], total: 1, page: 1, pageSize: 20 }), { status: 200 }));
    const generate = vi.spyOn(apiClient, "generateStream");
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: `${model} · 来源B` });
    fireEvent.click(await screen.findByRole("button", { name: "回填参数：source matching" }));
    expect(selectedModel()).toBe(selected ? `${model} · 来源${selected}` : "");
    expect(screen.getByTestId("start-generation-button")).toHaveProperty("disabled", !selected);
    expect(generate).not.toHaveBeenCalled();
  });

  it("restores edit references and pixel size, then clears edit state for a text history item", async () => {
    const reference = { id: "reference-1", imageUrl: "/reference.png", prompt: "saved reference", createdAt: "2026-10-09T00:00:00Z" };
    const editAsset = { id: "edit-history", imageUrl: "/edit.png", prompt: "edit history", createdAt: "2026-10-09T00:00:01Z",
      params: { model, providerId: "B", mode: "image-edit", assetIds: [reference.id], referenceImageCount: 1, size: "1536x1024", resolution: "1K", quality: "medium" } };
    const textAsset = { id: "text-history", imageUrl: "/text.png", prompt: "text history", createdAt: "2026-10-09T00:00:02Z",
      params: { model, providerId: "A", mode: "text-to-image", resolution: "2K", aspectRatio: "9:16", quality: "auto" } };
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [editAsset, textAsset], total: 2, page: 1, pageSize: 20 }), { status: 200 }));
    vi.mocked(apiClient.listImageCapabilities).mockResolvedValue({ models: [
      { providerId: "A", providerName: "来源A", model, mode: "generations", resolutions: ["1K", "2K"] },
      { providerId: "B", providerName: "来源B", model, mode: "edits", resolutions: ["1K", "2K"] }
    ] });
    vi.spyOn(apiClient, "listAssets").mockResolvedValue([reference]);
    const edit = vi.spyOn(apiClient, "generateEdit").mockResolvedValue({ assets: [] });
    const generate = vi.spyOn(apiClient, "generateStream").mockResolvedValue({ assets: [] });
    render(<AppShell user={user} />);
    await screen.findByRole("option", { name: `${model} · 来源A` });
    fireEvent.click(await screen.findByRole("button", { name: "回填参数：edit history" }));
    await screen.findByRole("option", { name: `${model} · 来源B` });
    expect(screen.getByLabelText("图片宽度")).toHaveValue(1536);
    expect(screen.getByLabelText("图片高度")).toHaveValue(1024);
    expect(await screen.findByRole("button", { name: "移除资产 saved reference" })).toBeInTheDocument();
    expect(edit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("start-generation-button"));
    await waitFor(() => expect(edit).toHaveBeenCalledWith(expect.objectContaining({ providerId: "B", images: [], assetIds: [reference.id], params: expect.objectContaining({ size: "1536x1024", quality: "medium" }) }), expect.any(Function)));
    await waitFor(() => expect(screen.getByTestId("start-generation-button")).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "回填参数：text history" }));
    await screen.findByRole("option", { name: `${model} · 来源A` });
    expect(screen.queryByText(/图生图 · 已垫/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("图片宽度")).toHaveValue(1152);
    expect(screen.getByLabelText("图片高度")).toHaveValue(2048);
    expect(generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("start-generation-button"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(expect.objectContaining({ providerId: "A", params: expect.objectContaining({ size: "1152x2048", resolution: "2K" }) }), expect.any(Function), expect.any(Function)));
    await waitFor(() => expect(screen.getByTestId("start-generation-button")).toBeEnabled());
    fireEvent.change(screen.getByTestId("image-edit-upload"), { target: { files: [new File([new Uint8Array([1])], "local.png", { type: "image/png" })] } });
    await screen.findByRole("option", { name: `${model} · 来源B` });
    expect(screen.getByText("图生图 · 已垫 1 张参考")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除资产 saved reference" })).not.toBeInTheDocument();
    expect(edit).toHaveBeenCalledTimes(1);
  });
});


describe("creation reset and preview layout regressions", () => {
  it("returns to the original draft when the selected history image is clicked again", async () => {
    const asset = {id:"toggle-history",imageUrl:"/history.png",prompt:"historical prompt",createdAt:"2026-10-11T00:00:00Z",params:{providerId:"A",model}};
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({items:[asset],total:1,page:1,pageSize:20}),{status:200}));
    render(<AppShell user={user} />);
    fireEvent.change(screen.getByLabelText("提示词"), {target:{value:"my unsent draft"}});
    const thumbnail = await screen.findByRole("button", {name:"回填参数：historical prompt"});
    fireEvent.click(thumbnail);
    expect(screen.getByLabelText("提示词")).toHaveValue("historical prompt");
    expect(thumbnail).toHaveAttribute("aria-pressed","true");
    fireEvent.click(thumbnail);
    expect(screen.getByLabelText("提示词")).toHaveValue("my unsent draft");
    expect(screen.queryByAltText("生成结果")).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"新建创作"})).not.toBeInTheDocument();
  });

  it("keeps the historical image status HUD outside the image frame", async () => {
    const asset = { id: "hud-history", imageUrl: "/hud-history.png", prompt: "history HUD", createdAt: "2026-10-11T00:00:00Z", params: { providerId: "A", model } };
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [asset], total: 1, page: 1, pageSize: 20 }), { status: 200 }));
    render(<AppShell user={user} />);
    fireEvent.click(await screen.findByRole("button", { name: "回填参数：history HUD" }));
    const preview = screen.getByRole("region", { name: "生成预览" });
    const frame = within(preview).getByAltText("生成结果").closest("[data-complete]");
    expect(frame).toHaveAttribute("data-complete", "false");
    expect(frame).toHaveAttribute("data-generating", "false");
    const hud = within(preview).getByRole("status");
    expect(hud).toHaveTextContent("历史作品");
    expect(preview).toContainElement(hud);
    expect(frame).not.toContainElement(hud);
  });
});

it("refreshes the 4K high estimate after pricing changes without reloading", async () => {
  const pricing=vi.mocked(apiClient.listQuotaPricing);
  pricing.mockResolvedValue([{key:"resolution.4k.quality.high",label:"4K high",amount:12}]);
  render(<AppShell user={user} />);
  await screen.findByRole("option",{name:`${model} · 来源A`});
  fireEvent.click(screen.getByRole("button",{name:"4K"}));
  fireEvent.click(screen.getByRole("button",{name:"高"}));
  expect(await screen.findByText(/预计消耗本站额度：12/)).toBeInTheDocument();
  pricing.mockResolvedValue([{key:"resolution.4k.quality.high",label:"4K high",amount:16}]);
  act(()=>window.dispatchEvent(new Event("paintopia-pricing-updated")));
  expect(await screen.findByText(/预计消耗本站额度：16/)).toBeInTheDocument();
});
it("keeps Images generation channels selectable in image edit mode", async () => {
  vi.spyOn(apiClient,"listAssets").mockResolvedValue([]);
  render(<AppShell user={user} />);
  await screen.findByRole("option",{name:`${model} · 来源A`});
  fireEvent.change(screen.getByTestId("image-edit-upload"),{target:{files:[new File([new Uint8Array([1])],"ref.png",{type:"image/png"})]}});
  expect(await screen.findByText("图生图 · 已垫 1 张参考")).toBeInTheDocument();
  expect(await screen.findByRole("option",{name:`${model} · 来源A`})).toBeInTheDocument();
});
