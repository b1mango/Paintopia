import { useState, type ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, type ModuleId } from "../src/app/AppShell";
import { apiClient, type GenerationResponse } from "../src/lib/apiClient";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).startsWith("/api/assets?scope=mine&")) return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 20 }), { status: 200 });
    throw new Error("Unexpected unmocked request: " + String(input));
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  vi.spyOn(apiClient, "listImageCapabilities").mockResolvedValue({ models: [{ model: "gpt-image-2", resolutions: ["1K", "2K", "4K"] }] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function NavigableShell({ activeModule: initial = "config-image", ...props }: ComponentProps<typeof AppShell>) {
  const [activeModule, setActiveModule] = useState<ModuleId>(initial);
  return <AppShell {...props} activeModule={activeModule} onNavigate={setActiveModule} />;
}

function savedImageProviderFixtures() {
  return [
    {
      id: "gateway-gpt-image-2",
      kind: "image" as const,
      name: "Jiuuij GPT Image 2",
      baseUrl: "https://text-gateway.example",
      apiKey: "********",
      model: "gpt-image-2",
      mode: "generations",
      maxConcurrency: 1,
      enabled: true
    },
    {
      id: "gateway-gpt-image-2-edits",
      kind: "image" as const,
      name: "Jiuuij GPT Image 2 图像编辑",
      baseUrl: "https://text-gateway.example",
      apiKey: "********",
      model: "gpt-image-2",
      mode: "edits",
      maxConcurrency: 1,
      enabled: true
    }
  ];
}

describe("AppShell", () => {
  it("renders primary navigation entries", () => {
    render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} />);

    const nav = screen.getByRole("navigation", { name: "主导航" });
    for (const label of ["创作", "灵感", "画廊", "我的"]) {
      expect(within(nav).getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText("PAINTOPIA")).toBeInTheDocument();
    expect(screen.getByTitle("剩余额度")).toHaveTextContent("余 100");
  });

  it("renders the create desk with the history scroll, stage and composer", () => {
    render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} />);

    const promptInput = screen.getByLabelText("提示词");
    expect(promptInput.closest("[class*='composer']")).toBeInTheDocument();
    expect(promptInput.closest("[class*='desk']")).toContainElement(screen.getByRole("complementary", { name: "创作卷轴" }));
    const status = within(screen.getByRole("region", { name: "生成预览" })).getByRole("status", { hidden: true });
    expect(status).toHaveClass("sr-only");
    expect(screen.getByRole("heading", { name: "落笔成境" })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "模型" })).toBeInTheDocument();
  });

  it("shows estimated quota cost for the selected quality and image count", async () => {
    vi.spyOn(apiClient, "listQuotaPricing").mockResolvedValue([
      { key: "resolution.1k.quality.low", label: "1K / low", amount: 1 },
      { key: "resolution.1k.quality.medium", label: "1K / medium", amount: 2 },
      { key: "resolution.1k.quality.high", label: "1K / high", amount: 3 },
      { key: "resolution.2k.quality.low", label: "2K / low", amount: 2 },
      { key: "resolution.2k.quality.medium", label: "2K / medium", amount: 4 },
      { key: "resolution.2k.quality.high", label: "2K / high", amount: 6 },
      { key: "resolution.4k.quality.low", label: "4K / low", amount: 4 },
      { key: "resolution.4k.quality.medium", label: "4K / medium", amount: 8 },
      { key: "resolution.4k.quality.high", label: "4K / high", amount: 12 }
    ]);

    render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} />);

    fireEvent.click(screen.getByRole("button", { name: "高" }));
    expect(await screen.findByText("预计消耗本站额度：12")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1K" }));
    expect(screen.getByText("预计消耗本站额度：3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "4K" }));
    expect(screen.getByText("预计消耗本站额度：12")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "4 张" }));
    expect(screen.getByText("预计消耗本站额度：48")).toBeInTheDocument();
  });

  it("shows the remaining quota returned by a successful generation", async () => {
    vi.spyOn(apiClient, "listQuotaPricing").mockResolvedValue([
      { key: "quality.low", label: "low", amount: 1 },
      { key: "quality.medium", label: "medium", amount: 2 },
      { key: "quality.high", label: "high", amount: 3 }
    ]);
    vi.spyOn(apiClient, "generateStream").mockResolvedValue({
      jobId: "job-quota",
      quotaCost: 3,
      remainingQuota: 97,
      assets: [{
        id: "asset-quota",
        imageUrl: "/api/assets/asset-quota/original",
        prompt: "quota prompt",
        createdAt: new Date().toISOString()
      }]
    });
    vi.spyOn(apiClient, "getGenerationStats").mockResolvedValue({
      total: 1,
      completed: 1,
      succeeded: 1,
      failed: 0,
      running: 0,
      queued: 0,
      successRate: 100,
      averageDurationMs: 1000
    });

    const user = { email: "artist@paintopia.local", role: "user" as const, quota: 100 };
    const { rerender } = render(<AppShell user={user} activeModule="create" />);

    await waitFor(() => expect(screen.getByTestId("start-generation-button")).toBeEnabled());
    fireEvent.click(screen.getByTestId("start-generation-button"));
    await waitFor(() => expect(apiClient.generateStream).toHaveBeenCalled());

    rerender(<AppShell user={user} activeModule="profile" />);
    const remainingQuota = await screen.findByText("剩余额度");
    expect(remainingQuota.parentElement).toHaveTextContent("97");
  });

  it("shows a streamed partial image before the final asset is ready", async () => {
    let resolveGeneration!: (value: GenerationResponse) => void;
    const completion = new Promise<GenerationResponse>((resolve) => {
      resolveGeneration = resolve;
    });
    vi.spyOn(apiClient, "generateStream").mockImplementation(async (_input, onPreview) => {
      onPreview({
        imageUrl: "data:image/png;base64,cHJldmlldw==",
        partialImageIndex: 0
      });
      return completion;
    });

    render(<AppShell user={{ email: "artist@paintopia.local", role: "user", quota: 100 }} />);
    await waitFor(() => expect(screen.getByTestId("start-generation-button")).toBeEnabled());
    fireEvent.click(screen.getByTestId("start-generation-button"));

    expect(await screen.findByAltText("生成中的快速预览")).toHaveAttribute(
      "src",
      "data:image/png;base64,cHJldmlldw=="
    );
    expect(screen.getByRole("status")).toHaveTextContent("已收到过程预览");

    await act(async () => {
      resolveGeneration({
        jobId: "job-final",
        remainingQuota: 99,
        assets: [{
          id: "asset-final",
          imageUrl: "/api/assets/asset-final/original",
          prompt: "final prompt",
          createdAt: "2026-08-03T00:00:00.000Z"
        }]
      });
      await completion;
    });

    expect(await screen.findByAltText("生成结果")).toHaveAttribute("src", "/api/assets/asset-final/thumbnail");
    expect(screen.getByRole("link", { name: "下载创作图片" })).toHaveAttribute(
      "href",
      "/api/assets/asset-final/download"
    );
    expect(screen.queryByAltText("生成中的快速预览")).not.toBeInTheDocument();
  });

  it("offers upload and asset-picker reference actions from one menu", () => {
    render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} />);

    const trigger = screen.getByRole("button", { name: "添加参考图" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("group", { name: "添加参考图" });
    expect(menu).toContainElement(screen.getByTestId("image-edit-upload"));
    expect(menu).toContainElement(screen.getByTestId("open-reference-asset-picker"));
  });

  it("limits references, shows uploaded thumbnails and switches to image edit automatically", () => {
    const createObjectURL = vi.fn(() => "blob:reference-preview");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} />);

    const uploadInput = screen.getByTestId("image-edit-upload") as HTMLInputElement;
    const files = Array.from({ length: 17 }, (_value, index) => (
      new File([new Uint8Array([index + 1])], "reference-" + (index + 1) + ".png", { type: "image/png" })
    ));

    fireEvent.change(uploadInput, { target: { files } });

    expect(createObjectURL).toHaveBeenCalledTimes(16);
    expect(screen.getByAltText("reference-1.png")).toHaveAttribute("src", "blob:reference-preview");
    expect(screen.getByAltText("reference-16.png")).toBeInTheDocument();
    expect(screen.queryByAltText("reference-17.png")).not.toBeInTheDocument();
    expect(screen.getByText("参考图最多 16 张")).toBeInTheDocument();
    expect(screen.getByText("图生图 · 已垫 16 张参考")).toBeInTheDocument();
    expect(uploadInput).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "移除 reference-1.png" }));
    expect(screen.queryByAltText("reference-1.png")).not.toBeInTheDocument();
    expect(uploadInput).toBeEnabled();
  });

  it("shows recovered image-edit assets as a completed generation", async () => {
    let resolveRecoveredEdit!: (value: GenerationResponse) => void;
    const recoveredEdit = new Promise<GenerationResponse>((resolve) => {
      resolveRecoveredEdit = resolve;
    });
    vi.spyOn(apiClient, "listAssets").mockResolvedValue([{
      id: "source-asset",
      imageUrl: "/api/assets/source-asset/original",
      prompt: "source portrait",
      createdAt: "2026-08-28T12:00:00.000Z"
    }]);
    vi.spyOn(apiClient, "generateEdit").mockImplementation(async (_input, onRecovering) => {
      onRecovering?.();
      return recoveredEdit;
    });

    render(<AppShell user={{ email: "artist@paintopia.local", role: "user", quota: 100 }} />);
    fireEvent.click(screen.getByTestId("open-reference-asset-picker"));
    fireEvent.click(await screen.findByTestId("select-reference-asset-source-asset"));
    fireEvent.click(screen.getByTestId("confirm-reference-assets"));
    await waitFor(() => expect(screen.getByTestId("start-generation-button")).toBeEnabled());
    fireEvent.click(screen.getByTestId("start-generation-button"));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("连接已中断，正在检查生成结果"));
    await act(async () => {
      resolveRecoveredEdit({
        recovered: true,
        remainingQuota: 97,
        assets: [{
          id: "recovered-edit",
          imageUrl: "/api/assets/recovered-edit/original",
          prompt: "recover this edit",
          createdAt: "2026-08-28T12:28:39.793Z"
        }]
      });
      await recoveredEdit;
    });

    expect(await screen.findByAltText("生成结果")).toHaveAttribute(
      "src",
      "/api/assets/recovered-edit/thumbnail"
    );
    expect(screen.getByRole("status")).toHaveTextContent("生成完成");
    expect(screen.getByRole("status")).not.toHaveTextContent("Failed to fetch");
    expect(apiClient.generateEdit).toHaveBeenCalledWith(expect.objectContaining({
      assetIds: ["source-asset"]
    }), expect.any(Function));
  });

  it("renders profile and settings, then statistics and administration through config", async () => {
    vi.spyOn(apiClient, "getGenerationStats").mockResolvedValue({
      total: 8,
      completed: 8,
      succeeded: 6,
      failed: 2,
      running: 0,
      queued: 0,
      successRate: 75,
      averageDurationMs: 2400
    });
    vi.spyOn(apiClient, "getAdminGenerationStats").mockResolvedValue({
      total: 12,
      completed: 12,
      succeeded: 9,
      failed: 3,
      running: 0,
      queued: 0,
      successRate: 75,
      averageDurationMs: 3100,
      textStats: {
        totalRuns: 2,
        succeeded: 2,
        failed: 0,
        successRate: 100,
        promptTokens: 11,
        completionTokens: 22,
        totalTokens: 33,
        averageDurationMs: 1200,
        byProvider: [{ providerId: "p1", providerName: "Provider 1", totalRuns: 2, succeeded: 2, failed: 0, successRate: 100, promptTokens: 11, completionTokens: 22, totalTokens: 33, averageDurationMs: 1200 }],
        byType: []
      },
      userStats: { total: 3, active: 2, disabled: 1, admins: 1, regularUsers: 2 }
    });

    const { rerender } = render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="profile" onLogout={vi.fn()} />);
    const accountHeading = await screen.findByRole("heading", { name: "个人资料" });
    expect(accountHeading).toBeInTheDocument();
    expect(accountHeading.closest("[class*='panel']")).toBeInTheDocument();
    const accountPanel = accountHeading.closest("[class*='panel']") as HTMLElement;
    expect(within(accountPanel).getByText("admin@paintopia.local")).toBeInTheDocument();
    expect(within(accountPanel).getByRole("button", { name: "退出登录" })).toBeInTheDocument();

    rerender(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="settings" />);
    expect(screen.getByLabelText("主题").closest("[class*='settingsList']")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "界面设置" }).closest("[class*='panel']")).toBeInTheDocument();

    rerender(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config" />);
    const history = screen.getByRole("region", { name: "生图调用记录" });
    await waitFor(() => expect(within(history).getByText("总任务").parentElement).toHaveTextContent("12"));
    expect(within(history).getByText("成功 / 失败").parentElement).toHaveTextContent("9 / 3");
    const providerStats = await screen.findByTestId("text-provider-stat-p1");
    expect(within(providerStats).getByText("Provider 1")).toBeInTheDocument();
    expect(within(providerStats).getByText("33")).toBeInTheDocument();
    expect(screen.getByTestId("text-total-tokens")).toHaveTextContent("33");
    expect(screen.getByTestId("user-total-count")).toHaveTextContent("3");
    expect(screen.getByText("已封禁").closest("tr")).toHaveTextContent("1");
    expect(screen.queryByText("管理员 / 普通用户")).not.toBeInTheDocument();
    expect(screen.queryByText("启用 / 停用")).not.toBeInTheDocument();

    rerender(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);
    expect(screen.getByRole("button", { name: "生图配置" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("image-provider-rail")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("starts text provider settings from saved data instead of fixed presets", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue([]);

    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);

    fireEvent.click(screen.getByRole("button", { name: "优化配置" }));

    expect(screen.getByTestId("text-provider-rail")).toBeInTheDocument();
    expect(screen.getByText("接口列表")).toBeInTheDocument();
    await waitFor(() => expect(apiClient.listProviders).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "GPT-5 Nano" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "LinuxDo Translation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anthropic Messages" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Qwen3-8B" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("新增优化接口"));
    const form = screen.getByTestId("text-provider-form");
    expect(within(form).getByLabelText("名称")).toHaveValue("");
    const modelSelect = within(form).getByLabelText("模型") as HTMLSelectElement;
    expect(modelSelect.value).toBe("");
    expect(Array.from(modelSelect.selectedOptions).filter(option => option.value)).toHaveLength(0);
    expect(new FormData(form as HTMLFormElement).getAll("model").filter(Boolean)).toEqual([]);
    expect(within(form).queryByRole("button", { name: "删除接口" })).not.toBeInTheDocument();
  });

  it("does not select or submit a discovered text model until explicitly chosen", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue([]);
    vi.spyOn(apiClient, "listProviderModels").mockResolvedValue({ models: ["candidate-a", "candidate-b"] });
    const create = vi.spyOn(apiClient, "createProvider");
    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);
    fireEvent.click(screen.getByRole("button", { name: "优化配置" }));
    await waitFor(() => expect(screen.queryByTestId("text-provider-loading")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "新增优化接口" }));
    const form = screen.getByTestId("text-provider-form") as HTMLFormElement;
    fireEvent.change(within(form).getByLabelText("Base URL"), { target: { value: "https://text.example.test" } });
    fireEvent.change(within(form).getByLabelText("API Key"), { target: { value: "test-key" } });
    fireEvent.click(within(form).getByRole("button", { name: "获取模型" }));
    await within(form).findByRole("option", { name: "candidate-a" });
    expect(create).not.toHaveBeenCalled();
    expect(new FormData(form).getAll("model").filter(Boolean)).toEqual([]);
    fireEvent.change(within(form).getByLabelText("模型"), { target: { value: "candidate-b" } });
    expect(new FormData(form).getAll("model")).toEqual(["candidate-b"]);
    expect(create).not.toHaveBeenCalled();
  });

  it("shows saved text providers automatically after the initial load completes", async () => {
    let resolveProviders: (providers: Awaited<ReturnType<typeof apiClient.listProviders>>) => void = () => undefined;
    vi.spyOn(apiClient, "listProviders").mockImplementation(() => new Promise((resolve) => {
      resolveProviders = resolve;
    }));

    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);
    fireEvent.click(screen.getByRole("button", { name: "优化配置" }));

    expect(screen.getByTestId("text-provider-loading")).toBeInTheDocument();

    resolveProviders([
      {
        id: "saved-text-a",
        kind: "text",
        name: "Joverna",
        baseUrl: "https://saved-a.example",
        apiKey: "********",
        model: "gpt-5-nano",
        mode: "chat_completions"
      },
      {
        id: "saved-text-b",
        kind: "text",
        name: "6655翻译小站",
        baseUrl: "https://saved-b.example",
        apiKey: "********",
        model: "glm-4.5-flash",
        mode: "chat_completions"
      }
    ]);

    expect(await screen.findByRole("button", { name: "Joverna" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "6655翻译小站" })).toBeInTheDocument();
  });

  it("shows preloaded text providers immediately when switching to text settings", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue([
      {
        id: "preloaded-text-a",
        kind: "text",
        name: "Preloaded Text A",
        baseUrl: "https://preloaded-a.example",
        apiKey: "********",
        model: "preloaded-a",
        mode: "chat_completions"
      },
      {
        id: "preloaded-image-a",
        kind: "image",
        name: "Preloaded Image A",
        baseUrl: "https://preloaded-image.example",
        apiKey: "********",
        model: "gpt-image-2",
        mode: "generations"
      }
    ]);

    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);
    await waitFor(() => expect(apiClient.listProviders).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "优化配置" }));

    expect(screen.queryByTestId("text-provider-loading")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preloaded Text A" })).toBeInTheDocument();
    await waitFor(() => expect(apiClient.listProviders).toHaveBeenCalledTimes(2));
  });

  it("loads saved text providers and tests them by saved provider id", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue([
      {
        id: "saved-text-a",
        kind: "text",
        name: "已保存接口 A",
        baseUrl: "https://saved-a.example",
        apiKey: "********",
        model: "saved-a",
        mode: "chat_completions"
      },
      {
        id: "saved-text-b",
        kind: "text",
        name: "已保存接口 B",
        baseUrl: "https://saved-b.example",
        apiKey: "********",
        model: "saved-b",
        mode: "chat_completions"
      }
    ]);
    vi.spyOn(apiClient, "testProvider").mockResolvedValue({
      ok: true,
      status: "connected",
      latencyMs: 45,
      totalTokens: 2,
      message: "OK"
    });

    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);

    fireEvent.click(screen.getByRole("button", { name: "优化配置" }));

    expect(await screen.findByRole("button", { name: "已保存接口 A" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "已保存接口 B" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "GPT-5 Nano" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "LinuxDo Translation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anthropic Messages" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Qwen3-8B" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("text-provider-test-button"));

    await waitFor(() => expect(apiClient.testProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "saved-text-a",
      apiKey: ""
    })));
    expect(apiClient.testProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "saved-text-b",
      apiKey: ""
    }));
  });

  it("reorders text provider tags by dragging them in the interface list", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue([
      {
        id: "saved-text-a",
        kind: "text",
        name: "Saved Text A",
        baseUrl: "https://saved-a.example",
        apiKey: "********",
        model: "saved-a",
        mode: "chat_completions"
      },
      {
        id: "saved-text-b",
        kind: "text",
        name: "Saved Text B",
        baseUrl: "https://saved-b.example",
        apiKey: "********",
        model: "saved-b",
        mode: "chat_completions"
      }
    ]);
    vi.spyOn(apiClient, "reorderProviders").mockResolvedValue([]);

    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);

    fireEvent.click(screen.getByRole("button", { name: "优化配置" }));

    const first = await screen.findByRole("button", { name: "Saved Text A" });
    const second = await screen.findByRole("button", { name: "Saved Text B" });

    fireEvent.dragStart(second);
    fireEvent.drop(first);

    await waitFor(() => expect(apiClient.reorderProviders).toHaveBeenCalledWith("text", [
      "saved-text-b",
      "saved-text-a"
    ]));

    const rail = screen.getByTestId("text-provider-rail");
    const tags = within(rail).getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label) => label === "Saved Text A" || label === "Saved Text B");
    expect(tags).toEqual(["Saved Text B", "Saved Text A"]);
  });

  it("saves and tests the preferred provider connectivity from admin settings", async () => {
    const client = apiClient as typeof apiClient & {
      createProvider: (input: unknown) => Promise<unknown>;
      listProviderModels: (input: { baseUrl: string; apiKey: string }) => Promise<{ models: string[] }>;
    };
    vi.spyOn(apiClient, "listProviders").mockResolvedValue([]);
    vi.spyOn(client, "createProvider").mockResolvedValue({
      id: "saved-gpt-5-nano",
      kind: "text",
      name: "自定义翻译接口",
      baseUrl: "https://text-gateway.example",
      apiKey: "********",
      model: "gpt-5-mini",
      mode: "chat_completions"
    });
    vi.spyOn(apiClient, "testProvider").mockResolvedValue({
      ok: true,
      status: "connected",
      latencyMs: 123,
      totalTokens: 4,
      message: "OK"
    });
    vi.spyOn(client, "listProviderModels").mockResolvedValue({
      models: ["gpt-5-nano", "gpt-5-mini"]
    });

    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);

    fireEvent.click(screen.getByRole("button", { name: "优化配置" }));
    await waitFor(() => expect(apiClient.listProviders).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "新增优化接口" }));
    const form = screen.getByTestId("text-provider-form");
    const fields = Array.from(form.querySelectorAll("label")).map((label) => label.childNodes[0]?.textContent?.trim());
    expect(fields.slice(0, 5)).toEqual(["名称", "接口模式", "Base URL", "API Key", "模型"]);
    expect(within(form).getByLabelText("接口模式")).toHaveValue("chat_completions");
    const apiKeyInput = form.querySelector<HTMLInputElement>('input[name="apiKey"]');
    expect(apiKeyInput).not.toBeNull();
    fireEvent.change(within(form).getByLabelText("名称"), { target: { value: "自定义翻译接口" } });
    fireEvent.change(within(form).getByLabelText("Base URL"), { target: { value: "https://text-gateway.example" } });
    fireEvent.change(apiKeyInput!, { target: { value: "test-key" } });
    fireEvent.click(within(form).getByRole("button", { name: "获取模型" }));
    expect(client.listProviderModels).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://text-gateway.example",
      apiKey: "test-key"
    }));
    expect(await screen.findByRole("option", { name: "gpt-5-mini" })).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("模型"), { target: { value: "gpt-5-mini" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(client.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      kind: "text",
      name: "自定义翻译接口",
      apiKey: "test-key",
      enabled: true,
      model: "gpt-5-mini"
    })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("配置已保存");
    expect(screen.getByRole("button", { name: "自定义翻译接口" })).toHaveAttribute("data-active", "true");

    fireEvent.click(screen.getByTestId("text-provider-test-button"));

    expect(apiClient.testProvider).toHaveBeenCalledWith(expect.objectContaining({
      kind: "text",
      name: "自定义翻译接口",
      baseUrl: "https://text-gateway.example",
      model: "gpt-5-mini",
      mode: "chat_completions"
    }));
    await waitFor(() => expect(apiClient.testProvider).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText(/123 ms/)).length).toBeGreaterThan(0);
  });

  it("keeps text provider connection-test status out of the parameter form", async () => {
    let resolveTest: (value: Awaited<ReturnType<typeof apiClient.testProvider>>) => void = () => undefined;
    vi.spyOn(apiClient, "listProviders").mockResolvedValue([
      {
        id: "saved-text-status",
        kind: "text",
        name: "Status Text Provider",
        baseUrl: "https://status.example",
        apiKey: "********",
        model: "status-model",
        mode: "chat_completions"
      }
    ]);
    vi.spyOn(apiClient, "testProvider").mockImplementation(() => new Promise((resolve) => {
      resolveTest = resolve;
    }));

    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);

    fireEvent.click(screen.getByRole("button", { name: "优化配置" }));
    fireEvent.click(await screen.findByRole("button", { name: "Status Text Provider" }));
    const form = screen.getByTestId("text-provider-form");

    fireEvent.click(screen.getByTestId("text-provider-test-button"));

    expect(within(form).queryByText(/正在测试/)).not.toBeInTheDocument();
    expect(screen.getByTestId("text-provider-test-status")).toHaveTextContent("正在测试 1 个接口...");

    resolveTest({
      ok: true,
      status: "connected",
      latencyMs: 123,
      totalTokens: 4,
      message: "OK"
    });

    await waitFor(() => expect(screen.getByTestId("text-provider-test-status")).toHaveTextContent("测试完成"));
    expect(within(form).queryByText("测试完成")).not.toBeInTheDocument();
  });

  it("restores the image provider configuration form in the admin panel", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue(savedImageProviderFixtures());
    vi.spyOn(apiClient, "listProviderQuotas").mockResolvedValue([
      {
        providerId: "gateway-gpt-image-2",
        status: "available",
        remaining: 88,
        used: 12,
        total: 100,
        source: "newapi"
      }
    ]);
    render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);

    fireEvent.click(await screen.findByRole("button", { name: "Jiuuij GPT Image 2" }));
    expect(screen.queryByRole("button", { name: "文生图" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "图生图" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("image-provider-mode-divider")).not.toBeInTheDocument();
    const form = screen.getByTestId("image-provider-form");
    const fields = Array.from(form.querySelectorAll("label")).map((label) => label.childNodes[0]?.textContent?.trim());
    expect(fields.slice(0, 6)).toEqual(["名称", "接口模式", "Base URL", "API Key", "模型名称", "最大并发"]);

    expect(screen.getByRole("button", { name: "Jiuuij GPT Image 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jiuuij GPT Image 2 图像编辑" })).toBeInTheDocument();
    expect(screen.queryByText("令牌剩余 88")).not.toBeInTheDocument();
    expect(within(form).getByLabelText("名称")).toHaveValue("Jiuuij GPT Image 2");
    expect(within(form).getByLabelText("模型名称")).toHaveValue(["gpt-image-2"]);
    expect(within(form).getByRole("button", { name: "获取模型" })).toBeInTheDocument();
    expect(within(form).getByLabelText("Base URL")).toHaveValue("https://text-gateway.example");
    expect(within(form).getByLabelText("接口模式")).toHaveValue("generations");
    expect(within(form).getByLabelText("最大并发")).toHaveValue(1);
    expect(within(form).getByLabelText("启用生图接口")).toBeChecked();
    expect(within(screen.getByTestId("image-provider-rail")).getByRole("button", { name: "测试连接" })).toBeInTheDocument();
    expect(within(form).queryByRole("button", { name: "删除接口" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("新增生图接口"));
    const newForm = screen.getByTestId("image-provider-form");
    expect(within(newForm).getByLabelText("名称")).toHaveValue("");
    expect(within(newForm).getByLabelText("模型名称")).toHaveValue([]);

    for (const mode of ["generations", "edits", "responses", "chat_completions"]) {
      expect(within(newForm).getByRole("option", { name: mode })).toBeInTheDocument();
    }
  });

  it("persists deleting a saved image provider across reloads", async () => {
    const listProviders = vi.spyOn(apiClient, "listProviders").mockResolvedValue(savedImageProviderFixtures());
    const deleteProvider = vi.spyOn(apiClient, "deleteProvider").mockResolvedValue();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    const firstRender = render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);
    const editProvider = await screen.findByRole("button", { name: "Jiuuij GPT Image 2 图像编辑" });
    fireEvent.click(editProvider);
    fireEvent.click(screen.getByRole("button", { name: "删除接口 Jiuuij GPT Image 2 图像编辑" }));
    fireEvent.click(within(screen.getByRole("dialog", {name:"删除接口确认"})).getByRole("button", {name:"取消"}));
    expect(deleteProvider).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "编辑生图渠道" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jiuuij GPT Image 2 图像编辑" })).toBeInTheDocument();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除接口 Jiuuij GPT Image 2 图像编辑" }));
    fireEvent.click(screen.getByRole("button", {name:"确认删除"}));

    await waitFor(() => expect(deleteProvider).toHaveBeenCalledWith("gateway-gpt-image-2-edits"));
    expect(deleteProvider).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑生图渠道" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Jiuuij GPT Image 2 图像编辑" })).not.toBeInTheDocument();

    listProviders.mockResolvedValue([]);
    firstRender.unmount();
    render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);
    await waitFor(() => expect(listProviders).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "新增生图接口" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Jiuuij GPT Image 2 图像编辑" })).not.toBeInTheDocument();
  });

  it("shows saved Chat Completions providers in the unified image interface list", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue([
      {
        id: "chat-image-provider",
        kind: "image",
        name: "Chat Image Provider",
        baseUrl: "https://chat-image.example",
        apiKey: "********",
        model: "gpt-image-2",
        mode: "chat_completions",
        maxConcurrency: 1,
        enabled: true
      }
    ]);

    render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);

    const providerButton = await screen.findByRole("button", { name: "Chat Image Provider" });
    expect(providerButton).toBeInTheDocument();

    fireEvent.click(providerButton);
    expect(screen.getByTestId("image-provider-form")).toHaveFormValues({
      mode: "chat_completions",
      baseUrl: "https://chat-image.example"
    });
  });

  it("keeps image provider connection-test status under the interface list", async () => {
    let resolveTest: (value: Awaited<ReturnType<typeof apiClient.testProvider>>) => void = () => undefined;
    const testPromise = new Promise<Awaited<ReturnType<typeof apiClient.testProvider>>>((resolve) => {
      resolveTest = resolve;
    });
    vi.spyOn(apiClient, "listProviders").mockResolvedValue(savedImageProviderFixtures().slice(0, 1));
    vi.spyOn(apiClient, "testProvider").mockImplementation(() => testPromise);

    render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);

    fireEvent.click(await screen.findByRole("button", { name: "Jiuuij GPT Image 2" }));
    const form = screen.getByTestId("image-provider-form");
    fireEvent.click(within(screen.getByTestId("image-provider-rail")).getByRole("button", { name: "测试连接" }));

    expect(within(form).queryByText(/正在测试/)).not.toBeInTheDocument();
    expect(screen.getByTestId("image-provider-test-status")).toHaveTextContent("正在测试 1 个接口...");

    resolveTest({
      ok: true,
      status: "connected",
      latencyMs: 88,
      message: "OK"
    });

    await waitFor(() => expect(screen.getByTestId("image-provider-test-status")).toHaveTextContent("测试完成"));
    expect(within(form).queryByText("测试完成")).not.toBeInTheDocument();
  });

  it("keeps only one styled select menu open at a time", () => {
    render(<AppShell user={{ email: "artist@paintopia.local", role: "user", quota: 100 }} activeModule="settings" />);

    const themeField = screen.getByLabelText("主题").closest("label")!;
    fireEvent.click(within(themeField).getByRole("button"));
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: "浅色" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "中文" }));
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    expect(within(screen.getByRole("listbox")).queryByRole("option", { name: "浅色" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: "English" })).toBeInTheDocument();
  });

  it("submits selected resolution and quality buttons with concrete dimensions", async () => {
    vi.spyOn(apiClient, "listImageCapabilities").mockResolvedValue({
      models: [{
        model: "gpt-image-2",
        resolutions: ["1K"]
      }]
    });
    vi.spyOn(apiClient, "generateStream").mockResolvedValue({
      jobId: "job-4k",
      assets: [{
        id: "asset-4k",
        imageUrl: "/api/assets/asset-4k/original",
        prompt: "4K prompt",
        createdAt: new Date().toISOString()
      }]
    });

    render(<AppShell user={{ email: "artist@paintopia.local", role: "user", quota: 100 }} activeModule="create" />);
    await waitFor(() => expect(apiClient.listImageCapabilities).toHaveBeenCalled());

    for (const tier of ["1K", "2K", "4K"]) {
      expect(screen.getByRole("button", { name: tier })).toBeInTheDocument();
    }
    expect(screen.queryByRole("combobox", { name: "分辨率" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "质量" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "4K" }));
    fireEvent.click(screen.getByRole("button", { name: "高" }));
    await waitFor(() => expect(screen.getByTestId("start-generation-button")).toBeEnabled());
    fireEvent.click(screen.getByTestId("start-generation-button"));

    await waitFor(() => expect(apiClient.generateStream).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          model: "gpt-image-2",
          resolution: "4K",
          quality: "high",
          n: 1
        })
      }),
      expect.any(Function), expect.any(Function)
    ));
    const [request] = vi.mocked(apiClient.generateStream).mock.calls[0]!;
    expect(request.params.size).toBe(`${(screen.getByLabelText("图片宽度") as HTMLInputElement).value}x${(screen.getByLabelText("图片高度") as HTMLInputElement).value}`);
  });

  it("saves and tests image provider configuration from admin settings", async () => {
    vi.spyOn(apiClient, "listProviders").mockResolvedValue(savedImageProviderFixtures());
    const client = apiClient as typeof apiClient & {
      updateProvider: (providerId: string, input: unknown) => Promise<unknown>;
      listProviderModels: (input: { baseUrl: string; apiKey: string }) => Promise<{ models: string[] }>;
    };
    vi.spyOn(client, "updateProvider").mockResolvedValue({
      id: "gateway-gpt-image-2",
      kind: "image",
      name: "Jiuuij Primary",
      baseUrl: "https://text-gateway.example",
      apiKey: "********",
      model: "gpt-image-2",
      mode: "chat_completions",
      maxConcurrency: 1,
      enabled: true
    });
    vi.spyOn(apiClient, "testProvider").mockResolvedValue({
      ok: true,
      status: "connected",
      latencyMs: 88,
      message: "OK"
    });
    vi.spyOn(client, "listProviderModels").mockResolvedValue({
      models: ["gpt-image-2", "custom-image-model"]
    });

    render(<AppShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);

    fireEvent.click(await screen.findByRole("button", { name: "Jiuuij GPT Image 2" }));
    const form = screen.getByTestId("image-provider-form");
    fireEvent.change(within(form).getByLabelText("名称"), { target: { value: "Jiuuij Primary" } });
    fireEvent.change(within(form).getByLabelText("接口模式"), { target: { value: "chat_completions" } });
    fireEvent.change(within(form).getByLabelText("API Key"), { target: { value: "image-key" } });
    fireEvent.click(within(form).getByRole("button", { name: "获取模型" }));
    expect(client.listProviderModels).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://text-gateway.example",
      apiKey: "image-key",
      providerId: "gateway-gpt-image-2"
    }));
    expect(await screen.findByRole("option", { name: "custom-image-model" })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "gpt-image-2" }));
    const modelListbox = screen.getAllByRole("listbox")
      .find((element) => element.getAttribute("aria-multiselectable") === "true");
    expect(modelListbox).toBeDefined();
    fireEvent.click(within(modelListbox!).getByRole("option", { name: "custom-image-model" }));
    fireEvent.click(within(form).getByRole("button", { name: "保存配置" }));

    expect(client.updateProvider).toHaveBeenCalledWith("gateway-gpt-image-2", expect.objectContaining({
      kind: "image",
      name: "Jiuuij Primary",
      apiKey: "image-key",
      model: "gpt-image-2, custom-image-model",
      mode: "chat_completions"
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("配置已保存");
    expect(screen.getByRole("button", { name: "Jiuuij Primary" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "编辑生图渠道" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Jiuuij Primary" }));
    expect(screen.getByTestId("image-provider-form")).toHaveFormValues({ mode: "chat_completions" });

    fireEvent.click(within(screen.getByTestId("image-provider-rail")).getByRole("button", { name: "测试连接" }));
    expect(apiClient.testProvider).toHaveBeenCalledWith(expect.objectContaining({
      kind: "image",
      name: "Jiuuij Primary",
      baseUrl: "https://text-gateway.example"
    }));
    expect((await screen.findAllByText(/88 ms/)).length).toBeGreaterThan(0);
  });

  it("shows a single optimize template editor with the default first", async () => {
    vi.spyOn(apiClient, "listTemplates").mockResolvedValue([]);
    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-prompt" />);
    expect(screen.queryByRole("region", { name: "翻译模板" })).not.toBeInTheDocument();
    const optimization = screen.getByRole("region", { name: /优化模板/ });
    expect(within(optimization).getByLabelText("模板名称")).toHaveValue("通用优化");
    expect(within(optimization).getByRole("button", { name: "当前默认" })).toBeDisabled();
    await waitFor(() => expect(within(optimization).getByLabelText("新增优化模板")).toBeEnabled());
    fireEvent.click(within(optimization).getByLabelText("新增优化模板"));
    expect(within(optimization).getByLabelText("模板名称")).toHaveValue("");
    expect(within(optimization).getByRole("button", { name: "设为默认" })).toBeDisabled();
  });

  it("loads, persists and switches the default optimize template", async () => {
    const saved = [
      { id: "optimize", name: "通用优化", type: "optimize" as const, targetModel: "general", content: "saved optimizer", isDefault: true },
      { id: "custom", name: "电影感", type: "optimize" as const, targetModel: "general", content: "cinematic rules", isDefault: false }
    ];
    vi.spyOn(apiClient, "listTemplates").mockResolvedValue(saved);
    const updateTemplate = vi.spyOn(apiClient, "updateTemplate").mockResolvedValue({ ...saved[0]!, content: "updated optimizer" });
    const setDefault = vi.spyOn(apiClient, "setDefaultTemplate").mockResolvedValue([
      { ...saved[1]!, isDefault: true }, { ...saved[0]!, content: "updated optimizer", isDefault: false }
    ]);

    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);
    fireEvent.click(screen.getByRole("button", { name: "提示词配置" }));

    expect(await screen.findByDisplayValue("saved optimizer")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("模板内容"), { target: { value: "updated optimizer" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
    await waitFor(() => expect(updateTemplate).toHaveBeenCalledWith("optimize", {
      name: "通用优化", type: "optimize", targetModel: "general", content: "updated optimizer"
    }));

    fireEvent.click(screen.getByRole("button", { name: /电影感/ }));
    expect(await screen.findByDisplayValue("cinematic rules")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledWith("custom"));
    expect(await screen.findByRole("button", { name: "当前默认" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除模板" })).toBeDisabled();
  });

  it("edits quota pricing rules from the admin panel", async () => {
    const client = apiClient as typeof apiClient & {
      listQuotaPricing: () => Promise<Array<{ key: string; label: string; amount: number }>>;
      updateQuotaPricing: (rules: Array<{ key: string; amount: number }>) => Promise<Array<{ key: string; label: string; amount: number }>>;
    };
    vi.spyOn(client, "listQuotaPricing").mockResolvedValue([
      { key: "resolution.1k.quality.low", label: "1K / low", amount: 1 },
      { key: "resolution.1k.quality.medium", label: "1K / medium", amount: 2 },
      { key: "resolution.1k.quality.high", label: "1K / high", amount: 3 },
      { key: "resolution.2k.quality.low", label: "2K / low", amount: 2 },
      { key: "resolution.2k.quality.medium", label: "2K / medium", amount: 4 },
      { key: "resolution.2k.quality.high", label: "2K / high", amount: 6 },
      { key: "resolution.4k.quality.low", label: "4K / low", amount: 4 },
      { key: "resolution.4k.quality.medium", label: "4K / medium", amount: 8 },
      { key: "resolution.4k.quality.high", label: "4K / high", amount: 12 }
    ]);
    vi.spyOn(client, "updateQuotaPricing").mockResolvedValue([
      { key: "resolution.1k.quality.low", label: "1K / low", amount: 1 },
      { key: "resolution.1k.quality.medium", label: "1K / medium", amount: 2 },
      { key: "resolution.1k.quality.high", label: "1K / high", amount: 3 },
      { key: "resolution.2k.quality.low", label: "2K / low", amount: 2 },
      { key: "resolution.2k.quality.medium", label: "2K / medium", amount: 4 },
      { key: "resolution.2k.quality.high", label: "2K / high", amount: 6 },
      { key: "resolution.4k.quality.low", label: "4K / low", amount: 4 },
      { key: "resolution.4k.quality.medium", label: "4K / medium", amount: 8 },
      { key: "resolution.4k.quality.high", label: "4K / high", amount: 11 }
    ]);

    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);
    fireEvent.click(screen.getByRole("button", { name: "定价额度" }));

    expect(await screen.findByText("4K / high")).toBeInTheDocument();
    const input = screen.getByLabelText("4K / high 每张图额度");
    fireEvent.change(input, { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "保存额度配置" }));

    expect(client.updateQuotaPricing).toHaveBeenCalledWith([
      { key: "resolution.1k.quality.low", amount: 1 },
      { key: "resolution.1k.quality.medium", amount: 2 },
      { key: "resolution.1k.quality.high", amount: 3 },
      { key: "resolution.2k.quality.low", amount: 2 },
      { key: "resolution.2k.quality.medium", amount: 4 },
      { key: "resolution.2k.quality.high", amount: 6 },
      { key: "resolution.4k.quality.low", amount: 4 },
      { key: "resolution.4k.quality.medium", amount: 8 },
      { key: "resolution.4k.quality.high", amount: 11 }
    ]);
    expect(await screen.findByText("额度配置已保存")).toBeInTheDocument();
  });

  it("renders user management with editable quota and no quota advice block", async () => {
    vi.spyOn(apiClient, "listUsers").mockResolvedValue([
      {
        id: "user-1",
        email: "user@paintopia.local",
        role: "user",
        status: "active",
        quota: 88,
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z"
      }
    ]);
    vi.spyOn(apiClient, "listInviteCodes").mockResolvedValue([]);
    vi.spyOn(apiClient, "updateUserQuota").mockResolvedValue({
      id: "user-1",
      email: "user@paintopia.local",
      role: "user",
      status: "active",
      quota: 120,
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z"
    });

    render(<NavigableShell user={{ email: "admin@paintopia.local", role: "admin", quota: 100 }} activeModule="config-image" />);
    fireEvent.click(screen.getByRole("button", { name: "用户管理" }));

    expect(await screen.findByText("user@paintopia.local")).toBeInTheDocument();
    expect(screen.queryByText("生成额度建议")).not.toBeInTheDocument();
    expect(screen.getByText("用户名称")).toBeInTheDocument();
    expect(screen.getByText("额度")).toBeInTheDocument();
    expect(screen.queryByText("更新")).not.toBeInTheDocument();

    const row = screen.getByText("user@paintopia.local").closest("[class*='userTableRow']");
    expect(row).toBeInTheDocument();
    const quotaInput = within(row as HTMLElement).getByLabelText("修改 user@paintopia.local 额度");
    expect(quotaInput).toHaveValue(88);
    expect(screen.getByText("注册日期")).toBeInTheDocument();
    expect((row as HTMLElement).querySelector("time")).toHaveAttribute("datetime", "2026-06-10T00:00:00.000Z");
    expect((row as HTMLElement).querySelector("time")?.textContent).toMatch(/^2026-06-(09|10)$/);
    fireEvent.change(quotaInput, { target: { value: "120" } });
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "保存" }));

    expect(apiClient.updateUserQuota).toHaveBeenCalledWith("user-1", 120);
    expect(await screen.findByText("额度已保存")).toBeInTheDocument();
  });
});
