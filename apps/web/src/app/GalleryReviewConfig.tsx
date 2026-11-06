import { useEffect, useState } from "react";
import { Check, Tags, UserRound, X } from "lucide-react";
import styles from "./AppShell.module.css";
import reviewStyles from "./GalleryReviewConfig.module.css";
import adminStyles from "../features/admin/admin.module.css";
import { apiClient, type GalleryItem } from "../lib/apiClient";
import { clearMediaCache } from "../lib/useMediaFeed";
import { GalleryTagDialog } from "./GalleryTagDialog";
import { AdminState, SectionHeading } from "../features/admin/AdminLayout";

type ReviewTab = "pending" | "untagged" | "approved";
const tabs: { id: ReviewTab; label: string }[] = [
  { id: "pending", label: "待审核" }, { id: "untagged", label: "待补标签" }, { id: "approved", label: "已发布" }
];

export function GalleryReviewConfig() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [tab, setTab] = useState<ReviewTab>("pending");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<GalleryItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(""); setStatus(""); setItems([]);
    apiClient.listGalleryReview(tab === "pending" ? "pending" : "approved")
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? `加载失败：${error.message}` : "加载失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab, revision]);

  const visibleItems = tab === "untagged" ? items.filter(item => !item.tags?.length) : items;
  const saveTags = async (tagIds: string[]) => {
    if (!editing) return;
    const updated = editing.status === "pending"
      ? await apiClient.reviewGalleryItem(editing.id, "approve", undefined, tagIds)
      : await apiClient.updateGalleryTags(editing.id, tagIds);
    clearMediaCache();
    setItems(rows => editing.status === "pending" ? rows.filter(row => row.id !== updated.id) : rows.map(row => row.id === updated.id ? updated : row));
    setStatus(editing.status === "pending" ? "已确认标签并发布" : "标签已保存");
    setEditing(null);
  };
  const reject = async (item: GalleryItem) => {
    setBusyIds(ids => new Set(ids).add(item.id)); setStatus("");
    try {
      await apiClient.reviewGalleryItem(item.id, "reject");
      clearMediaCache();
      setItems(rows => rows.filter(row => row.id !== item.id));
      setStatus("已拒绝");
    } catch (error) { setStatus(error instanceof Error ? `审核失败：${error.message}` : "审核失败"); }
    finally { setBusyIds(ids => { const next = new Set(ids); next.delete(item.id); return next; }); }
  };

  return (
    <div className={adminStyles.stack}>
    <SectionHeading title="画廊审核" description="审核时确认作品内容，并为画廊选择合适的标签。" />
    <section className={reviewStyles.review}>
      <div className={reviewStyles.tabs} aria-label="审核列表">
        {tabs.map(value => <button type="button" key={value.id} aria-pressed={tab === value.id} disabled={busyIds.size > 0} onClick={() => setTab(value.id)}>{value.label}</button>)}
        <span>{loading ? "加载中…" : `${visibleItems.length} 件作品`}</span>
      </div>
      {loading ? <AdminState loading>正在整理待展的作品…</AdminState> : null}
      {loadError ? <AdminState error action={<button type="button" className={reviewStyles.filterSelect} onClick={() => setRevision(value => value + 1)}>重新加载</button>}>{loadError}</AdminState> : null}
      {!loading && !loadError && visibleItems.length === 0 ? <AdminState>{tab === "pending" ? "暂无待审核图片" : tab === "untagged" ? "已发布作品均已添加标签" : "暂无已发布作品"}</AdminState> : null}
      <div className={reviewStyles.grid}>
        {visibleItems.map(item => <article key={item.id} className={reviewStyles.card}>
          <img src={item.thumbnailUrl ?? item.imageUrl} alt="画廊审核图片" loading="lazy" decoding="async" />
          <div className={reviewStyles.meta}>
            <div className={reviewStyles.author}><UserRound size={14} /><span>{item.authorName ?? "未知作者"}</span></div>
            <p className={reviewStyles.prompt}>{item.prompt}</p>
            {item.tags?.length ? <div className={reviewStyles.tagList}>{item.tags.map(tag => <span key={tag.id}>{tag.label}</span>)}</div> : <span className={reviewStyles.hint}>{item.status === "pending" ? "发布前需选择标签" : "尚未添加标签"}</span>}
            <div className={reviewStyles.actions}>
              <button type="button" disabled={busyIds.has(item.id)} onClick={() => setEditing(item)}>{item.status === "pending" ? <Check size={15} /> : <Tags size={15} />}{item.status === "pending" ? "通过并打标签" : item.tags?.length ? "编辑标签" : "补充标签"}</button>
              {item.status === "pending" ? <button type="button" disabled={busyIds.has(item.id)} onClick={() => void reject(item)}><X size={15} />{busyIds.has(item.id) ? "处理中…" : "拒绝"}</button> : null}
            </div>
          </div>
        </article>)}
      </div>
      {status ? <p role="status" className={reviewStyles.message}>{status}</p> : null}
      {editing ? <GalleryTagDialog key={editing.id} item={editing} onSave={saveTags} onClose={() => setEditing(null)} /> : null}
    </section>
    </div>
  );
}

export function galleryStatusLabel(status: GalleryItem["status"]) {
  if (status === "approved") return "已发布";
  if (status === "rejected") return "未通过";
  return "待审核";
}

