import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptLibraryResponse, PromptSource, SourcedPrompt } from "@paintopia/shared";
import { servePromptLibrary } from "../../../tests/servePromptLibrary";
import { PromptLibraryView } from "./PromptLibraryView";
import { promptLibraryApi } from "./promptLibraryApi";

const fixture: SourcedPrompt = { id: "image-2-5:test", sourceId: "image-2-5", title: "测试作品", text: "测试提示词全文", description: "测试描述", tags: ["摄影"], author: "测试作者", sourceUrl: "https://x.com/example/status/1", model: "gpt-image-2.5", favorite: false };
const testSource: PromptSource = { id: fixture.sourceId, name: "测试来源", homepage: "https://github.com/example/prompts", feedUrl: "https://example.com", license: "CC BY 4.0", licenseUrl: "https://example.com/LICENSE", aggregatorUrl: "https://example.com", aggregatorLicenseUrl: "https://example.com/LICENSE", model: "gpt-image-2.5", compatibilityNote: "2.5 尚未验证" };
const serve = (items: SourcedPrompt[] = [fixture], sources: PromptSource[] = [testSource], extra: Partial<PromptLibraryResponse> = {}) =>
  vi.mocked(promptLibraryApi.list).mockImplementation(servePromptLibrary(items, sources, extra));
/** 首次请求先看站主推荐；为空时组件会改看 2.5，这一次探测请求要先消耗掉。 */
const probe = servePromptLibrary([], [testSource]);
const page = (extra: Partial<PromptLibraryResponse> = {}) => servePromptLibrary([fixture], [testSource], extra)({ source: "image-2-5", q: "", tag: "", favorites: false });

