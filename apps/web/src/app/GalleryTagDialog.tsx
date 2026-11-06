import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, Search, X } from "lucide-react";
import { GALLERY_TAG_GROUPS, MAX_GALLERY_TAGS, type GalleryTag } from "@paintopia/shared";
import type { GalleryItem } from "../lib/apiClient";
import { useModalFocus } from "../lib/useModalFocus";
import { createGalleryTag, useGalleryTags } from "../lib/galleryTags";

const TAG_LABEL_MAX = 20;
import styles from "./GalleryReviewConfig.module.css";

export function GalleryTagDialog({ item, onSave, onClose }: {
  item: GalleryItem; onSave: (tagIds: string[]) => Promise<void>; onClose: () => void;
}) {
  const ref = useModalFocus();
  const tags = useGalleryTags();
  const [newGroup, setNewGroup] = useState<GalleryTag["group"]>("subject");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(() => item.tags?.map(tag => tag.id) ?? []);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  const [imageAttempt, setImageAttempt] = useState(0);
  const publishing = item.status === "pending";
  const term = query.trim().toLocaleLowerCase();
  const matches = tags.filter(tag => [tag.label, tag.id, ...tag.aliases].some(value => value.toLocaleLowerCase().includes(term)));
  const newLabel = query.trim();
  // 精确同名（含英文别名）时不提示新建，直接从列表里选
  const canCreate = Boolean(term) && !tags.some(tag => [tag.label, tag.id, ...tag.aliases].some(value => value.toLocaleLowerCase() === term));
  const labelOf = (id: string) => tags.find(tag => tag.id === id)?.label ?? item.tags?.find(tag => tag.id === id)?.label ?? id;
  useEffect(() => {
    const handle = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", handle);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", handle); document.body.style.overflow = previous; };
  }, [busy, onClose]);
  const toggle = (id: string) => {
    if (busy) return;
    setError("");
    setSelected(values => values.includes(id) ? values.filter(value => value !== id) : values.length < MAX_GALLERY_TAGS ? [...values, id] : values);
  };
  const create = async () => {
    if (busy || creating || newLabel.length > TAG_LABEL_MAX) return;
    setCreating(true); setError("");
    try {
      const tag = await createGalleryTag(newLabel, newGroup);
      setSelected(values => values.includes(tag.id) || values.length >= MAX_GALLERY_TAGS ? values : [...values, tag.id]);
      setQuery("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建标签失败，请重试"); }
    finally { setCreating(false); }
  };
  const save = async () => {
    if (busy || !selected.length) return;
    setBusy(true); setError("");
    try { await onSave(selected); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  };
  return createPortal(
    <div className={styles.backdrop}>
      <div ref={ref} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="gallery-tag-title" aria-describedby="gallery-tag-description" aria-busy={busy}>
        <header className={styles.dialogHeader}>
          <div><h2 id="gallery-tag-title">{publishing ? "确认标签并发布" : "编辑作品标签"}</h2><p id="gallery-tag-description">选择 1–{MAX_GALLERY_TAGS} 个标签，帮助大家找到这件作品。</p></div>
          <button className={styles.close} type="button" aria-label="关闭标签编辑" disabled={busy} onClick={onClose}><X size={20} /></button>
        </header>
        <div className={styles.dialogBody}>
          <div className={styles.preview}>
            <div className={styles.imageFrame}>
              {!imageFailed ? <img key={imageAttempt} src={item.thumbnailUrl ?? item.imageUrl} alt="待标注作品完整预览" onError={() => setImageFailed(true)} /> : <div role="status">图片加载失败<button type="button" onClick={() => { setImageFailed(false); setImageAttempt(value => value + 1); }}>重试图片</button></div>}
            </div>
            <p className={styles.author}>{item.authorName ?? "未知作者"}</p>
            <details><summary>查看提示词</summary><p>{item.prompt}</p></details>
          </div>
          <div className={styles.editor}>
            <label className={styles.search}><Search size={16} /><input aria-label="搜索标签" placeholder="搜索标签名称或英文别名" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <div className={styles.selectionHeader}><strong>已选标签</strong><span aria-live="polite">{selected.length} / {MAX_GALLERY_TAGS}</span></div>
            <div className={styles.selectedTags}>
              {selected.length ? selected.map(id => <button type="button" key={id} disabled={busy} aria-label={`移除标签 ${labelOf(id)}`} onClick={() => toggle(id)}>{labelOf(id)}<X size={13} /></button>) : <p>先选择至少一个标签</p>}
            </div>
            {selected.length === MAX_GALLERY_TAGS ? <p className={styles.hint}>已选满 {MAX_GALLERY_TAGS} 个，可先移除再选择。</p> : null}
            {GALLERY_TAG_GROUPS.map(group => {
              const tags = matches.filter(tag => tag.group === group.id);
              return tags.length ? <fieldset key={group.id} className={styles.group}><legend>{group.label}</legend><div className={styles.choices}>{tags.map(tag => {
                const checked = selected.includes(tag.id);
                const unavailable = busy || (!checked && selected.length >= MAX_GALLERY_TAGS);
                return <label key={tag.id} className={styles.choice} data-checked={checked} data-unavailable={unavailable}><input type="checkbox" checked={checked} aria-disabled={unavailable} onChange={() => toggle(tag.id)} /><Check size={14} aria-hidden="true" /><span>{tag.label}</span></label>;
              })}</div></fieldset> : null;
            })}
            {canCreate ? <div className={styles.createTag}>
              <p>{matches.length ? "没有完全同名的标签，" : "没有匹配的标签，"}可以新建「<strong>{newLabel}</strong>」</p>
              <div className={styles.createRow}>
                <div role="radiogroup" aria-label="新标签分组" className={styles.groupPick}>
                  {GALLERY_TAG_GROUPS.map(group => <button key={group.id} type="button" role="radio" aria-checked={newGroup === group.id} disabled={creating} onClick={() => setNewGroup(group.id)}>{group.label}</button>)}
                </div>
                <button type="button" className={styles.createButton} disabled={busy || creating || newLabel.length > TAG_LABEL_MAX} onClick={() => void create()}><Plus size={14} aria-hidden="true" />{creating ? "正在创建…" : "新建并选中"}</button>
              </div>
              {newLabel.length > TAG_LABEL_MAX ? <p className={styles.hint}>标签名最多 {TAG_LABEL_MAX} 个字。</p> : null}
            </div> : null}
            {error ? <p role="alert" className={styles.error}>{error}</p> : null}
          </div>
        </div>
        <footer className={styles.dialogFooter}>
          <span>{publishing ? "确认后作品将公开展示，图片永久保留。" : "保存后将更新画廊中的标签。"}</span>
          <div><button type="button" disabled={busy} onClick={onClose}>取消</button><button className={styles.primary} type="button" disabled={busy || selected.length === 0} onClick={() => void save()}>{busy ? "正在保存…" : publishing ? "确认标签并发布" : "保存标签"}</button></div>
        </footer>
      </div>
    </div>, document.body
  );
}
