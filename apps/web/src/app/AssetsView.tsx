import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Download, GalleryHorizontalEnd, LoaderCircle, Sparkles, Trash2, Undo2, UserRound } from "lucide-react";
import { justifiedLayout } from "../lib/justifiedLayout";
import { useMediaFeed } from "../lib/useMediaFeed";
import { feedThumbnail, feedThumbnailFallback } from "../lib/thumbnail";
import { apiClient, type GeneratedAsset } from "../lib/apiClient";
import { artMeta, dayLabel } from "../lib/artMeta";
import { Viewer, type ViewerItem } from "../components/Viewer";
import { Enso } from "../features/create/Enso";
import { promptLibraryApi } from "../features/prompts/promptLibraryApi";
import css from "./Works.module.css";
import { galleryStatusLabel } from "./GalleryReviewConfig";
import { formatDateTime } from "./formatters";

type Action = "share" | "withdraw" | "delete" | "curate";

const isShared = (item: GeneratedAsset) => Boolean(item.galleryItemId || item.galleryStatus || item.gallerySynced);

export function AssetsView({ refreshKey, showOwner, account, canCurate = false, onReuse, onUseAsReference }: {
  refreshKey: number; showOwner: boolean; account: string;
  /** 管理员可把作品连同提示词加入灵感页「站主推荐」。 */
  canCurate?: boolean;
  onReuse?: (asset: GeneratedAsset) => void;
  onUseAsReference?: (asset: GeneratedAsset) => void;
}) {
  const { items, setItems, loading, error, hasMore, loadMore, reload, sentinel } = useMediaFeed<GeneratedAsset>("assets", account, "", "all", refreshKey);
  const [actions, setActions] = useState<Record<string, Action>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(1000);
  const [dimensions, setDimensions] = useState<Record<string, number>>({});
  const [viewer, setViewer] = useState<{ index: number; origin: DOMRect | null } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const update = () => { if (element.clientWidth > 0) setGridWidth(element.clientWidth); };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [items.length > 0]);

  const layout = useMemo(() => justifiedLayout(items.map(item =>
    item.width && item.height ? item.width / item.height : dimensions[item.id] ?? 1
  ), gridWidth), [items, dimensions, gridWidth]);

  const perform = async (asset: GeneratedAsset, action: Action) => {
    if (inFlight.current.has(asset.id)) return;
    inFlight.current.add(asset.id);
    setActions(current => ({ ...current, [asset.id]: action }));
    setErrors(current => ({ ...current, [asset.id]: "" }));
    try {
      if (action === "delete") {
        await apiClient.deleteAsset(asset.id);
        setItems(current => current.filter(item => item.id !== asset.id));
        setDeleteId(null);
        setViewer(null);
      } else if (action === "curate") {
        const curated = await promptLibraryApi.curate(asset.id);
        setItems(current => current.map(item => item.id === asset.id ? { ...item, curatedPromptId: curated.id } : item));
      } else if (action === "share") {
        const gallery = await apiClient.syncAssetToGallery(asset.id);
        setItems(current => current.map(item => item.id === asset.id ? {
          ...item, gallerySynced: true, galleryItemId: gallery.id, galleryStatus: gallery.status
        } : item));
      } else {
        const result = await apiClient.unsyncAssetFromGallery(asset.id);
        setItems(current => current.map(item => item.id === asset.id ? {
          ...item, gallerySynced: false, galleryItemId: null, galleryStatus: null,
          expiresAt: result.expiresAt
        } : item));
      }
    } catch (error) {
      setErrors(current => ({ ...current, [asset.id]: error instanceof Error ? error.message : "操作失败，请重试" }));
    } finally {
      inFlight.current.delete(asset.id);
      setActions(current => {
        const next = { ...current };
        delete next[asset.id];
        return next;
      });
    }
  };

  const viewerItems: ViewerItem[] = items.map(item => ({
    id: item.id,
    imageUrl: item.imageUrl,
    thumbnailUrl: feedThumbnail(item),
    prompt: item.prompt,
    author: showOwner ? item.ownerEmail ?? item.ownerName : undefined,
    date: dayLabel(item.createdAt),
    meta: artMeta(item),
    downloadUrl: `/api/assets/${encodeURIComponent(item.id)}/download`
  }));
  const assetOf = (item: ViewerItem) => items.find(asset => asset.id === item.id)!;
  const deleting = items.find(item => item.id === deleteId);

  return (
    <div className={css.page}>
      <header className={css.head}>
        <div><h1>我的</h1><p>落笔所得，皆在此处 · 投稿经审核后挂入画廊</p></div>
      </header>

      {items.length === 0 ? (
        <div className={css.empty} data-loading={loading && !error ? "" : undefined}>
          <Enso variant={error ? "broken" : "still"} />
          <span>{error || (loading ? "正在展卷…" : "暂无生成资产")}</span>
          {!error && !loading ? <p>去「创作」落下第一笔吧。</p> : null}
        </div>
      ) : (
        <div ref={gridRef} className={css.assetGrid} aria-label="我的资产图片">
          {items.map((item, index) => {
            const action = actions[item.id];
            const shared = isShared(item);
            const shareLabel = shared ? "取消同步到画廊" : "同步到画廊";
            const owner = item.ownerEmail ?? item.ownerName ?? "未知用户";
            return (
              <article key={item.id} className={css.assetCard} data-asset-id={item.id} style={{ width: layout[index]?.width, "--i": index } as CSSProperties}>
                <button type="button" className={css.open} aria-label="查看资产完整图片" style={{ height: layout[index]?.height }}
                  onClick={event => setViewer({ index, origin: event.currentTarget.getBoundingClientRect() })}>
                  <img src={feedThumbnail(item)}
                    onError={feedThumbnailFallback(item)}
                    onLoad={event => { const img = event.currentTarget; if ((!item.width || !item.height) && img.naturalWidth && img.naturalHeight) setDimensions(current => ({ ...current, [item.id]: img.naturalWidth / img.naturalHeight })); }}
                    width={item.width ?? undefined} height={item.height ?? undefined} alt="生成资产" loading={index < 6 ? "eager" : "lazy"} decoding="async" />
                </button>
                <div className={css.assetMeta}>
                  {showOwner ? <div className={css.owner} aria-label={"所属用户 " + owner}><UserRound size={13} aria-hidden="true" /><span>{owner}</span></div> : null}
                  <p className={css.prompt} title={item.prompt}>{item.prompt || "未填写提示词"}</p>
                  <div className={css.assetMetaFooter}>
                    <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                    <span className={css.state} data-status={item.galleryStatus ?? "private"}>{item.galleryStatus ? galleryStatusLabel(item.galleryStatus) : shared ? "已提交画廊" : "仅自己可见"}</span>
                    {item.expiresAt !== undefined ? <span title={item.expiresAt ? "到期时间：" + formatDateTime(item.expiresAt) : undefined}>{item.expiresAt ? formatDateTime(item.expiresAt).slice(0, 10) + " 到期" : "永久保留"}</span> : null}
                  </div>
                  <div className={css.actions}>
                    <button type="button" className={css.action} aria-label={shareLabel} title={shareLabel} aria-busy={action === "share" || action === "withdraw"} disabled={Boolean(action)} onClick={() => void perform(item, shared ? "withdraw" : "share")}>
                      {action === "share" || action === "withdraw" ? <LoaderCircle size={14} className={css.spinner} aria-hidden="true" /> : shared ? <Undo2 size={14} aria-hidden="true" /> : <GalleryHorizontalEnd size={14} aria-hidden="true" />}
                      <span>{action === "share" ? "正在提交" : action === "withdraw" ? "正在撤回" : shared ? "撤回画廊" : "上传到画廊"}</span>
                    </button>
                    {canCurate ? <button type="button" className={css.action} data-curated={item.curatedPromptId ? "" : undefined} aria-busy={action === "curate"}
                      disabled={Boolean(action) || Boolean(item.curatedPromptId) || !item.prompt}
                      aria-label={item.curatedPromptId ? "已在站主推荐" : "加入站主推荐"} title={item.curatedPromptId ? "已在灵感页站主推荐中，可在灵感页编辑" : item.prompt ? "连同提示词加入灵感页站主推荐" : "没有提示词，无法加入站主推荐"}
                      onClick={() => void perform(item, "curate")}>
                      {action === "curate" ? <LoaderCircle size={14} className={css.spinner} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
                    </button> : null}
                    <a className={css.action} href={"/api/assets/" + encodeURIComponent(item.id) + "/download"} download aria-label="下载资产图片" title="下载图片"><Download size={15} aria-hidden="true" /></a>
                    <button type="button" className={css.action} data-danger disabled={Boolean(action)} aria-label="删除资产" title="删除图片" onClick={() => setDeleteId(item.id)}><Trash2 size={15} aria-hidden="true" /></button>
                  </div>
                  {errors[item.id] ? <p role="alert" className={css.error}>{errors[item.id]}</p> : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className={css.foot}>
        {error && items.length ? <p role="alert">{error}</p> : null}
        {error ? <button type="button" className={css.moreButton} onClick={() => void reload()}>重试</button> : null}
        {hasMore ? <button ref={sentinel} type="button" className={css.moreButton} disabled={loading} onClick={() => void loadMore()}>{loading ? "正在展卷…" : "再看一些"}</button> : null}
      </div>

      {viewer && viewerItems[viewer.index] ? (
        <Viewer title="完整资产图片" imageAlt="完整资产图片" items={viewerItems} index={viewer.index} origin={viewer.origin}
          onIndexChange={index => setViewer({ index, origin: null })} onClose={() => setViewer(null)}
          onReuse={onReuse ? item => onReuse(assetOf(item)) : undefined}
          onUseAsReference={onUseAsReference ? item => onUseAsReference(assetOf(item)) : undefined}
          extraActions={item => {
            const asset = assetOf(item);
            const busy = Boolean(actions[asset.id]);
            return [
              isShared(asset)
                ? { label: actions[asset.id] === "withdraw" ? "正在撤回" : "撤回投稿", icon: <Undo2 size={15} aria-hidden="true" />, disabled: busy, onClick: () => void perform(asset, "withdraw") }
                : { label: actions[asset.id] === "share" ? "正在投稿" : "投稿画廊", icon: <GalleryHorizontalEnd size={15} aria-hidden="true" />, disabled: busy, onClick: () => void perform(asset, "share") },
              ...(canCurate ? [{ label: asset.curatedPromptId ? "已在站主推荐" : actions[asset.id] === "curate" ? "正在加入" : "加入站主推荐", icon: <Sparkles size={15} aria-hidden="true" />, disabled: busy || Boolean(asset.curatedPromptId) || !asset.prompt, onClick: () => void perform(asset, "curate") }] : []),
              { label: "删除", icon: <Trash2 size={15} aria-hidden="true" />, danger: true, disabled: busy, onClick: () => setDeleteId(asset.id) }
            ];
          }} />
      ) : null}
      {deleting ? <AssetDeleteDialog busy={actions[deleting.id] === "delete"} error={errors[deleting.id]} onCancel={() => setDeleteId(null)} onConfirm={() => void perform(deleting, "delete")} /> : null}
    </div>
  );
}

export function AssetDeleteDialog({ busy, error, onCancel, onConfirm }: { busy: boolean; error?: string; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className={css.confirm} aria-label="删除资产确认" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2>删除这张资产？</h2>
      <p>原图及缩略图将被删除，此操作无法撤销。</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className={css.confirmActions}>
        <button type="button" autoFocus disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" data-danger disabled={busy} onClick={onConfirm}>{busy ? "正在删除…" : "确认删除"}</button>
      </div>
    </dialog>
  );
}