beforeEach(() => {
  vi.spyOn(promptLibraryApi, "list");
  serve();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => vi.restoreAllMocks());

describe("sourced prompt library", () => {
  it("shows a genuine empty response without fallback content", async () => {
    serve([]);
    render(<PromptLibraryView />);
    expect(await screen.findByText("没有符合条件的作品")).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
  it("shows source failure and retry recovers", async () => {
    vi.mocked(promptLibraryApi.list).mockRejectedValueOnce(new Error("来源不可用"));
    render(<PromptLibraryView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("来源不可用");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText(fixture.title)).toBeInTheDocument();
    expect(promptLibraryApi.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ source: "paintopia-curated" }), { signal: expect.any(AbortSignal), refresh: true });
    expect(promptLibraryApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ source: "image-2-5" }), { signal: expect.any(AbortSignal), refresh: true });
  });
  it("renders expired snapshots without a failure warning while a real refresh is pending", async () => {
    let complete!: (value: PromptLibraryResponse) => void;
    vi.mocked(promptLibraryApi.list)
      .mockImplementationOnce(probe)
      .mockImplementationOnce(async () => page({ refreshNeeded: true }))
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render(<PromptLibraryView />);
    expect(await screen.findByText(fixture.title)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(promptLibraryApi.list).toHaveBeenNthCalledWith(2, expect.anything(), { signal: expect.any(AbortSignal), refresh: false });
    expect(promptLibraryApi.list).toHaveBeenNthCalledWith(3, expect.anything(), { signal: expect.any(AbortSignal), refresh: true });
    vi.spyOn(promptLibraryApi, "setFavorite").mockResolvedValue({ id: fixture.id, favorite: true });
    fireEvent.click(screen.getByRole("button", { name: "收藏 " + fixture.title }));
    await screen.findByRole("button", { name: "取消收藏 " + fixture.title });
    const refreshed = await page();
    await act(async () => complete({ ...refreshed, items: [{ ...fixture, title: "刷新后的作品" }] }));
    expect(screen.getByText("刷新后的作品")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消收藏 刷新后的作品" })).toHaveAttribute("aria-pressed", "true");
    expect(promptLibraryApi.list).toHaveBeenCalledTimes(3);
  });
  it("retains the visible snapshot when background refresh fails", async () => {
    vi.mocked(promptLibraryApi.list).mockImplementationOnce(probe).mockImplementationOnce(async () => page({ refreshNeeded: true })).mockRejectedValueOnce(new Error("网络错误"));
    render(<PromptLibraryView />);
    expect(await screen.findByText(/来源更新未完成/)).toBeInTheDocument();
    expect(screen.getByText(fixture.title)).toBeInTheDocument();
    expect(screen.queryByText("暂时没能打开提示词库")).not.toBeInTheDocument();
  });
  it("sends search, tag, source and favorites filters to the server", async () => {
    render(<PromptLibraryView />);
    await screen.findByText(fixture.title);
    fireEvent.change(screen.getByLabelText("搜索提示词"), { target: { value: "不存在" } });
    expect(await screen.findByText("没有符合条件的作品")).toBeInTheDocument();
    expect(promptLibraryApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "不存在" }), expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    fireEvent.click(within(await screen.findByRole("group", { name: "筛选标签" })).getByRole("button", { name: "摄影" }));
    expect(await screen.findByRole("article")).toBeInTheDocument();
    expect(promptLibraryApi.list).toHaveBeenLastCalledWith({ source: "image-2-5", q: "", tag: "摄影", favorites: false }, expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "只看收藏" }));
    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
    expect(promptLibraryApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ tag: "摄影", favorites: true }), expect.anything());
  });
  it("waits for server favorite write, preserves old state on failure", async () => {
    const save = vi.spyOn(promptLibraryApi, "setFavorite").mockRejectedValueOnce(new Error("收藏保存失败，请重试"));
    render(<PromptLibraryView />);
    fireEvent.click(await screen.findByRole("button", { name: "收藏 " + fixture.title }));
    expect(await screen.findByText("收藏保存失败，请重试")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收藏 " + fixture.title })).toHaveAttribute("aria-pressed", "false");
    save.mockResolvedValue({ id: fixture.id, favorite: true });
    fireEvent.click(screen.getByRole("button", { name: "收藏 " + fixture.title }));
    expect(await screen.findByRole("button", { name: "取消收藏 " + fixture.title })).toHaveAttribute("aria-pressed", "true");
    expect(save).toHaveBeenLastCalledWith(fixture.id, true);
  });
  it("opens native dialog with attribution, copies and uses exact text", async () => {
    const onUsePrompt = vi.fn(); const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<PromptLibraryView onUsePrompt={onUsePrompt} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看详情 " + fixture.title }));
    const modal = screen.getByRole("dialog");
    expect(modal.tagName).toBe("DIALOG");
    expect(within(modal).getByLabelText("完整提示词")).toHaveValue(fixture.text);
    expect(within(modal).getByRole("link", { name: /查看原作/ })).toHaveAttribute("href", fixture.sourceUrl);
    fireEvent.click(within(modal).getByRole("button", { name: "复制提示词" }));
    await waitFor(() => expect(within(modal).getByRole("status")).toHaveTextContent("提示词已复制"));
    expect(writeText).toHaveBeenCalledWith(fixture.text);
    fireEvent.click(within(modal).getByRole("button", { name: /选用提示词/ }));
    expect(onUsePrompt).toHaveBeenCalledWith(fixture.text);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("clipboard failure is visible in dialog", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(<PromptLibraryView />);
    fireEvent.click(await screen.findByRole("button", { name: "查看详情 " + fixture.title }));
    const modal = screen.getByRole("dialog");
    fireEvent.click(within(modal).getByRole("button", { name: "复制提示词" }));
    expect(within(modal).getByRole("status")).toHaveTextContent("手动选择文本复制");
    expect(within(modal).getByRole("button", { name: /选用提示词/ })).toBeDisabled();
    fireEvent.click(within(modal).getByRole("button", { name: "关闭详情" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("partial source failures", () => {
  const oldSource = { ...testSource, id: "youmind-gpt-image-2", name: "旧模型来源" };
  it("shows partial warning while healthy source remains searchable and favoritable; retry clears warning", async () => {
    const failing = servePromptLibrary([fixture], [testSource, oldSource], { sourceErrors: [{ sourceId: oldSource.id, message: "来源暂不可用，请稍后重试" }] });
    const healthy = servePromptLibrary([fixture], [testSource, oldSource]);
    vi.mocked(promptLibraryApi.list).mockImplementation((query, options) => (options?.refresh ? healthy : failing)(query));
    const save = vi.spyOn(promptLibraryApi, "setFavorite").mockResolvedValue({ id: fixture.id, favorite: true });
    render(<PromptLibraryView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("旧模型来源：来源暂不可用");
    expect(screen.getByText(fixture.title)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索提示词"), { target: { value: "测试提示词全文" } });
    await waitFor(() => expect(promptLibraryApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "测试提示词全文" }), expect.anything()));
    expect(await screen.findByRole("article")).toHaveTextContent(fixture.title);
    fireEvent.click(screen.getByRole("button", { name: "收藏 " + fixture.title }));
    expect(await screen.findByRole("button", { name: "取消收藏 " + fixture.title })).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(fixture.id, true);
    fireEvent.click(screen.getByRole("button", { name: "重试不可用来源" }));
    expect(screen.getByText(fixture.title)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(promptLibraryApi.list).toHaveBeenLastCalledWith(expect.anything(), { signal: expect.any(AbortSignal), refresh: true });
    expect(screen.getByText(fixture.title)).toBeInTheDocument();
  });
  it("keeps 2.5 selected on its failure and permits explicit switch to a healthy source", async () => {
    serve([{ ...fixture, id: "youmind-gpt-image-2:test", sourceId: oldSource.id, title: "健康来源作品" }], [testSource, oldSource], { sourceErrors: [{ sourceId: fixture.sourceId, message: "来源暂不可用，请稍后重试" }] });
    render(<PromptLibraryView />);
    expect(await screen.findByText("当前来源加载失败")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "筛选来源" })).getByRole("button", { name: /测试来源/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "筛选来源" })).getByRole("button", { name: /旧模型来源/ }));
    expect(await screen.findByRole("article")).toHaveTextContent("健康来源作品");
    expect(screen.getByRole("alert")).toHaveTextContent("测试来源：来源暂不可用");
  });
  it("distinguishes all-source failure from an empty collection", async () => {
    serve([], [testSource], { fetchedAt: null, sourceErrors: [{ sourceId: fixture.sourceId, message: "来源暂不可用，请稍后重试" }] });
    render(<PromptLibraryView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("公开来源暂时均不可用");
    expect(screen.getByText("等待来源恢复")).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});
