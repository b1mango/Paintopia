import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptSource, SourcedPrompt } from "@paintopia/shared";
import { PromptLibraryView } from "../src/features/prompts/PromptLibraryView";
import { promptLibraryApi } from "../src/features/prompts/promptLibraryApi";
import { servePromptLibrary } from "./servePromptLibrary";

const source: PromptSource = {
  id: "image-2-5", name: "GPT Image 2.5 测试来源", model: "gpt-image-2.5",
  homepage: "https://example.com/source", feedUrl: "https://example.com/feed",
  license: "原作者条款", licenseUrl: "https://example.com/license",
  aggregatorUrl: "https://example.com/repository", aggregatorLicenseUrl: "https://example.com/license",
  compatibilityNote: "来源标注 2.5，本站未独立验证"
};
const oldSource: PromptSource = { ...source, id: "youmind-gpt-image-2", name: "GPT Image 2 测试来源", model: "gpt-image-2" };
const curatedSource: PromptSource = {
  ...source, id: "paintopia-curated", name: "站主推荐", model: "gpt-image-2",
  homepage: "", licenseUrl: "", license: "站主原创", compatibilityNote: "站长亲笔"
};
const item = (index: number, overrides: Partial<SourcedPrompt> = {}): SourcedPrompt => ({
  id: "image-2-5:test-" + index, sourceId: source.id, title: "作品 " + index,
  text: "完整提示词 " + index + "\nPreserve all details.", description: "自然光作品", tags: ["摄影"],
  author: "作者甲", sourceUrl: "https://example.com/post", model: source.model, favorite: false, ...overrides
});
const curated = (overrides: Partial<SourcedPrompt> = {}) => item(0, {
  id: "paintopia-curated:c1", sourceId: curatedSource.id, title: "精选雨巷", text: "雨巷，油纸伞", tags: ["人像"], author: "绘境", sourceUrl: "",
  coverUrl: "https://media.example.com/thumb.webp", imageUrl: "https://media.example.com/full.png", width: 1024, height: 1536, model: "gpt-image-2", ...overrides
});
function mockLibrary(items: SourcedPrompt[], sources = [curatedSource, oldSource, source]) {
  vi.mocked(promptLibraryApi.list).mockImplementation(servePromptLibrary(items, sources));
}
const lastQuery = () => vi.mocked(promptLibraryApi.list).mock.lastCall?.[0];
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function restore(object: object, key: string, descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(object, key, descriptor);
  else Reflect.deleteProperty(object, key);
}
beforeEach(() => {
  vi.spyOn(promptLibraryApi, "list");
  vi.spyOn(promptLibraryApi, "setFavorite").mockImplementation(async (id, favorite) => ({ id, favorite }));
  mockLibrary([item(1)]);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restore(HTMLDialogElement.prototype, "showModal", originalShowModal);
  restore(HTMLDialogElement.prototype, "close", originalClose);
  restore(navigator, "clipboard", originalClipboard);
});
async function openDetail(title = "作品 1") {
  fireEvent.click(await screen.findByRole("button", { name: "查看详情 " + title }));
  return screen.getByRole("dialog");
}
const sourceButton = (name: RegExp) => within(screen.getByRole("group", { name: "筛选来源" })).getByRole("button", { name });

