import { useEffect, useId, useRef } from 'react';
import styles from './PromptApplyDialog.module.css';

export interface PromptApplyDialogProps {
  currentPrompt: string;
  incomingPrompt: string;
  onApply: (text: string) => void;
  onClose: () => void;
}

/** Mount to open; onClose should unmount. Applying calls onApply before onClose. */
export function PromptApplyDialog({ currentPrompt, incomingPrompt, onApply, onClose }: PromptApplyDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    const element = dialog.current!;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settled.current = false;
    element.showModal();
    cancel.current?.focus();
    return () => {
      settled.current = true;
      element.close();
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  function finish(text?: string) {
    if (settled.current) return;
    settled.current = true;
    dialog.current?.close();
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
    if (text !== undefined) onApply(text);
    onClose();
  }

  function apply(mode: 'replace' | 'append') {
    if (!incomingPrompt.trim()) return;
    const text = mode === 'append' && currentPrompt.trim()
      ? currentPrompt.trimEnd() + '\n\n' + incomingPrompt.trimStart()
      : incomingPrompt;
    finish(text);
  }

  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); finish(); }} onClose={() => { if (!dialog.current?.open) finish(); }}>
      <header className={styles.header}>
        <h2 id={titleId}>使用所选提示词</h2>
        <p id={descriptionId}>替换当前内容，或将所选提示词追加到末尾。</p>
      </header>
      <div className={styles.body}>
        <label className={styles.field}>当前提示词
          <textarea readOnly value={currentPrompt} rows={4} placeholder="当前还没有提示词" />
        </label>
        <label className={styles.field}>所选提示词
          <textarea readOnly value={incomingPrompt} rows={5} placeholder="所选提示词为空" />
        </label>
        {!incomingPrompt.trim() && <p className={styles.notice} role="status">所选提示词为空，请取消后重新选择。</p>}
      </div>
      <footer className={styles.footer}>
        <button ref={cancel} type="button" onClick={() => finish()}>取消</button>
        <div className={styles.actions}>
          <button type="button" disabled={!incomingPrompt.trim()} onClick={() => apply('append')}>追加到末尾</button>
          <button type="button" className={styles.primary} disabled={!incomingPrompt.trim()} onClick={() => apply('replace')}>替换当前内容</button>
        </div>
      </footer>
    </dialog>
  );
}
