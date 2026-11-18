import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import styles from "./admin.module.css";

const activeDialogs: HTMLDialogElement[] = [];

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current!;
    const trigger = document.activeElement as HTMLElement | null;
    const lockBody = activeDialogs.length === 0;
    const overflow = document.body.style.overflow;
    if (lockBody) document.body.style.overflow = "hidden";
    activeDialogs.push(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus], button:not(:disabled)")?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (activeDialogs[activeDialogs.length - 1] !== dialog) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      const index = activeDialogs.lastIndexOf(dialog);
      if (index !== -1) activeDialogs.splice(index, 1);
      dialog.close();
      if (lockBody) document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);
  return ref;
}

export function AdminDrawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const dirty = useRef(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  useEffect(() => {
    if (open) {
      dirty.current = false;
      setConfirmDiscardOpen(false);
    }
  }, [open]);

  function requestClose() {
    if (dirty.current) {
      setConfirmDiscardOpen(true);
      return;
    }
    onClose();
  }

  function discardAndClose() {
    dirty.current = false;
    setConfirmDiscardOpen(false);
    onClose();
  }

  const ref = useDialog(open, requestClose);
  return (
    <>
      <dialog
        ref={ref}
        className={styles.drawer}
        aria-modal="true"
        aria-label={title}
        onCancel={(event) => { event.preventDefault(); requestClose(); }}
        onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}
      >
        <header className={styles.drawerHeader}>
          <h2>{title}</h2>
          <button className={styles.iconButton} type="button" aria-label="关闭编辑窗口" onClick={requestClose}>
            <X size={18} />
          </button>
        </header>
        <div
          className={styles.drawerBody}
          onChange={() => { dirty.current = true; }}
          onInput={() => { dirty.current = true; }}
        >
          {children}
        </div>
      </dialog>
      {open && confirmDiscardOpen ? (
        <ConfirmDialog
          label="放弃未保存修改"
          title="放弃未保存的修改"
          confirmLabel="放弃修改"
          busy={false}
          onCancel={() => setConfirmDiscardOpen(false)}
          onConfirm={discardAndClose}
        >
          有未保存的修改，确认关闭并放弃这些修改？
        </ConfirmDialog>
      ) : null}
    </>
  );
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
