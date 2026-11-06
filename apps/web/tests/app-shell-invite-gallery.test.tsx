import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/app/AppShell";
import { clearMediaCache } from "../src/lib/useMediaFeed";
import { apiClient } from "../src/lib/apiClient";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearMediaCache();
});

function mockFeed(items: any[]) {
  // 画廊标签只显示有作品的，这里声明夹具里实际出现的分类。
  vi.spyOn(apiClient, "listGalleryTagUsage").mockResolvedValue({ architecture: 1, city: 1, dreamcore: 1, portrait: 1 });
  return vi.spyOn(apiClient, "listMediaFeed").mockImplementation(async (_kind, query) => {
    const search=query.get("search") || "";
    const category=query.get("category") || "all";
    const words: Record<string,string>={architecture:"building",city:"city",dreamcore:"dreamcore",portrait:"portrait"};
    return {items:items.filter(i => `${i.title??""} ${i.prompt}`.includes(search) && (category==="all" || i.prompt.includes(words[category]))),nextCursor:null};
  });
}

describe("AppShell invite and gallery additions", () => {
  it("loads synced gallery items on the gallery page", async () => {
    const client = apiClient as typeof apiClient & {
      listGalleryItems: () => Promise<unknown[]>;
    };
    mockFeed([
      {
        id: "gallery-1",
        assetId: "asset-gallery",
        imageUrl: "/api/assets/asset-gallery/original",
        thumbnailUrl: "/api/assets/asset-gallery/thumbnail",
        authorName: "mango",
        title: "不应展示的标题",
        prompt: "同步到画廊的图像，包含一段较长的提示词，用于验证画廊卡片只展示一部分并在悬停时显示完整内容。",
        status: "approved",
        createdAt: "2026-06-11T14:00:01"
      }
    ]);

    render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="gallery" />);

    expect(await screen.findByText(/包含一段较长的提示词/)).toBeInTheDocument();
    expect(screen.queryByText("不应展示的标题")).not.toBeInTheDocument();
    expect(screen.getByAltText("画廊图片")).toHaveAttribute("src", "/api/assets/asset-gallery/thumbnail");
    expect(screen.getByLabelText("作者 mango")).toBeInTheDocument();
    const promptText = screen.getByText(/包含一段较长的提示词/);
    expect(promptText).not.toHaveAttribute("title");
    expect(promptText.parentElement).toHaveAttribute(
      "data-tooltip",
      "同步到画廊的图像，包含一段较长的提示词，用于验证画廊卡片只展示一部分并在悬停时显示完整内容。"
    );
    expect(promptText.closest("[class*='galleryCard']")).toBeInTheDocument();
    expect(promptText.closest("[class*='galleryGrid']")).toBeInTheDocument();
    expect(screen.getByLabelText("画廊关键词").closest("[class*='galleryTools']")).toBeInTheDocument();
  });

  it("renders gallery as a four-column masonry layout with full-ratio images", async () => {
    mockFeed([
      {
        id: "gallery-wide",
        assetId: "asset-wide",
        userId: "u1",
        imageUrl: "/api/assets/asset-wide/original",
        title: "wide",
        prompt: "wide image prompt",
        status: "approved",
        createdAt: "2026-06-11T00:00:00.000Z"
      },
      {
        id: "gallery-tall",
        assetId: "asset-tall",
        userId: "u1",
        imageUrl: "/api/assets/asset-tall/original",
        title: "tall",
        prompt: "tall image prompt",
        status: "approved",
        createdAt: "2026-06-12T00:00:00.000Z"
      }
    ]);

    render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="gallery" />);

    expect(await screen.findByText("wide image prompt")).toBeInTheDocument();
    const masonry = screen.getByTestId("gallery-masonry");
    expect(masonry.className).toContain("galleryMasonry");
    expect(masonry).toHaveAttribute("data-column-count", "4");
    expect(screen.getAllByTestId("gallery-column")).toHaveLength(4);
    expect(screen.getAllByTestId("gallery-masonry-item")).toHaveLength(2);
    for (const image of screen.getAllByAltText("画廊图片")) {
      expect(image.className).toContain("galleryImage");
    }
    expect(screen.getByText("wide image prompt").parentElement).toHaveAttribute("data-tooltip", "wide image prompt");
  });

  it("filters gallery items by search and category", async () => {
    mockFeed([
      {
        id: "gallery-building",
        assetId: "asset-building",
        userId: "u1",
        imageUrl: "/api/assets/asset-building/original",
        title: "dreamcore building",
        prompt: "millennium-era China city street architecture building dreamcore atmosphere and one street person scene",
        status: "approved",
        createdAt: "2026-06-11T14:00:01"
      },
      {
        id: "gallery-portrait",
        assetId: "asset-portrait",
        userId: "u1",
        imageUrl: "/api/assets/asset-portrait/original",
        title: "portrait",
        prompt: "photorealistic portrait of a woman",
        status: "approved",
        createdAt: "2026-06-12T00:00:00.000Z"
      }
    ]);

    render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="gallery" />);

    expect(await screen.findByText("millennium-era China city street architecture building dreamcore atmosphere and one street person scene")).toBeInTheDocument();
    expect(screen.getByText("photorealistic portrait of a woman")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("画廊关键词"), { target: { value: "portrait" } });
    await waitFor(() => expect(screen.queryByText("millennium-era China city street architecture building dreamcore atmosphere and one street person scene")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("photorealistic portrait of a woman")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("画廊关键词"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /建筑/ }));
    await waitFor(() => expect(screen.getByText("millennium-era China city street architecture building dreamcore atmosphere and one street person scene")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("photorealistic portrait of a woman")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /城市/ }));
    await waitFor(() => expect(screen.getByText("millennium-era China city street architecture building dreamcore atmosphere and one street person scene")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("photorealistic portrait of a woman")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /梦核/ }));
    await waitFor(() => expect(screen.getByText("millennium-era China city street architecture building dreamcore atmosphere and one street person scene")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("photorealistic portrait of a woman")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /人像/ }));
    await waitFor(() => expect(screen.queryByText("millennium-era China city street architecture building dreamcore atmosphere and one street person scene")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("photorealistic portrait of a woman")).toBeInTheDocument());
  });

  it("does not show generated time on gallery cards but keeps it on asset cards", async () => {
    mockFeed([
      {
        id: "gallery-time",
        assetId: "asset-time",
        userId: "u1",
        imageUrl: "/api/assets/asset-time/original",
        title: "gallery time",
        prompt: "gallery item without visible time",
        status: "approved",
        createdAt: "2026-06-11T00:00:00.000Z"
      }
    ]);

    const { rerender } = render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="gallery" />);

    expect(await screen.findByText("gallery item without visible time")).toBeInTheDocument();
    expect(screen.queryByText(/2026/)).not.toBeInTheDocument();

    vi.restoreAllMocks();
    mockFeed([
      {
        id: "asset-time",
        imageUrl: "/api/assets/asset-time/original",
        thumbnailUrl: "/api/assets/asset-time/thumbnail",
        ownerName: "artist",
        ownerEmail: "artist@example.com",
        prompt: "asset generated time",
        createdAt: "2026-06-11T14:00:01"
      }
    ]);

    rerender(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="assets" />);

    expect(await screen.findByText("asset generated time")).toBeInTheDocument();
    expect(screen.getByText("2026-06-11 14:00:01")).toBeInTheDocument();
    expect(screen.getByAltText("生成资产")).toHaveAttribute("src", "/api/assets/asset-time/thumbnail");
    expect(screen.queryByLabelText("所属用户 artist@example.com")).not.toBeInTheDocument();
  });

  it("hides owner metadata on a regular user's own asset page", async () => {
    mockFeed([{
      id: "asset-owned",
      imageUrl: "/api/assets/asset-owned/original",
      thumbnailUrl: "/api/assets/asset-owned/thumbnail",
      ownerName: "artist",
      ownerEmail: "artist@example.com",
      prompt: "private owner metadata",
      createdAt: "2026-06-11T14:00:01"
    }]);

    render(<AppShell user={{ email: "artist@example.com", role: "user", quota: 100 }} activeModule="assets" />);

    expect(await screen.findByText("private owner metadata")).toBeInTheDocument();
    expect(screen.queryByLabelText("所属用户 artist@example.com")).not.toBeInTheDocument();
  });

  it("syncs an asset card to the gallery", async () => {
    const client = apiClient as typeof apiClient & {
      syncAssetToGallery: (assetId: string) => Promise<unknown>;
      unsyncAssetFromGallery: (assetId: string) => Promise<{ expiresAt: string | null }>;
    };
    mockFeed([
      {
        id: "asset-gallery",
        imageUrl: "/api/assets/asset-gallery/original",
        thumbnailUrl: "/api/assets/asset-gallery/thumbnail",
        prompt: "同步到画廊的图像",
        createdAt: "2026-06-11T00:00:00.000Z"
      }
    ]);
    vi.spyOn(client, "unsyncAssetFromGallery").mockResolvedValue({ expiresAt: null });
    vi.spyOn(client, "syncAssetToGallery").mockResolvedValue({
      id: "gallery-1",
      assetId: "asset-gallery",
      title: "同步到画廊的图像",
      prompt: "同步到画廊的图像",
      status: "pending",
      createdAt: "2026-06-11T00:00:00.000Z"
    });

    render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="assets" />);

    expect(await screen.findByText("同步到画廊的图像")).toBeInTheDocument();
    const syncButton = screen.getByRole("button", { name: "同步到画廊" });
    expect(syncButton).toHaveTextContent("上传到画廊");
    expect(screen.getByRole("button", { name: "删除资产" }).textContent).toBe("");
    expect(syncButton.closest("[class*='assetCard']")).toBeInTheDocument();
    expect(syncButton.closest("[class*='assetGrid']")).toBeInTheDocument();
    fireEvent.click(syncButton);

    expect(client.syncAssetToGallery).toHaveBeenCalledWith("asset-gallery");
    const syncedLabels = await screen.findAllByText("待审核");
    expect(syncedLabels.length).toBeGreaterThan(0);
    expect(syncedLabels[0].parentElement?.className).toContain("assetMetaFooter");
    const unsyncButton = await screen.findByRole("button", { name: "取消同步到画廊" });
    expect(unsyncButton).toHaveTextContent("撤回画廊");
    fireEvent.click(unsyncButton);
    expect(client.unsyncAssetFromGallery).toHaveBeenCalledWith("asset-gallery");
    await waitFor(() => expect(screen.queryByText("待审核")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "同步到画廊" })).toBeEnabled();
  });

  it("removes a gallery item when unsyncing from the gallery page", async () => {
    const client = apiClient as typeof apiClient & {
      listGalleryItems: () => Promise<unknown[]>;
      unsyncAssetFromGallery: (assetId: string) => Promise<{ expiresAt: string | null }>;
    };
    mockFeed([
      {
        id: "gallery-unsync",
        assetId: "asset-gallery",
        imageUrl: "/api/assets/asset-gallery/original",
        title: "取消同步测试",
        prompt: "取消同步的画廊图像",
        status: "approved",
        createdAt: "2026-06-11T00:00:00.000Z"
      }
    ]);
    vi.spyOn(client, "unsyncAssetFromGallery").mockResolvedValue({ expiresAt: null });

    render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="gallery" />);

    expect(await screen.findByText("取消同步的画廊图像")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消同步到画廊" }));

    expect(client.unsyncAssetFromGallery).toHaveBeenCalledWith("asset-gallery");
    await waitFor(() => expect(screen.queryByText("取消同步的画廊图像")).not.toBeInTheDocument());
    expect(screen.getByText("暂无画廊图片")).toBeInTheDocument();
  });
  it("opens an asset preview dialog without a second download action", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    mockFeed([
      {
        id: "asset-preview",
        imageUrl: "/api/assets/asset-preview/original",
        prompt: "完整资产提示词，用于在弹窗中复制。",
        createdAt: "2026-06-11T00:00:00.000Z"
      }
    ]);

    render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="assets" />);

    expect(await screen.findByRole("link", { name: "下载资产图片" })).toHaveAttribute(
      "href",
      "/api/assets/asset-preview/download"
    );
    fireEvent.click(await screen.findByRole("button", { name: "查看资产完整图片" }));

    const dialog = screen.getByRole("dialog", { name: "完整资产图片" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByAltText("完整资产图片")).toHaveAttribute("src", "/api/assets/asset-preview/original");
    expect(within(dialog).getByText("完整资产提示词，用于在弹窗中复制。")).toBeInTheDocument();
    expect(within(dialog).queryByRole("link", { name: "保存图片" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "复制提示词" }));
    expect(writeText).toHaveBeenCalledWith("完整资产提示词，用于在弹窗中复制。");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "完整资产图片" })).not.toBeInTheDocument();
  });

  it("opens a gallery preview dialog with full image and prompt copy action", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    const client = apiClient as typeof apiClient & {
      listGalleryItems: () => Promise<unknown[]>;
    };
    mockFeed([
      {
        id: "gallery-preview",
        assetId: "asset-gallery",
        imageUrl: "/api/assets/asset-gallery/original",
        authorName: "mango",
        title: "画廊预览图",
        prompt: "完整画廊提示词，用于在弹窗中复制。",
        status: "approved",
        createdAt: "2026-06-11T00:00:00.000Z"
      }
    ]);

    render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="gallery" />);

    expect(await screen.findByRole("link", { name: "下载画廊图片" })).toHaveAttribute(
      "href",
      "/api/gallery/gallery-preview/download"
    );
    fireEvent.click(await screen.findByRole("button", { name: "查看画廊完整图片" }));

    const dialog = screen.getByRole("dialog", { name: "画廊预览图" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByAltText("完整画廊图片")).toHaveAttribute("src", "/api/assets/asset-gallery/original");
    expect(within(dialog).getByText("mango")).toBeInTheDocument();
    expect(within(dialog).getByText("完整画廊提示词，用于在弹窗中复制。")).toBeInTheDocument();
    expect(within(dialog).queryByRole("link", { name: "保存图片" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "复制提示词" }));
    expect(writeText).toHaveBeenCalledWith("完整画廊提示词，用于在弹窗中复制。");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "画廊预览图" })).not.toBeInTheDocument();
  });

  it("shows already synced state on synced asset cards and allows unsync", async () => {
    const client = apiClient as typeof apiClient & {
      unsyncAssetFromGallery: (assetId: string) => Promise<{ expiresAt: string | null }>;
    };
    vi.spyOn(client, "unsyncAssetFromGallery").mockResolvedValue({ expiresAt: null });
    mockFeed([
      {
        id: "asset-gallery",
        imageUrl: "/api/assets/asset-gallery/original",
        prompt: "已经同步的图像",
        createdAt: "2026-06-11T00:00:00.000Z",
        gallerySynced: true,
        galleryItemId: "gallery-1",
        galleryStatus: "approved"
      } as any
    ]);

    render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="assets" />);

    expect(await screen.findByText("已经同步的图像")).toBeInTheDocument();
    const syncedLabels = screen.getAllByText("已发布");
    expect(syncedLabels.length).toBeGreaterThan(0);
    expect(syncedLabels[0].parentElement?.className).toContain("assetMetaFooter");
    const unsyncButton = await screen.findByRole("button", { name: "取消同步到画廊" });
    expect(unsyncButton).toHaveTextContent("撤回画廊");
    fireEvent.click(unsyncButton);
    expect(client.unsyncAssetFromGallery).toHaveBeenCalledWith("asset-gallery");
    await waitFor(() => expect(screen.queryByText("已发布")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "同步到画廊" })).toBeEnabled();
  });

  it("manages invite codes inside the user management page", async () => {
    const client = apiClient as typeof apiClient & {
      listInviteCodes: (filters?: { q?: string; status?: string }) => Promise<unknown[]>;
      createInviteCode: () => Promise<unknown>;
      destroyInviteCode: (inviteId: string) => Promise<unknown>;
    };
    vi.spyOn(apiClient, "listUsers").mockResolvedValue([]);
    vi.spyOn(client, "listInviteCodes")
      .mockResolvedValueOnce([
        {
          id: "invite-1",
          code: "PT-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
          status: "active",
          createdByEmail: "owner",
          usedByEmail: null,
          createdAt: "2026-06-10T00:00:00.000Z",
          usedAt: null,
          destroyedAt: null
        }
      ])
      .mockResolvedValueOnce([]);
    vi.spyOn(client, "createInviteCode").mockResolvedValue({
      id: "invite-2",
      code: "PT-1234567890abcdefghijklmnopqrstuv",
      status: "active",
      createdByEmail: "owner",
      usedByEmail: null,
      createdAt: "2026-06-11T00:00:00.000Z",
      usedAt: null,
      destroyedAt: null
    });
    vi.spyOn(client, "destroyInviteCode").mockResolvedValue({
      id: "invite-2",
      code: "PT-1234567890abcdefghijklmnopqrstuv",
      status: "destroyed",
      createdByEmail: "owner",
      usedByEmail: null,
      createdAt: "2026-06-11T00:00:00.000Z",
      usedAt: null,
      destroyedAt: "2026-06-11T00:00:00.000Z"
    });

    render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="config-users" />);

    expect(await screen.findByText("邀请码管理")).toBeInTheDocument();
    expect(screen.getByText("PT-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("筛选邀请码"), { target: { value: "used" } });
    expect(client.listInviteCodes).toHaveBeenLastCalledWith({ q: "", status: "used" });

    fireEvent.click(screen.getByRole("button", { name: "生成邀请码" }));
    expect(await screen.findByText("PT-1234567890abcdefghijklmnopqrstuv")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "销毁邀请码 PT-1234567890abcdefghijklmnopqrstuv" }));
    expect(client.destroyInviteCode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认销毁" }));
    expect(client.destroyInviteCode).toHaveBeenCalledWith("invite-2");
  });

  it("keeps invite code search and status filters together and separates time from actions", async () => {
    const client = apiClient as typeof apiClient & {
      listInviteCodes: (filters?: { q?: string; status?: string }) => Promise<unknown[]>;
    };
    vi.spyOn(apiClient, "listUsers").mockResolvedValue([]);
    vi.spyOn(client, "listInviteCodes").mockResolvedValue([
      {
        id: "invite-1",
        code: "PT-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
        status: "active",
        createdByEmail: "owner",
        usedByEmail: null,
        createdAt: "2026-06-10T14:00:01",
        usedAt: null,
        destroyedAt: null
      }
    ]);

    render(<AppShell user={{ email: "owner", role: "admin", quota: 1000 }} activeModule="config-users" />);

    expect(await screen.findByText("PT-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索邀请码"), { target: { value: "PT-" } });
    expect(client.listInviteCodes).toHaveBeenLastCalledWith({ q: "PT-", status: "all" });

    fireEvent.change(screen.getByLabelText("筛选邀请码状态"), { target: { value: "active" } });
    expect(client.listInviteCodes).toHaveBeenLastCalledWith({ q: "PT-", status: "active" });

    const row = screen.getByText("PT-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef").closest("[class*='inviteTableRow']");
    expect(row).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("2026-06-10 14:00:01").className).toContain("inviteTimeCell");
    expect(within(row as HTMLElement).getByRole("button", { name: "销毁邀请码 PT-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef" }).closest("[class*='inviteActionCell']")).toBeInTheDocument();
  });
});

