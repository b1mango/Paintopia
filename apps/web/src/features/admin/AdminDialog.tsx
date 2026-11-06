import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import styles from "./admin.module.css";

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current!;
    const trigger = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus], button:not(:disabled)")?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      dialog.close();
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);
  return ref;
}

export function AdminDrawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const dirty = useRef(false);
  useEffect(() => { if (open) dirty.current = false; }, [open]);
  function close() {
    if (dirty.current && !window.confirm("有未保存的修改，确认关闭并放弃这些修改？")) return;
    onClose();
  }
  const ref = useDialog(open, close);
  return <dialog ref={ref} className={styles.drawer} aria-modal="true" aria-label={title} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header className={styles.drawerHeader}><h2>{title}</h2><button className={styles.iconButton} type="button" aria-label="关闭编辑窗口" onClick={close}><X size={18} /></button></header>
    <div className={styles.drawerBody} onChange={() => { dirty.current = true; }} onInput={() => { dirty.current = true; }}>{children}</div>
  </dialog>;
}

export function ConfirmDialog({ label, title, children, busy, onCancel, onConfirm, confirmLabel = "确认删除" }: {
  label: string; title: string; children: ReactNode; busy: boolean; onCancel: () => void; onConfirm: () => void; confirmLabel?: string;
}) {
  const descriptionId = useId();
  const close = () => { if (!busy) onCancel(); };
  const ref = useDialog(true, close);
  return <dialog ref={ref} className={styles.confirmDialog} aria-modal="true" aria-label={label} aria-describedby={descriptionId} aria-busy={busy} onCancel={event => { event.preventDefault(); close(); }}>
    <span className={styles.confirmSeal} aria-hidden="true">慎</span><h2>{title}</h2><div id={descriptionId} className={styles.confirmDescription}>{children}</div>
    <div className={styles.formActionRow}><button className={styles.secondaryAction} type="button" data-autofocus disabled={busy} onClick={onCancel}>取消</button><button className={styles.dangerAction} type="button" disabled={busy} onClick={onConfirm}>{busy ? "处理中…" : confirmLabel}</button></div>
  </dialog>;
}
