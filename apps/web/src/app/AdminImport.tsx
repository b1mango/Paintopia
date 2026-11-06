import { useRef, useState, type DragEvent } from "react";
import { FileUp } from "lucide-react";
import styles from "../features/admin/admin.module.css";

type Plan = { providers: number; jobs: number; assets: number; skippedAssets: number };

async function post(endpoint: string, body: unknown) {
  const r = await fetch(`/api/admin/import/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "导入失败");
  return data;
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function AdminImport() {
  const [file, setFile] = useState<File | null>(null);
  const [ticket, setTicket] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function choose(next: File | null) {
    setFile(next);
    setPlan(null);
    setTicket("");
    setStatus("");
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (!busy) choose(event.dataTransfer.files[0] ?? null);
  }

  async function review() {
    if (!file) return;
    setBusy(true); setPlan(null); setStatus("正在上传并检查导入文件…");
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error("导入文件不能超过 64MB");
      const bytes = await file.arrayBuffer();
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(b => b.toString(16).padStart(2, "0")).join("");
      const upload = await post("upload", { sha256, size: file.size });
      const r = await fetch(upload.url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: bytes });
      if (!r.ok) throw new Error("文件上传失败，请重试");
      setTicket(upload.ticket);
      setPlan(await post("review", { ticket: upload.ticket }));
      setStatus("检查完成。确认后将合并到当前管理员账号。");
    } catch (e) { setStatus(e instanceof Error ? e.message : "检查失败"); }
    finally { setBusy(false); }
  }

  async function apply() {
    setBusy(true); setStatus("正在合并并校验图片，请勿关闭页面…");
    try {
      await post("apply", { ticket });
      setPlan(null); setFile(null); setTicket("");
      if (inputRef.current) inputRef.current.value = "";
      setStatus("导入完成。账号密码、余额和原有资产保持不变；刷新创作页查看结果。");
      window.dispatchEvent(new Event("paintopia:providers-changed"));
    } catch (e) { setStatus(e instanceof Error ? e.message : "导入失败，可检查后重试"); }
    finally { setBusy(false); }
  }

  return <section className={styles.toolCard} aria-busy={busy} aria-labelledby="admin-import-title">
    <header className={styles.toolHead}>
      <span className={styles.toolIndex} aria-hidden="true">壹</span>
      <div><h3 id="admin-import-title">导入本地创作</h3><p>将 Paintopia 导出文件中的接口、创作记录与图片合并到当前管理员账号。同 ID 记录跳过；不导入账号、密码或扣费流水。</p></div>
    </header>
    <label className={styles.filePicker} data-dragging={dragging || undefined} data-filled={file ? true : undefined} data-disabled={busy || undefined}
      onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={handleDrop}>
      <input ref={inputRef} className={styles.visuallyHidden} type="file" accept=".json,application/json" disabled={busy} aria-label="导入文件"
        onChange={e => choose(e.target.files?.[0] ?? null)} />
      <FileUp size={20} strokeWidth={1.5} aria-hidden="true" />
      {file
        ? <span><strong>{file.name}</strong><small>{formatSize(file.size)} · 点击更换文件</small></span>
        : <span><strong>选择导出文件</strong><small>点击或拖入 .json 文件，最大 64MB，单张图片最大 32MB</small></span>}
    </label>
    <p className={styles.toolNote}>导出文件包含接口密钥，请妥善保存，导入后及时删除本地副本。</p>
    {plan ? <dl className={styles.importPlan} aria-label="导入预览">
      <div><dt>接口</dt><dd>{plan.providers}</dd></div>
      <div><dt>新增记录</dt><dd>{plan.jobs}</dd></div>
      <div><dt>新增图片</dt><dd>{plan.assets}</dd></div>
      <div><dt>已有图片</dt><dd>{plan.skippedAssets}</dd></div>
    </dl> : null}
    <div className={styles.toolActions}>
      <button type="button" className={file && !plan ? styles.primaryAction : styles.secondaryAction} disabled={!file || busy} onClick={() => void review()}>检查导入内容</button>
      {plan ? <button type="button" className={styles.primaryAction} disabled={busy} onClick={() => void apply()}>确认合并到当前账号</button> : null}
    </div>
    {status ? <p role="status" className={styles.statusText}>{status}</p> : null}
  </section>;
}
