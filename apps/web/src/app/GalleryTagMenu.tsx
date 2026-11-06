import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { GALLERY_TAG_GROUPS, type GalleryTag } from "@paintopia/shared";
import css from "./Works.module.css";

type Props = {
  tags: readonly GalleryTag[];
  counts: Record<string, number>;
  /** 当前选中的标签不在这一组里时为 undefined。 */
  selected?: GalleryTag;
  onSelect: (tagId: string) => void;
};

/** 画廊「更多标签」浮层：挂到 body 上，避免被手机端横向滚动的标签栏裁掉。 */
export function GalleryTagMenu({ tags, counts, selected, onSelect }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(380, window.innerWidth - 24);
    setPosition({ top: rect.bottom + 8, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>("button[aria-pressed='true'], button")?.focus();
    const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(true); };
    const onScroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    const onResize = () => close(false);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  if (!tags.length && !selected) return null;
  const groups = GALLERY_TAG_GROUPS
    .map(group => ({ ...group, tags: tags.filter(tag => tag.group === group.id) }))
    .filter(group => group.tags.length);

  return <>
    <button ref={trigger} type="button" className={css.tag} data-more="" aria-pressed={Boolean(selected)}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      {selected ? selected.label : "更多标签"}
      <ChevronDown size={13} aria-hidden="true" className={css.moreChevron} data-open={open || undefined} />
    </button>
    {open ? createPortal(
      <div ref={panel} id={id} role="dialog" aria-label="更多画廊标签" className={css.tagMenu} style={position}>
        {groups.map(group => <section key={group.id} aria-label={group.label}>
          <h3>{group.label}</h3>
          <div>
            {group.tags.map(tag => <button key={tag.id} type="button" aria-pressed={tag.id === selected?.id} aria-label={`${tag.label}，${counts[tag.id]} 幅`}
              onClick={() => { onSelect(tag.id === selected?.id ? "all" : tag.id); setOpen(false); trigger.current?.focus(); }}>
              {tag.label}<small aria-hidden="true">{counts[tag.id]}</small>
            </button>)}
          </div>
        </section>)}
      </div>,
      document.body
    ) : null}
  </>;
}
