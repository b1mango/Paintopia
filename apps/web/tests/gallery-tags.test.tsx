import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GALLERY_TAGS } from "@paintopia/shared";
import { GalleryReviewConfig } from "../src/app/GalleryReviewConfig";
import { GalleryTagDialog } from "../src/app/GalleryTagDialog";
import { GalleryView } from "../src/app/GalleryView";
import { apiClient, type GalleryItem } from "../src/lib/apiClient";
import { clearMediaCache } from "../src/lib/useMediaFeed";
import { resetGalleryTagCache } from "../src/lib/galleryTags";

const pending: GalleryItem = { id: "gallery-one", assetId: "asset-one", userId: "user", title: "作品", prompt: "中文作品描述", imageUrl: "/image", thumbnailUrl: "/thumb", status: "pending", createdAt: "2026-10-23T00:00:00Z", tags: [] };
const tag = GALLERY_TAGS.find(value => value.id === "architecture")!;
beforeEach(() => {
  vi.spyOn(apiClient, "listGalleryTags").mockResolvedValue([...GALLERY_TAGS]);
  vi.spyOn(apiClient, "listGalleryTagUsage").mockResolvedValue({ architecture: 2, watercolor: 1 });
});
afterEach(() => { vi.restoreAllMocks(); clearMediaCache(); resetGalleryTagCache(); });

