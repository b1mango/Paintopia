import { useState } from "react";
import styles from "../features/admin/admin.module.css";

export function ThumbnailMaintenance() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; failed: number; finished: boolean } | null>(null);
  const [status, setStatus] = useState("");

  async function run() {
    setBusy(true); setStatus("正在检查历史缩略图…"); setProgress({ done: 0, failed: 0, finished: false });
    let after = "", done = 0, failed = 0;
    try {
      while (true) {
        const response = await fetch("/api/admin/thumbnails/backfill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ after }) });
        if (response.status === 429) {
          setStatus("请求较多，稍后自动继续…");
          const seconds = Number(response.headers.get("Retry-After") || 60);
          await new Promise(resolve => setTimeout(resolve, (Number.isFinite(seconds) ? Math.max(1, seconds) : 60) * 1000));
          continue;
        }
        const page = await response.json();
        if (!response.ok) throw new Error(page.error || "补齐失败");
        done += page.results.filter((r: { ok: boolean }) => r.ok).length;
        failed += page.results.filter((r: { ok: boolean }) => !r.ok).length;
        after = page.next || "";
        setProgress({ done, failed, finished: !after });
        setStatus(after ? "继续处理中…" : failed ? "处理完成，失败的图片可以重新执行。" : "处理完成。");
        if (!after) break;
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : "补齐失败"); }
    finally { setBusy(false); }
  }

  return <section className={styles.toolCard} aria-busy={busy} aria-labelledby="thumbnail-tool-title">
    <header className={styles.toolHead}>
      <span className={styles.toolIndex} aria-hidden="true">贰</span>
      <div><h3 id="thumbnail-tool-title">图片缩略图维护</h3><p>分批检查并补齐历史图片的小尺寸预览，保留原图。可随时中断，失败后重新执行即可。</p></div>
    </header>
    {progress ? <dl className={styles.importPlan} aria-label="缩略图处理进度">
      <div><dt>已检查</dt><dd>{progress.done}</dd></div>
      <div><dt>失败</dt><dd data-error={progress.failed ? true : undefined}>{progress.failed}</dd></div>
    </dl> : null}
    <div className={styles.toolActions}>
      <button type="button" className={styles.secondaryAction} disabled={busy} onClick={() => void run()}>{busy ? "正在补齐…" : "补齐历史缩略图"}</button>
    </div>
    {status ? <p role="status" className={styles.statusText}>{status}</p> : null}
  </section>;
}
