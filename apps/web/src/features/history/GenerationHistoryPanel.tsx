import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, ArrowUpRight, ChevronLeft, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import { apiClient, type GenerationHistoryFilters, type GenerationHistoryItem, type GenerationHistoryResponse } from "../../lib/apiClient";
import { useResolvedTheme } from "../../lib/uiStore";
import styles from "./GenerationHistoryPanel.module.css";

const statuses: Record<string, string> = { succeeded: "成功", failed: "失败", running: "生成中", queued: "排队中", pending: "等待中" };
const emptyFilters = { from: "", to: "", user: "", model: "", provider: "", status: "" };
const dateTime = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const duration = (item: GenerationHistoryItem) => ["running", "queued", "pending"].includes(item.status) ? "—" : item.durationMs === null ? "未记录" : `${(item.durationMs / 1000).toFixed(1)} 秒`;
const textParam = (value: unknown) => value == null ? "未记录" : typeof value === "object" ? JSON.stringify(value) : String(value);
function Status({ value }: { value: string }) { return <span className={styles.status} data-status={value}>{statuses[value] ?? value}</span>; }

/** allUsers：后台统计页查看全站记录（管理员接口）；否则为本人的使用日志。 */
export function GenerationHistoryPanel({ allUsers = false, summary }: { allUsers?: boolean; summary?: ReactNode }) {
  const [draft, setDraft] = useState(emptyFilters);
  const [query, setQuery] = useState<GenerationHistoryFilters>({ page: 1, pageSize: 20 });
  const [result, setResult] = useState<GenerationHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<GenerationHistoryItem | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    apiClient.listGenerationHistory(query, allUsers ? "all" : "mine").then((data) => { if (!cancelled) setResult(data); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "记录加载失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, refresh, allUsers]);
  function filter(event: FormEvent) {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) { setError("开始时间不能晚于结束时间"); return; }
    setQuery({ ...draft, user: allUsers ? draft.user : undefined, from: draft.from ? new Date(draft.from).toISOString() : undefined, to: draft.to ? new Date(draft.to).toISOString() : undefined, page: 1, pageSize: query.pageSize });
  }
  function field(key: keyof typeof emptyFilters, label: string, type = "text") {
    return <label className={styles.field}>{label}<input type={type} value={draft[key]} placeholder={type === "text" ? `搜索${label}` : undefined} onChange={(event) => setDraft((old) => ({ ...old, [key]: event.target.value }))} /></label>;
  }
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? query.pageSize ?? 20)));
  const page = query.page ?? 1;
  return <section className={styles.panel} aria-label="生图调用记录">
    <header className={styles.header}><div><h2>生图调用记录 <span className={styles.count}>{result?.total ?? 0}</span></h2><p>{allUsers ? "全部用户" : "我的记录"} · 最新在前 · 仅显示本站额度消耗</p></div><button type="button" className={styles.button} disabled={loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} />刷新记录</button></header>
    {result?.summary ? <div className={styles.summaryGrid}>{[["总任务",result.summary.total],["成功率",`${(result.summary.successRate*100).toFixed(1)}%`],["平均时长",`${(result.summary.averageDurationMs/1000).toFixed(1)} 秒`],["成功 / 失败",`${result.summary.succeeded} / ${result.summary.failed}`]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div> : summary}

    <form className={styles.filters} onSubmit={filter}>
      {field("from", "开始时间", "datetime-local")}{field("to", "结束时间", "datetime-local")}
      {allUsers ? field("user", "用户") : null}{(["model","provider"] as const).map(key=><label key={key} className={styles.field}>{key==="model"?"模型":"接口来源"}<select value={draft[key]} onChange={event=>setDraft(old=>({...old,[key]:event.target.value}))}><option value="">{key==="model"?"全部模型":"全部来源"}</option>{Array.from(new Set([...(result?.options?.[key==="model"?"models":"providers"]??[]),draft[key]].filter(Boolean))).map(value=><option key={value} value={value}>{value}</option>)}</select></label>)}
      <label className={styles.field}>状态<select value={draft.status} onChange={(event) => setDraft((old) => ({ ...old, status: event.target.value }))}><option value="">全部状态</option>{Object.entries(statuses).filter(([value]) => ["succeeded", "failed", "running"].includes(value)).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <div className={styles.filterActions}><button className={styles.primaryButton} type="submit" disabled={loading}><Search size={14} />查询</button><button className={styles.button} type="button" onClick={() => { setDraft(emptyFilters); setQuery({ page: 1, pageSize: query.pageSize }); }}>重置</button></div>
    </form>
    {error ? <div className={styles.error} role="alert"><span>{error}</span><button type="button" className={styles.button} onClick={() => setRefresh(value => value + 1)}>重新加载记录</button></div> : null}
    {loading ? <p className={styles.empty} role="status">正在加载记录...</p> : !error && !result?.items.length ? <p className={styles.empty}>没有符合条件的调用记录</p> : null}
    {!loading && !error && result?.items.length ? <div className={styles.tableScroll}><table className={styles.table}>
      <thead><tr>{["时间", "用户", "模型", "接口来源", "分辨率", "质量", "张数", "生成耗时", "本站额度", "状态", "详情"].map((label, index) => <th className={index >= 6 && index <= 8 ? styles.numeric : undefined} key={label}>{label}</th>)}</tr></thead>
      <tbody>{result.items.map((item) => <tr key={item.id}>
        <td className={styles.time}>{dateTime(item.createdAt)}</td><td><span className={styles.truncate} title={item.userEmail}>{item.userEmail}</span></td><td><span className={`${styles.truncate} ${styles.model}`} title={item.model}>{item.model || "未记录模型"}</span></td><td><span className={styles.truncate} title={item.providerName}>{item.providerName || "未记录来源"}</span></td>
        <td>{textParam(item.params.resolution ?? item.params.size)}</td><td>{textParam(item.params.quality)}</td><td className={styles.numeric}>{textParam(item.params.n ?? 1)}</td>
        <td className={styles.numeric}>{duration(item)}</td><td className={styles.numeric}>{item.quotaCost === null ? "未记录" : item.quotaCost.toLocaleString("zh-CN")}</td><td><Status value={item.status} /></td>
        <td><button className={styles.detailButton} type="button" aria-label={`查看调用详情 ${item.id}`} onClick={() => setSelected(item)}>查看<ArrowUpRight size={13} /></button></td>
      </tr>)}</tbody>
    </table></div> : null}
    <footer className={styles.pagination}><span>共 {result?.total ?? 0} 条 · 第 {page} / {pages} 页</span><div className={styles.pageControls}><label>每页 <select aria-label="每页条数" value={query.pageSize} onChange={(event) => setQuery((old) => ({ ...old, page: 1, pageSize: Number(event.target.value) }))}>{[20, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}</select> 条</label><button type="button" className={styles.button} disabled={loading || page <= 1} onClick={() => setQuery((old) => ({ ...old, page: page - 1 }))}><ChevronLeft size={14} />上一页</button><button type="button" className={styles.button} disabled={loading || page >= pages} onClick={() => setQuery((old) => ({ ...old, page: page + 1 }))}>下一页<ChevronRight size={14} /></button></div></footer>
    {selected ? <HistoryDetail item={selected} onClose={() => setSelected(null)} /> : null}
  </section>;
}

function HistoryDetail({ item, onClose }: { item: GenerationHistoryItem; onClose: () => void }) {
  const theme = useResolvedTheme();
  const titleId = useId();
  const [copyStatus, setCopyStatus] = useState("");
  const rawDetails = JSON.stringify({ params: item.params, attempts: item.attempts ?? [] }, null, 2);
  async function copyDetails() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(rawDetails);
      setCopyStatus("已复制请求参数与调用尝试");
    } catch { setCopyStatus("复制失败，请展开后手动复制"); }
  }
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const nodes = Array.from(dialog?.querySelectorAll<HTMLElement>('button, summary, a[href], [tabindex="0"]') ?? []).filter((node) => !node.hasAttribute("disabled"));
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);
  const runtime = item.params.__paintopiaRuntime as { imageGeneration?: { returnedCount?: number; outputs?: { assetId: string; width: number | null; height: number | null }[] } } | undefined;
  const outputs = runtime?.imageGeneration?.outputs ?? [];
  const entries = [["接口来源", item.providerName || "未记录来源"], ["模型", item.model || "未记录模型"], ["用户", item.userEmail], ["生成耗时", duration(item)], ["开始时间", dateTime(item.createdAt)], ["更新时间", dateTime(item.updatedAt)], ["请求分辨率", textParam(item.params.resolution ?? item.params.size)], ["请求像素", textParam(item.params.size)], ["画幅", textParam(item.params.aspectRatio)], ["请求质量", textParam(item.params.quality)], ["请求张数", textParam(item.params.n ?? 1)], ["本站额度", item.quotaCost === null ? "未记录" : `${item.quotaCost} 额度`]];
  return createPortal(<div className={styles.backdrop} data-theme={theme} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className={styles.dialogHeader}><div><h2 id={titleId}>调用详情</h2><p>查看本次请求与执行结果</p></div><button className={styles.closeButton} type="button" aria-label="关闭调用详情" onClick={onClose}><X size={18} /></button></header>
      <div className={styles.dialogBody}><div className={styles.identity}><span>任务编号</span><code>{item.id}</code><Status value={item.status} /></div>
        <dl className={styles.metadata}>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {outputs.length ? <section className={styles.outputSizes}><h3>实际返回图片</h3><ul>{outputs.map(output => <li key={output.assetId}>{output.width && output.height ? output.width + " × " + output.height : "未记录像素"}<a href={"/api/assets/" + encodeURIComponent(output.assetId) + "/download"} download>下载原图</a></li>)}</ul></section> : null}
        {item.error ? <section className={styles.failure}><h3>失败原因</h3><p>{item.error}</p></section> : null}
        <div className={styles.rawActions}><button type="button" className={styles.button} onClick={copyDetails}><Copy size={14} />复制请求参数与调用尝试</button>{copyStatus ? <span role="status">{copyStatus}</span> : null}</div>
        <details className={styles.raw}><summary>原始请求参数与调用尝试</summary><pre>{rawDetails}</pre></details>
      </div>
      <footer className={styles.dialogFooter}><span>分辨率与质量为请求值</span><button className={styles.button} type="button" onClick={onClose}>关闭</button></footer>
    </div>
  </div>, document.body);
}