describe("manual gallery tags", () => {
  it("opens the tag drawer outside the page and restores its trigger on Escape", async () => {
    vi.spyOn(apiClient, "listGalleryReview").mockResolvedValue([pending]);
    const { container } = render(<GalleryReviewConfig />);
    const trigger = await screen.findByRole("button", { name: "通过并打标签" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "确认标签并发布" });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).not.toBe("hidden");
  });
  it("isolates concurrent rejection progress by card", async () => {
    const second = { ...pending, id: "gallery-two", prompt: "第二幅作品" };
    vi.spyOn(apiClient, "listGalleryReview").mockResolvedValue([pending, second]);
    const finish = new Map<string, (value: GalleryItem) => void>();
    vi.spyOn(apiClient, "reviewGalleryItem").mockImplementation(id => new Promise(resolve => finish.set(id, resolve)));
    render(<GalleryReviewConfig />);
    const rejectButtons = await screen.findAllByRole("button", { name: "拒绝" });
    fireEvent.click(rejectButtons[0]);
    expect(rejectButtons[1]).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "通过并打标签" })[1]).toBeEnabled();
    fireEvent.click(rejectButtons[1]);
    await act(async () => finish.get(pending.id)!({ ...pending, status: "rejected" }));
    expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();
    await act(async () => finish.get(second.id)!({ ...second, status: "rejected" }));
    expect(screen.getByText("暂无待审核图片")).toBeInTheDocument();
  });

  it("cancels without publishing and only submits the selected item's tags", async () => {
    vi.spyOn(apiClient, "listGalleryReview").mockResolvedValue([pending, { ...pending, id: "gallery-two", prompt: "第二幅作品" }]);
    const approve = vi.spyOn(apiClient, "reviewGalleryItem").mockResolvedValue({ ...pending, status: "approved", tags: [tag] });
    render(<GalleryReviewConfig />);
    fireEvent.click((await screen.findAllByRole("button", { name: "通过并打标签" }))[0]);
    expect(approve).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "确认标签并发布" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "建筑" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "通过并打标签" })[0]);
    expect(screen.getByRole("checkbox", { name: "建筑" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "建筑" }));
    fireEvent.click(screen.getByRole("button", { name: "确认标签并发布" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("gallery-one", "approve", undefined, ["architecture"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "通过并打标签" })).toHaveLength(1);
    expect(screen.getByText("第二幅作品")).toBeInTheDocument();
  });

  it("limits tags to eight, searches aliases and keeps choices after a failed save", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("保存暂时失败")).mockResolvedValue(undefined);
    render(<GalleryTagDialog item={pending} onClose={vi.fn()} onSave={save} />);
    const boxes = screen.getAllByRole("checkbox");
    boxes.slice(0, 8).forEach(box => fireEvent.click(box));
    expect(screen.getByText("8 / 8")).toBeInTheDocument();
    fireEvent.click(boxes[8]);
    expect(boxes[8]).not.toBeChecked();
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[8]);
    expect(boxes[8]).toBeChecked();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索标签" }), { target: { value: "building" } });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "建筑" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "确认标签并发布" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存暂时失败");
    expect(screen.getByText("8 / 8")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认标签并发布" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[0][0]).toEqual(save.mock.calls[1][0]);
  });

  it("creates a missing tag in the chosen group, selects it and offers it in the gallery filter", async () => {
    const poster = { id: "custom-0a1b2c3d", label: "海报", aliases: [], group: "style" as const };
    const create = vi.spyOn(apiClient, "createGalleryTag").mockResolvedValue(poster);
    const save = vi.fn().mockResolvedValue(undefined);
    render(<GalleryTagDialog item={pending} onClose={vi.fn()} onSave={save} />);
    const search = screen.getByRole("textbox", { name: "搜索标签" });
    fireEvent.change(search, { target: { value: "building" } });
    expect(screen.queryByRole("button", { name: "新建并选中" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: " 海报 " } });
    expect(screen.getByText("海报")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "新标签分组" })).getByRole("radio", { name: "风格" }));
    fireEvent.click(screen.getByRole("button", { name: "新建并选中" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("海报", "style"));
    expect(await screen.findByRole("button", { name: "移除标签 海报" })).toBeInTheDocument();
    expect(search).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "海报" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "确认标签并发布" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith([poster.id]));
    vi.spyOn(apiClient, "listMediaFeed").mockResolvedValue({ items: [], nextCursor: null });
    vi.mocked(apiClient.listGalleryTagUsage).mockResolvedValue({ [poster.id]: 3 });
    render(<GalleryView account="tag-test" canManage={false} onUsePrompt={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "更多标签" }));
    expect(within(screen.getByRole("dialog", { name: "更多画廊标签" })).getByRole("button", { name: "海报，3 幅" })).toBeInTheDocument();
  });

  it("loads admin-created tags for the dialog and labels them on saved items", async () => {
    const poster = { id: "custom-0a1b2c3d", label: "海报", aliases: [], group: "style" as const };
    vi.mocked(apiClient.listGalleryTags).mockResolvedValue([...GALLERY_TAGS, poster]);
    render(<GalleryTagDialog item={{ ...pending, status: "approved", tags: [poster] }} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "移除标签 海报" })).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: "海报" })).toBeChecked();
  });

  it("backfills published untagged works and reloads saved tags", async () => {
    let approved = { ...pending, status: "approved" as const };
    vi.spyOn(apiClient, "listGalleryReview").mockImplementation(async status => status === "pending" ? [] : [approved]);
    const update = vi.spyOn(apiClient, "updateGalleryTags").mockImplementation(async () => {
      approved = { ...approved, tags: [tag] }; return approved;
    });
    render(<GalleryReviewConfig />);
    fireEvent.click(screen.getByRole("button", { name: "待补标签" }));
    fireEvent.click(await screen.findByRole("button", { name: "补充标签" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "建筑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("gallery-one", ["architecture"]));
    expect(await screen.findByText("已发布作品均已添加标签")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已发布" }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑标签" }));
    expect(screen.getByRole("checkbox", { name: "建筑" })).toBeChecked();
  });

  it("renders persisted tags and sends their IDs as the feed filter", async () => {
    const feed = vi.spyOn(apiClient, "listMediaFeed").mockResolvedValue({ items: [{ ...pending, status: "approved", tags: [tag] }], nextCursor: null });
    render(<GalleryView account="tag-test" canManage={false} onUsePrompt={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "按标签筛选：建筑" }));
    await waitFor(() => expect(feed.mock.calls.at(-1)?.[1].get("category")).toBe("architecture"));
    fireEvent.click(await screen.findByRole("button", { name: "更多标签" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "更多画廊标签" })).getByRole("button", { name: "水彩，1 幅" }));
    await waitFor(() => expect(feed.mock.calls.at(-1)?.[1].get("category")).toBe("watercolor"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "水彩" })).toHaveAttribute("aria-pressed", "true");
  });

  it("only offers tags that have visible works", async () => {
    vi.spyOn(apiClient, "listMediaFeed").mockResolvedValue({ items: [], nextCursor: null });
    render(<GalleryView account="tag-test" canManage={false} onUsePrompt={() => undefined} />);
    expect(await screen.findByRole("button", { name: "建筑" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "城市" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多标签" }));
    const menu = screen.getByRole("dialog", { name: "更多画廊标签" });
    expect(within(menu).getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["水彩，1 幅"]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多标签" })).toHaveFocus();
  });
});
