import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Download, Search, UserRound, X } from "lucide-react";
import { GALLERY_TAGS } from "@paintopia/shared";
import css from "./Works.module.css";
import { apiClient, type GalleryItem } from "../lib/apiClient";
import { artMeta, dayLabel } from "../lib/artMeta";
import { Viewer, type ViewerItem } from "../components/Viewer";
import { Enso } from "../features/create/Enso";
import { galleryStatusLabel } from "./GalleryReviewConfig";
import { useMediaFeed } from "../lib/useMediaFeed";
import { feedThumbnail, feedThumbnailFallback } from "../lib/thumbnail";
import { useGalleryTags } from "../lib/galleryTags";
import { GalleryTagMenu } from "./GalleryTagMenu";

/** 常驻快捷标签；没有作品时同样隐藏，其余在用标签进「更多标签」。 */
export const galleryQuickTags = ["architecture", "city", "dreamcore", "portrait"].map(id => GALLERY_TAGS.find(tag => tag.id === id)!);

const COLUMN_QUERIES = [["(max-width: 760px)", 2], ["(max-width: 1100px)", 3]] as const;

function columnsFor() {
  if (typeof matchMedia !== "function") return 4;
  return COLUMN_QUERIES.find(([query]) => matchMedia(query).matches)?.[1] ?? 4;
}