it("keeps the newest invite filter response and cancels destruction on Escape", async () => {
  const invite = { id: "invite-latest", code: "PT-LATEST-FILTER", status: "active" as const, createdByEmail: "admin", usedByEmail: null, createdAt: "2026-10-01T00:00:00Z", usedAt: null, destroyedAt: null };
  vi.spyOn(apiClient, "listUsers").mockResolvedValue([]);
  let finishOld!: (value: typeof invite[]) => void;
  vi.spyOn(apiClient, "listInviteCodes").mockImplementation(async filters => {
    if (filters?.q === "old") return new Promise(resolve => { finishOld = resolve; });
    return filters?.q === "latest" ? [invite] : [];
  });
  const destroy = vi.spyOn(apiClient, "destroyInviteCode");
  render(<AppShell user={{ email: "admin", role: "admin", quota: 100 }} activeModule="config-users" />);
  fireEvent.change(screen.getByLabelText("搜索邀请码"), { target: { value: "old" } });
  fireEvent.change(screen.getByLabelText("搜索邀请码"), { target: { value: "latest" } });
  await screen.findByText(invite.code);
  await act(async () => finishOld([{ ...invite, id: "old", code: "PT-STALE-FILTER" }]));
  expect(screen.getByText(invite.code)).toBeInTheDocument();
  expect(screen.queryByText("PT-STALE-FILTER")).not.toBeInTheDocument();
  const trigger = screen.getByRole("button", { name: `销毁邀请码 ${invite.code}` });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "销毁邀请码确认" })).toHaveAttribute("aria-modal", "true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(destroy).not.toHaveBeenCalled();
});