describe("PromptLibraryView source UI", () => {
  it("defaults to 2.5 when there are no curated prompts, hides the empty curated source and counts the server total", async () => {
    mockLibrary([item(0, { sourceId: oldSource.id, title: "旧模型作品", model: "gpt-image-2" }), item(1)]);
    render(<PromptLibraryView />);
    expect(await screen.findByText("作品 1")).toBeInTheDocument();
    expect(sourceButton(/GPT Image 2.5 测试来源/)).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("group", { name: "筛选来源" })).queryByRole("button", { name: /站主推荐/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.queryByText("旧模型作品")).not.toBeInTheDocument();
    expect(screen.getByText("条提示词").parentElement).toHaveTextContent("他山之石 · 共 1条提示词");
    fireEvent.click(sourceButton(/GPT Image 2 测试来源/));
    expect(await screen.findByText("旧模型作品")).toBeInTheDocument();
    expect(screen.queryByText("作品 1")).not.toBeInTheDocument();
  });
  it("opens on curated prompts when there are some, and shows the full effect image in the detail", async () => {
    mockLibrary([curated(), item(1)]);
    render(<PromptLibraryView />);
    expect(await screen.findByText("精选雨巷")).toBeInTheDocument();
    expect(sourceButton(/站主推荐/)).toHaveAttribute("aria-pressed", "true");
    const chips = within(screen.getByRole("group", { name: "筛选来源" })).getAllByRole("button").map(button => button.textContent);
    expect(chips[1]).toMatch(/^站主推荐/);
    expect(screen.queryByText("精")).not.toBeInTheDocument();
    expect(promptLibraryApi.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "精选雨巷" })).toHaveAttribute("src", "https://media.example.com/thumb.webp");
    const modal = await openDetail("精选雨巷");
    expect(within(modal).getByRole("img", { name: "精选雨巷" })).toHaveAttribute("src", "https://media.example.com/full.png");
    expect(within(modal).queryByRole("link", { name: /查看原作/ })).not.toBeInTheDocument();
    expect(within(modal).queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });
  it("lets admins edit and remove curated prompts from the detail", async () => {
    mockLibrary([curated()]);
    const update = vi.spyOn(promptLibraryApi, "updateCurated").mockImplementation(async (row, patch) => ({ ...row, ...patch }));
    const remove = vi.spyOn(promptLibraryApi, "removeCurated").mockImplementation(async () => { mockLibrary([]); });
    render(<PromptLibraryView canManage />);
    const modal = await openDetail("精选雨巷");
    fireEvent.click(within(modal).getByRole("button", { name: "编辑" }));
    const form = within(modal).getByRole("form", { name: "编辑推荐提示词" });
    fireEvent.change(within(form).getByLabelText("标题"), { target: { value: "雨巷新题" } });
    fireEvent.change(within(form).getByLabelText(/标签/), { target: { value: "人像，雨天, 街景" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(modal).findByRole("heading", { name: "雨巷新题" })).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: "paintopia-curated:c1" }), { title: "雨巷新题", description: "自然光作品", text: "雨巷，油纸伞", tags: ["人像", "雨天", "街景"] });
    expect(screen.getByRole("button", { name: "人像", hidden: true })).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole("button", { name: "移出站主推荐" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(modal).getByRole("button", { name: "确认移出站主推荐" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(remove).toHaveBeenCalledWith("paintopia-curated:c1");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已移出站主推荐");
    await waitFor(() => expect(screen.queryByRole("button", { name: "人像" })).not.toBeInTheDocument());
  });
  it("falls back once to the site route when a curated image fails, then shows the placeholder", async () => {
    mockLibrary([curated()]);
    render(<PromptLibraryView />);
    const image = await screen.findByRole("img", { name: "精选雨巷" });
    fireEvent.error(image);
    expect(screen.getByRole("img", { name: "精选雨巷" })).toHaveAttribute("src", "/api/curated-prompts/c1/thumbnail");
    fireEvent.error(screen.getByRole("img", { name: "精选雨巷" }));
    expect(screen.getByText("封面暂不可用")).toBeInTheDocument();
  });
  it("sends tag chips to the server and toggles them off", async () => {
    mockLibrary([item(1), item(2, { tags: ["建筑"] })]);
    render(<PromptLibraryView />);
    await screen.findByText("作品 1");
    expect(screen.getByRole("heading", { name: "灵感" })).toBeInTheDocument();
    const filters = within(screen.getByRole("complementary", { name: "提示词筛选" }));
    fireEvent.click(within(filters.getByRole("group", { name: "筛选标签" })).getByRole("button", { name: "摄影" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(lastQuery()).toEqual({ source: "image-2-5", q: "", tag: "摄影", favorites: false });
    const photography = within(filters.getByRole("group", { name: "筛选标签" })).getByRole("button", { name: "摄影" });
    expect(photography).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(photography);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    expect(photography).toHaveAttribute("aria-pressed", "false");
  });
  it("copies and uses exact text directly from a card without opening details", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onUsePrompt = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<PromptLibraryView onUsePrompt={onUsePrompt} />);
    const card = within(await screen.findByRole("article"));
    fireEvent.click(card.getByRole("button", { name: "复制提示词 作品 1" }));
    await waitFor(() => expect(card.getByRole("button", { name: "复制提示词 作品 1" })).toHaveTextContent("已复制"));
    expect(writeText).toHaveBeenCalledWith(item(1).text);
    fireEvent.click(card.getByRole("button", { name: "选用提示词 作品 1" }));
    expect(onUsePrompt).toHaveBeenCalledWith(item(1).text);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(card.getByRole("button", { name: "收藏 作品 1" })).toBeEnabled();
  });
  it("disables direct use when creation is unavailable and reports direct copy failure", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(<PromptLibraryView />);
    const card = within(await screen.findByRole("article"));
    expect(card.getByRole("button", { name: "选用提示词 作品 1" })).toBeDisabled();
    fireEvent.click(card.getByRole("button", { name: "复制提示词 作品 1" }));
    expect(screen.getByRole("status")).toHaveTextContent("复制失败");
  });
  it("pages 24 cards at a time from the server and starts over when the search changes", async () => {
    mockLibrary(Array.from({ length: 30 }, (_, i) => item(i + 1)));
    render(<PromptLibraryView />);
    await screen.findByText("作品 1");
    expect(screen.getAllByRole("article")).toHaveLength(24);
    expect(screen.queryByText("作品 25")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "再看一些 · 还有 6 条" }));
    expect(await screen.findByText("作品 30")).toBeInTheDocument();
    expect(lastQuery()).toMatchObject({ source: "image-2-5", offset: 24 });
    expect(screen.getAllByRole("article")).toHaveLength(30);
    expect(screen.queryByRole("button", { name: /再看一些/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索提示词"), { target: { value: "作品 30" } });
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("搜索提示词"), { target: { value: "" } });
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(24));
  });
  it("debounces search and sends the trimmed term", async () => {
    mockLibrary([item(1, { title: "雾中山谷" }), item(2)]);
    render(<PromptLibraryView />);
    await screen.findByText("雾中山谷");
    const calls = vi.mocked(promptLibraryApi.list).mock.calls.length;
    const input = screen.getByLabelText("搜索提示词");
    fireEvent.change(input, { target: { value: "  雾" } });
    fireEvent.change(input, { target: { value: "  雾中山谷  " } });
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(vi.mocked(promptLibraryApi.list).mock.calls.length).toBe(calls + 1);
    expect(lastQuery()).toMatchObject({ q: "雾中山谷" });
  });
  it("persists favorite requests, waits for confirmation, then removes from favorites filter", async () => {
    let finish!: (value: { id: string; favorite: boolean }) => void;
    vi.mocked(promptLibraryApi.setFavorite).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<PromptLibraryView />);
    const button = await screen.findByRole("button", { name: "收藏 作品 1" });
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(promptLibraryApi.setFavorite).toHaveBeenCalledTimes(1);
    expect(promptLibraryApi.setFavorite).toHaveBeenCalledWith(item(1).id, true);
    finish({ id: item(1).id, favorite: true });
    await screen.findByRole("button", { name: "取消收藏 作品 1" });
    mockLibrary([item(1, { favorite: true })]);
    fireEvent.click(screen.getByRole("button", { name: "只看收藏" }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ favorites: true }));
    fireEvent.click(await screen.findByRole("button", { name: "取消收藏 作品 1" }));
    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
    expect(promptLibraryApi.setFavorite).toHaveBeenLastCalledWith(item(1).id, false);
  });
  it("keeps the existing favorite state if server persistence fails", async () => {
    vi.mocked(promptLibraryApi.setFavorite).mockRejectedValueOnce(new Error("收藏保存失败，请重试"));
    render(<PromptLibraryView />);
    fireEvent.click(await screen.findByRole("button", { name: "收藏 作品 1" }));
    expect(await screen.findByText("收藏保存失败，请重试")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收藏 作品 1" })).toHaveAttribute("aria-pressed", "false");
  });
  it("shows native detail, attribution and full bilingual source text; copies and selects exact text", async () => {
    const text = "完整中文，构图、光线及禁止项。\nFull English prompt, no truncation.\n";
    mockLibrary([item(1, { text })]);
    const writeText = vi.fn().mockResolvedValue(undefined); const onUsePrompt = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<PromptLibraryView onUsePrompt={onUsePrompt} />);
    const modal = await openDetail();
    expect(modal.tagName).toBe("DIALOG");
    expect(within(modal).getByLabelText("完整提示词")).toHaveValue(text);
    expect(within(modal).getByRole("link", { name: /查看原作/ })).toHaveAttribute("href", item(1).sourceUrl);
    expect(within(modal).getByRole("link", { name: source.license })).toHaveAttribute("href", source.licenseUrl);
    fireEvent.click(within(modal).getByRole("button", { name: "复制提示词" }));
    await waitFor(() => expect(within(modal).getByRole("status")).toHaveTextContent("提示词已复制"));
    expect(writeText).toHaveBeenCalledWith(text);
    fireEvent.click(within(modal).getByRole("button", { name: /选用提示词/ }));
    expect(onUsePrompt).toHaveBeenCalledWith(text);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it.each(["unavailable", "rejected"])("reports clipboard failure when %s without claiming success", async (scenario) => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: scenario === "unavailable" ? undefined : { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<PromptLibraryView />);
    const modal = await openDetail();
    fireEvent.click(within(modal).getByRole("button", { name: "复制提示词" }));
    await waitFor(() => expect(within(modal).getByRole("status")).toHaveTextContent("手动选择文本复制"));
    expect(within(modal).queryByRole("button", { name: "已复制" })).not.toBeInTheDocument();
  });
  it("does not silently fall back to GPT2 when 2.5 has no entries", async () => {
    mockLibrary([item(1, { sourceId: oldSource.id, title: "旧模型作品" })]);
    render(<PromptLibraryView />);
    await screen.findByText("没有符合条件的作品");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(sourceButton(/GPT Image 2.5 测试来源/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("旧模型作品")).not.toBeInTheDocument();
  });
  it("shows a source error, then retries without fabricated fallback", async () => {
    vi.mocked(promptLibraryApi.list).mockRejectedValueOnce(new Error("来源暂不可用"));
    render(<PromptLibraryView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("来源暂不可用");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("作品 1")).toBeInTheDocument();
  });
});

describe("curated admin api", () => {
  it("sends bare ids to the admin endpoints and merges the saved prompt back into the list item", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "c1", title: "新题", text: "新文", description: null, tags: ["雨"], sortOrder: 0, sourceAssetId: "a1", coverUrl: "/t.webp", imageUrl: "/f.png", width: 8, height: 9, createdAt: "", updatedAt: "" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const saved = await promptLibraryApi.updateCurated(curated({ favorite: true }), { title: "新题" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/curated-prompts/c1");
    expect(saved).toMatchObject({ id: "paintopia-curated:c1", title: "新题", text: "新文", description: "", tags: ["雨"], coverUrl: "/t.webp", imageUrl: "/f.png", width: 8, height: 9, favorite: true, author: "绘境" });
    await expect(promptLibraryApi.removeCurated("paintopia-curated:c1")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/admin/curated-prompts/c1");
    vi.unstubAllGlobals();
  });
});
