import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, KeyRound, LoaderCircle } from "lucide-react";
import { apiClient } from "../../lib/apiClient";
import { clearMediaCache } from "../../lib/useMediaFeed";
import styles from "./ChangePassword.module.css";

export function ChangePassword({ id: regionId, onCancel }: { id?: string; onCancel?: () => void } = {}) {
  const id = useId();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const pending = useRef(false);
  const currentInput = useRef<HTMLInputElement>(null);
  const newInput = useRef<HTMLInputElement>(null);
  const confirmationInput = useRef<HTMLInputElement>(null);

  // 展开即可输入；收起由父组件卸载本组件，输入内容随之丢弃。
  const collapsible = Boolean(onCancel);
  useEffect(() => { if (collapsible) currentInput.current?.focus(); }, [collapsible]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || changed) return;
    setError("");
    if (!currentPassword) { setError("请输入当前密码"); currentInput.current?.focus(); return; }
    if (newPassword.length < 6 || newPassword.length > 128) { setError("新密码请输入 6–128 位"); newInput.current?.focus(); return; }
    if (newPassword === currentPassword) { setError("新密码不能与当前密码相同"); newInput.current?.focus(); return; }
    if (newPassword !== confirmation) { setError("两次输入的新密码不一致，请重新确认"); confirmationInput.current?.focus(); return; }
    pending.current = true;
    setBusy(true);
    try {
      await apiClient.changePassword({ currentPassword, newPassword });
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
      clearMediaCache();
      setChanged(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "密码未修改，请重试");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <section id={regionId} className={styles.section}>
    {changed ? <div className={styles.success}>
      <p role="status"><Check size={16} aria-hidden="true" />密码已修改，所有设备均已退出登录。</p>
      <a className={styles.button} href="/login">使用新密码登录</a>
    </div> : <form onSubmit={event => void submit(event)} aria-label="修改密码" aria-busy={busy} noValidate>
      <p className={styles.note} id={`${id}-hint`}>修改后需在所有设备上重新登录。</p>
      <div className={styles.fields}>
        <label className={styles.field} htmlFor={`${id}-current`}>当前密码
          <input id={`${id}-current`} ref={currentInput} name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required disabled={busy} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
        </label>
        <div className={styles.newFields}>
          <label className={styles.field} htmlFor={`${id}-new`}>新密码
            <input id={`${id}-new`} ref={newInput} name="newPassword" type="password" autoComplete="new-password" minLength={6} maxLength={128} placeholder="6–128 位" required disabled={busy} value={newPassword} onChange={event => setNewPassword(event.target.value)} />
          </label>
          <label className={styles.field} htmlFor={`${id}-confirmation`}>确认新密码
            <input id={`${id}-confirmation`} ref={confirmationInput} name="confirmation" type="password" autoComplete="new-password" minLength={6} maxLength={128} required disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
          </label>
        </div>
      </div>
      <p className={styles.feedback} role={error ? "alert" : "status"} aria-live="polite" id={`${id}-feedback`}>{error}</p>
      <div className={styles.actions}>
        <button className={styles.button} type="submit" disabled={busy} aria-busy={busy} aria-describedby={`${id}-hint ${id}-feedback`}>
          {busy ? <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
          {busy ? "保存中…" : "保存新密码"}
        </button>
        {onCancel ? <button className={styles.cancel} type="button" disabled={busy} onClick={onCancel}>取消</button> : null}
      </div>
    </form>}
  </section>;
}