export function GalleryView({ account, canManage, onUsePrompt }: { account: string; canManage: boolean; onUsePrompt: (prompt: string) => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const tags = useGalleryTags();
  const [tagCounts, setTagCounts] = useState<Record<string, number>>({});
  const [viewer, setViewer] = useState<{ index: number; origin: DOMRect | null } | null>(null);
  const { items, setItems, loading, error, hasMore, loadMore, reload, sentinel } = useMediaFeed<GalleryItem>("gallery", account, query, category);
  const [columnCount, setColumnCount] = useState(columnsFor);

  useEffect(() => {
    let live = true;
    apiClient.listGalleryTagUsage().then(counts => { if (live) setTagCounts(counts); }, () => undefined);
    return () => { live = false; };
  }, [account]);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const lists = COLUMN_QUERIES.map(([query]) => matchMedia(query));
    const update = () => setColumnCount(columnsFor());
    lists.forEach(list => list.addEventListener("change", update));
    return () => lists.forEach(list => list.removeEventListener("change", update));
  }, []);

  // 按累计高度分列，保持阅读顺序大致自上而下
  const columns = useMemo(() => {
    const next: { item: GalleryItem; index: number }[][] = Array.from({ length: columnCount }, () => []);
    const heights = Array(columnCount).fill(0);
    items.forEach((item, index) => {
      const column = heights.indexOf(Math.min(...heights));
      next[column].push({ item, index });
      heights[column] += (item.width && item.height ? item.height / item.width : 1) + 0.3;
    });
    return next;
  }, [items, columnCount]);

  const unsync = async (item: GalleryItem) => {
    await apiClient.unsyncAssetFromGallery(item.assetId);
    setItems(value => value.filter(candidate => candidate.id !== item.id));
    setViewer(null);
  };

  const viewerItems: ViewerItem[] = items.map(item => ({
    id: item.id,
    imageUrl: item.imageUrl,
    thumbnailUrl: feedThumbnail(item),
    prompt: item.prompt,
    author: item.authorName ?? "佚名",
    date: dayLabel(item.createdAt),
    meta: artMeta(item),
    tags: item.tags?.map(tag => tag.label),
    downloadUrl: `/api/gallery/${encodeURIComponent(item.id)}/download`
  }));
  const quickTags = galleryQuickTags.filter(tag => tagCounts[tag.id]);
  const moreTags = tags.filter(tag => tagCounts[tag.id] && !quickTags.includes(tag));
  const selectedMore = category === "all" || quickTags.some(tag => tag.id === category) ? undefined : tags.find(tag => tag.id === category);

  return (
    <div className={css.page}>
      <header className={css.head}>
        <div><h1>画廊</h1><p>众人落笔，各成一境</p></div>
        <div className={css.galleryTools}>
          <label className={css.search}>
            <Search size={15} aria-hidden="true" />
            <input aria-label="画廊关键词" placeholder="搜索提示词或标签" value={query} onChange={event => setQuery(event.target.value)} />
            {query ? <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={14} aria-hidden="true" /></button> : null}
          </label>
        </div>
      </header>

      <div className={css.tags}>
        <button type="button" className={css.tag} aria-pressed={category === "all"} onClick={() => setCategory("all")}>全部</button>
        {quickTags.map(tag => (
          <button key={tag.id} type="button" className={css.tag} aria-pressed={tag.id === category} onClick={() => setCategory(tag.id)}>{tag.label}</button>
        ))}
        <GalleryTagMenu tags={moreTags} counts={tagCounts} selected={selectedMore} onSelect={setCategory} />
      </div>

      {items.length === 0 ? (
        <div className={css.empty} data-loading={loading && !error ? "" : undefined}>
          <Enso variant={error ? "broken" : "still"} />
          <span>{error || (loading ? "正在展卷…" : "暂无画廊图片")}</span>
          {!error && !loading ? <p>在“我的”里投稿作品，审核通过后会挂在这里。</p> : null}
        </div>
      ) : (
        <div className={`${css.galleryGrid} ${css.galleryMasonry}`} style={{ "--cols": columnCount } as CSSProperties} data-testid="gallery-masonry" data-column-count={columnCount}>
          {columns.map((column, columnIndex) => (
            <div className={css.galleryColumn} data-testid="gallery-column" key={columnIndex}>
              {column.map(({ item, index }) => (
                <article key={item.id} className={css.galleryCard} style={{ "--i": index } as CSSProperties} data-testid="gallery-masonry-item">
                  <button type="button" className={css.open} aria-label="查看画廊完整图片"
                    onClick={event => setViewer({ index, origin: event.currentTarget.getBoundingClientRect() })}>
                    <img className={css.galleryImage} src={feedThumbnail(item)}
                      onError={feedThumbnailFallback(item)} width={item.width ?? undefined} height={item.height ?? undefined} alt="画廊图片" loading={index < 8 ? "eager" : "lazy"} decoding="async" />
                  </button>
                  {item.status !== "approved" ? <span className={css.badge} data-status={item.status}>{galleryStatusLabel(item.status)}</span> : null}
                  <div className={css.tools}>
                    <a href={`/api/gallery/${encodeURIComponent(item.id)}/download`} download aria-label="下载画廊图片" title="下载"><Download size={15} aria-hidden="true" /></a>
                    {canManage ? <button type="button" aria-label="取消同步到画廊" title="撤下" onClick={() => void unsync(item)}><X size={15} aria-hidden="true" /></button> : null}
                  </div>
                  <div className={css.cap}>
                    <div className={css.who} aria-label={`作者 ${item.authorName ?? "未知作者"}`}><UserRound size={12} aria-hidden="true" /><span>{item.authorName ?? "未知作者"}</span></div>
                    <div className={css.what} data-tooltip={item.prompt}><p>{item.prompt}</p></div>
                    {item.tags?.length ? <div className={css.capTags} aria-label="作品标签">
                      {item.tags.map(tag => <button type="button" key={tag.id} aria-label={`按标签筛选：${tag.label}`} onClick={() => setCategory(tag.id)}>{tag.label}</button>)}
                    </div> : null}
                  </div>
                </article>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className={css.foot}>
        {error && items.length ? <p role="alert">{error}</p> : null}
        {error ? <button type="button" className={css.moreButton} onClick={() => void reload()}>重试</button> : null}
        {hasMore ? <button ref={sentinel} type="button" className={css.moreButton} disabled={loading} onClick={() => void loadMore()}>{loading ? "正在展卷…" : "再看一些"}</button> : null}
      </div>

      {viewer && viewerItems[viewer.index] ? (
        <Viewer title={items[viewer.index].title || "观画"} imageAlt="完整画廊图片" items={viewerItems} index={viewer.index} origin={viewer.origin}
          onIndexChange={index => setViewer({ index, origin: null })} onClose={() => setViewer(null)}
          onReuse={item => onUsePrompt(item.prompt)} />
      ) : null}
    </div>
  );
}
