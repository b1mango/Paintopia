import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, ImagePlus, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../lib/useModalFocus";
import styles from "./Viewer.module.css";

export interface ViewerItem {
  id: string;
  imageUrl: string;
  thumbnailUrl?: string;
  prompt: string;
  author?: string;
  date?: string;
  meta?: { label: string; value: string }[];
  tags?: string[];
  downloadUrl?: string;
}

export interface ViewerAction {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface ViewerProps {
  /** Accessible name of the dialog. */
  title: string;
  imageAlt: string;
  items: ViewerItem[];
  index: number;
  /** Rect of the element the viewer opens from; drives the shared-element transition. */
  origin?: DOMRect | null;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
  onReuse?: (item: ViewerItem) => void;
  onUseAsReference?: (item: ViewerItem) => void;
  /** Extra actions under the main ones (e.g. 投稿 / 删除 for owned works). */
  extraActions?: (item: ViewerItem) => ViewerAction[];
}

const EASE = "cubic-bezier(.22,1,.36,1)";

/** 观画：全屏灯箱。缩略图先上，原图到达后无缝替换；从来源元素 FLIP 展开。 */
export function Viewer({ title, imageAlt, items, index, origin, onIndexChange, onClose, onReuse, onUseAsReference, extraActions }: ViewerProps) {
  const dialogRef = useModalFocus<HTMLDivElement>();
  const imageRef = useRef<HTMLImageElement>(null);
  const item = items[index] ?? items[0];
  const [loadedUrl, setLoadedUrl] = useState("");
  const [failedUrl, setFailedUrl] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [open, setOpen] = useState(false);
  const flipped = useRef(false);

  useEffect(() => { const frame = requestAnimationFrame(() => setOpen(true)); return () => cancelAnimationFrame(frame); }, []);
  useEffect(() => { setCopyStatus(""); }, [item?.id]);

  // FLIP：只在首次打开时，从来源缩略图位置展开
  useLayoutEffect(() => {
    if (flipped.current || !origin || !imageRef.current?.animate) return;
    flipped.current = true;
    const target = imageRef.current.getBoundingClientRect();
    if (!target.width || !target.height) return;
    imageRef.current.animate([
      { transform: `translate(${origin.left - target.left}px, ${origin.top - target.top}px) scale(${origin.width / target.width}, ${origin.height / target.height})`, borderRadius: "6px" },
      { transform: "none", borderRadius: "2px" }
    ], { duration: 620, easing: EASE });
  }, [origin]);

  const step = useCallback((direction: 1 | -1) => {
    if (items.length < 2 || !onIndexChange) return;
    const next = (index + direction + items.length) % items.length;
    const image = imageRef.current;
    if (!image?.animate) { onIndexChange(next); return; }
    image.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-direction * 24}px)` }], { duration: 160, easing: "ease-in", fill: "forwards" })
      .onfinish = () => {
        onIndexChange(next);
        requestAnimationFrame(() => imageRef.current?.animate?.([{ opacity: 0, transform: `translateX(${direction * 24}px)` }, { opacity: 1, transform: "none" }], { duration: 420, easing: EASE }));
      };
  }, [index, items.length, onIndexChange]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      else if (event.key === "ArrowRight") step(1);
      else if (event.key === "ArrowLeft") step(-1);
    };
    document.addEventListener("keydown", handler);
    // 预览打开时锁住页面滚动；html 与 body 都要锁，并去掉 html 的滚动条占位，遮罩才能铺满视口
    const root = document.documentElement;
    const previous = [root.style.overflow, root.style.scrollbarGutter, document.body.style.overflow];
    root.style.overflow = "hidden";
    root.style.scrollbarGutter = "auto";
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      [root.style.overflow, root.style.scrollbarGutter, document.body.style.overflow] = previous;
    };
  }, [onClose, step]);

  async function copyPrompt() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(item.prompt);
      setCopyStatus("提示词已复制");
    } catch { setCopyStatus("复制失败，请手动选择提示词复制"); }
  }

  if (!item) return null;
  const showThumb = Boolean(item.thumbnailUrl) && loadedUrl !== item.imageUrl;
  const multiple = items.length > 1 && Boolean(onIndexChange);

  // 挂到 body：页面容器带入场动画（transform），会让 fixed 定位相对它而不是视口
  return createPortal(
    <div ref={dialogRef} className={styles.viewer} data-open={open || undefined} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.stage} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <div className={styles.frame}>
          {showThumb ? <img className={styles.image} src={item.thumbnailUrl} alt="图片快速预览" aria-hidden="true" /> : null}
          <img ref={imageRef} key={item.imageUrl} className={styles.image} data-pending={showThumb || undefined} src={item.imageUrl} alt={imageAlt} decoding="async"
            onLoad={() => setLoadedUrl(item.imageUrl)} onError={() => setFailedUrl(item.imageUrl)} />
        </div>
        {loadedUrl !== item.imageUrl ? <p className={styles.loading} role="status">{failedUrl === item.imageUrl ? "原图加载失败，请关闭后重试" : "正在加载高清原图…"}</p> : null}
        {multiple ? <>
          <button type="button" className={`${styles.nav} ${styles.prev}`} aria-label="上一幅" onClick={() => step(-1)}><ChevronLeft size={22} strokeWidth={1.5} aria-hidden="true" /></button>
          <button type="button" className={`${styles.nav} ${styles.next}`} aria-label="下一幅" onClick={() => step(1)}><ChevronRight size={22} strokeWidth={1.5} aria-hidden="true" /></button>
          <span className={styles.count} aria-live="polite">{String(index + 1).padStart(2, "0")} / {String(items.length).padStart(2, "0")}</span>
        </> : null}
      </div>
      <aside className={styles.side}>
        {item.author || item.date ? <div className={styles.who}>
          {item.author ? <span className={styles.avatar} aria-hidden="true">{Array.from(item.author)[0]?.toUpperCase()}</span> : null}
          {item.author ? <span>{item.author}</span> : null}
          {item.author && item.date ? <span aria-hidden="true">·</span> : null}
          {item.date ? <span>{item.date}</span> : null}
        </div> : null}
        <h2 className="sr-only">{title}</h2>
        <p className={styles.poem}>{item.prompt || "（未留题跋）"}</p>
        {item.meta?.length ? <>
          <span className={styles.line} aria-hidden="true" />
          <dl className={styles.meta}>{item.meta.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </> : null}
        {item.tags?.length ? <ul className={styles.tags} aria-label="标签">{item.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul> : null}
        <div className={styles.actions}>
          {onReuse ? <button type="button" className={styles.primary} onClick={() => onReuse(item)}>以此为本 · 再绘一幅</button> : null}
          <div className={styles.row}>
            {item.downloadUrl ? <a className={styles.action} href={item.downloadUrl} download aria-label="下载图片"><Download size={15} aria-hidden="true" />下载</a> : null}
            <button type="button" className={styles.action} onClick={() => void copyPrompt()}><Copy size={15} aria-hidden="true" />复制提示词</button>
            {onUseAsReference ? <button type="button" className={styles.action} onClick={() => onUseAsReference(item)}><ImagePlus size={15} aria-hidden="true" />作参考</button> : null}
          </div>
          {extraActions ? <div className={styles.row}>
            {extraActions(item).map((action) => <button key={action.label} type="button" className={`${styles.action} ${action.danger ? styles.danger : ""}`} disabled={action.disabled} onClick={action.onClick}>{action.icon}{action.label}</button>)}
          </div> : null}
          {copyStatus ? <p className={styles.status} role="status">{copyStatus}</p> : null}
        </div>
      </aside>
      <button type="button" className={styles.close} title="关闭预览（Esc）" aria-label="关闭预览" onClick={onClose}><X size={20} strokeWidth={1.5} aria-hidden="true" /></button>
    </div>,
    document.body,
  );
}
