import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, Copy, ImageOff, PencilLine, Search, Star, Trash2, X } from "lucide-react";
import { Enso } from "../create/Enso";
import type { PromptLibraryResponse, PromptSource, SourcedPrompt } from "@paintopia/shared";
import { CURATED_SOURCE_ID, curatedBareId, promptLibraryApi, type PromptLibraryQuery } from "./promptLibraryApi";
import styles from "./PromptLibraryView.module.css";

export type PromptLibraryViewProps = { onUsePrompt?: (text: string) => void; canManage?: boolean };

const TAG_PREVIEW = 14;
/** 站主推荐为空时默认看 2.5，不悄悄退回旧模型来源。 */
const FALLBACK_SOURCE_ID = "image-2-5";
const defaultSource = (data: PromptLibraryResponse | null) =>
  data?.sources.some(source => source.id === CURATED_SOURCE_ID && source.count > 0) ? CURATED_SOURCE_ID : FALLBACK_SOURCE_ID;

function Cover({ item, full = false }: { item: SourcedPrompt; full?: boolean }) {
  let imageUrl = full ? item.imageUrl ?? item.coverUrl : item.coverUrl;
  if (imageUrl && !full) {
    const url = new URL(imageUrl, location.href);
    if (url.hostname === "pbs.twimg.com") { url.searchParams.set("name", "small"); imageUrl = url.href; }
  }
  /** 站主推荐图的签名地址过期或边缘失败时，改走一次站内回源路由。 */
  const fallbackUrl = item.sourceId === CURATED_SOURCE_ID ? "/api/curated-prompts/" + encodeURIComponent(curatedBareId(item.id)) + (full ? "/image" : "/thumbnail") : undefined;
  const [retried, setRetried] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = retried ? fallbackUrl : imageUrl;
  return src && !failed
    ? <img className={styles.cover} src={src} alt={item.title} width={item.width} height={item.height} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => fallbackUrl && !retried ? setRetried(true) : setFailed(true)} />
    : <span className={styles.noCover}><ImageOff size={22} strokeWidth={1.5} aria-hidden="true" /><span>{failed ? "封面暂不可用" : "来源未提供封面"}</span></span>;
}

/** 站主推荐没有外部主页或许可链接时退回纯文字。 */
function MaybeLink({ href, children }: { href?: string; children: ReactNode }) {
  return href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>;
}

function Attribution({ item, source }: { item: SourcedPrompt; source?: PromptSource }) {
  if (item.sourceId === CURATED_SOURCE_ID) return <div className={styles.attribution}>
    <p>{source?.license ?? "站主原创"} · 配图为本站生成的效果图。</p>
  </div>;
  return <div className={styles.attribution}>
    <p>{item.author ? "原作者 · " + item.author : "原作者未署名"} {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">查看原作 <ArrowUpRight size={13} aria-hidden="true" /></a> : null}</p>
    {source && <>
      <p><MaybeLink href={source.homepage}>{source.name}</MaybeLink> · <MaybeLink href={source.licenseUrl}>{source.license}</MaybeLink></p>
      <p><a href={source.aggregatorUrl} target="_blank" rel="noreferrer">来源仓库</a>（<a href={source.aggregatorLicenseUrl} target="_blank" rel="noreferrer">仓库许可</a>）。保留提示词原文，展示源提供的标题与描述；图片与原作权利以原作者声明为准。</p>
      <p>{source.compatibilityNote}</p>
    </>}
  </div>;
}

function CuratedEditor({ item, onCancel, onSaved }: { item: SourcedPrompt; onCancel: () => void; onSaved: (item: SourcedPrompt) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const tags = String(form.get("tags")).split(/[,，、\s]+/).map(tag => tag.trim()).filter(Boolean);
    setSaving(true); setError("");
    try {
      onSaved(await promptLibraryApi.updateCurated(item, {
        title: String(form.get("title")).trim(), description: String(form.get("description")).trim(), text: String(form.get("text")).trim(), tags
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); setSaving(false); }
  }
  return <form className={styles.editor} aria-label="编辑推荐提示词" onSubmit={event => void submit(event)}>
    <label><span>标题</span><input name="title" required maxLength={80} defaultValue={item.title} /></label>
    <label><span>说明（可选）</span><textarea name="description" rows={2} maxLength={500} defaultValue={item.description} /></label>
    <label><span>标签（逗号分隔，最多 12 个）</span><input name="tags" defaultValue={item.tags.join("，")} /></label>
    <label><span>提示词</span><textarea name="text" required rows={10} maxLength={20000} defaultValue={item.text} /></label>
    {error ? <p className={styles.editorError} role="alert">{error}</p> : null}
    <div className={styles.actionRow}>
      <button type="button" disabled={saving} onClick={onCancel}>取消</button>
      <button type="submit" disabled={saving}>{saving ? "正在保存…" : "保存"}</button>
    </div>
  </form>;
}

export function PromptLibraryView({ onUsePrompt, canManage = false }: PromptLibraryViewProps) {
  const [data, setData] = useState<PromptLibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [sourceId, setSourceId] = useState(CURATED_SOURCE_ID);
  const [tag, setTag] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const savedFavorites = useRef(new Map<string, boolean>());
  const revalidated = useRef(false);
  const defaultResolved = useRef(false);
  /** 每次筛选变化加一；翻页结果回来时若已过期就丢弃。 */
  const generation = useRef(0);
  const [feedback, setFeedback] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [allTags, setAllTags] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const selected = data?.items.find((item) => item.id === selectedId);
  const selectedSource = data?.sources.find((source) => source.id === selected?.sourceId);
  const sourceErrors = data?.sourceErrors ?? [];
  const failedSourceIds = new Set(sourceErrors.map((failure) => failure.sourceId));
  const selectedSourceFailed = Boolean(sourceId && failedSourceIds.has(sourceId));
  const remoteSources = data?.sources.filter((source) => source.id !== CURATED_SOURCE_ID) ?? [];
  const allSourcesFailed = Boolean(remoteSources.length && remoteSources.every((source) => failedSourceIds.has(source.id)));
  const listQuery: PromptLibraryQuery = { source: sourceId || "all", q: term, tag, favorites: favoritesOnly };

  const withSavedFavorites = (items: SourcedPrompt[]) => items.map(item => ({ ...item, favorite: savedFavorites.current.get(item.id) ?? item.favorite }));

  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    const applyResponse = (response: PromptLibraryResponse) => setData({ ...response, items: withSavedFavorites(response.items) });
    setLoading(true); setLoadingMore(false); setError("");
    promptLibraryApi.list(listQuery, { signal: controller.signal, refresh: reload > 0 }).then(async (response) => {
      if (controller.signal.aborted) return;
      if (!defaultResolved.current) {
        defaultResolved.current = true;
        if (sourceId === CURATED_SOURCE_ID && defaultSource(response) !== CURATED_SOURCE_ID) { controller.abort(); setSourceId(FALLBACK_SOURCE_ID); return; }
      }
      applyResponse(response);
      setLoading(false);
      if (response.refreshNeeded && !revalidated.current) {
        revalidated.current = true;
        // Keep the snapshot visible while a separate request revalidates it.
        try {
          const updated = await promptLibraryApi.list(listQuery, { signal: controller.signal, refresh: true });
          if (!controller.signal.aborted && generation.current === current) applyResponse(updated);
        } catch {
          if (!controller.signal.aborted) setFeedback("来源更新未完成，已有内容仍可浏览；可重新加载后重试。");
        }
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setData(null); setError(cause instanceof Error ? cause.message : "加载失败，请重试");
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, sourceId, term, tag, favoritesOnly]);

  useEffect(() => {
    if (!selected || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, [selectedId, Boolean(selected)]);
  useEffect(() => { setEditing(false); setConfirmDelete(false); }, [selectedId]);

  async function loadMore() {
    if (!data || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await promptLibraryApi.list({ ...listQuery, offset: data.items.length });
      if (generation.current !== current) return;
      setData((existing) => {
        if (!existing) return existing;
        const seen = new Set(existing.items.map(item => item.id));
        return { ...page, items: [...existing.items, ...withSavedFavorites(page.items.filter(item => !seen.has(item.id)))] };
      });
    } catch (cause) { if (generation.current === current) setFeedback(cause instanceof Error ? cause.message : "加载失败，请重试"); }
    finally { if (generation.current === current) setLoadingMore(false); }
  }

  async function toggleFavorite(item: SourcedPrompt) {
    if (busyRef.current.has(item.id)) return;
    busyRef.current.add(item.id); setBusy(new Set(busyRef.current)); setFeedback("");
    try {
      const result = await promptLibraryApi.setFavorite(item.id, !item.favorite);
      savedFavorites.current.set(result.id, result.favorite);
      setData((current) => current && (favoritesOnly && !result.favorite
        ? { ...current, total: current.total - 1, items: current.items.filter((row) => row.id !== result.id) }
        : { ...current, items: current.items.map((row) => row.id === result.id ? { ...row, favorite: result.favorite } : row) }));
      setFeedback(result.favorite ? "已收藏，已保存到你的账户" : "已取消收藏");
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : "收藏保存失败，请重试"); }
    finally { busyRef.current.delete(item.id); setBusy(new Set(busyRef.current)); }
  }

  async function copy(item: SourcedPrompt) {
    setCopiedId(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(item.text);
      setCopiedId(item.id); setFeedback("提示词已复制");
    } catch { setFeedback("复制失败，请在详情中手动选择文本复制"); }
  }

  function saveCurated(updated: SourcedPrompt) {
    setData((current) => current && ({ ...current, items: current.items.map((row) => row.id === updated.id ? { ...updated, favorite: row.favorite } : row) }));
    setEditing(false); setFeedback("已保存");
  }

  async function removeCurated(item: SourcedPrompt) {
    if (busyRef.current.has(item.id)) return;
    busyRef.current.add(item.id); setBusy(new Set(busyRef.current)); setFeedback("");
    try {
      await promptLibraryApi.removeCurated(item.id);
      setData((current) => current && ({
        ...current,
        total: current.total - 1,
        items: current.items.filter((row) => row.id !== item.id),
        sources: current.sources.map((source) => source.id === item.sourceId ? { ...source, count: source.count - 1 } : source)
      }));
      setSelectedId(null); setFeedback("已移出站主推荐");
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : "移出失败，请重试"); return; }
    finally { busyRef.current.delete(item.id); setBusy(new Set(busyRef.current)); }
    // 标签与各来源计数由服务端汇总，删除后重取首页，避免残留已删作品的标签。
    const current = ++generation.current;
    setLoadingMore(false);
    try {
      const fresh = await promptLibraryApi.list(listQuery);
      if (generation.current === current) setData({ ...fresh, items: withSavedFavorites(fresh.items) });
    } catch { /* 本地已移除该条，刷新失败时保留现状 */ }
  }

  function favoriteButton(item: SourcedPrompt) {
    return <button type="button" className={styles.star} aria-pressed={item.favorite}
      aria-label={(item.favorite ? "取消收藏 " : "收藏 ") + item.title} disabled={busy.has(item.id)}
      onClick={() => void toggleFavorite(item)}><Star size={15} strokeWidth={1.6} fill={item.favorite ? "currentColor" : "none"} aria-hidden="true" /></button>;
  }

  const chooseSource = (id: string) => { setSourceId(id); setTag(""); setAllTags(false); };
  const clearFilters = () => { setQuery(""); setTerm(""); setTag(""); setSourceId(defaultSource(data)); setFavoritesOnly(false); };
  const tags = data?.tags ?? [];
  const shownTags = allTags ? tags : tags.slice(0, TAG_PREVIEW);
  const visibleSources = data?.sources.filter((source) => source.count > 0 || source.id === sourceId || failedSourceIds.has(source.id)) ?? [];
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const canEditSelected = canManage && selected?.sourceId === CURATED_SOURCE_ID;

  return <section className={styles.library} aria-label="来源提示词库">
    <header className={styles.head}>
      <div>
        <h1>灵感</h1>
        <p className={styles.count}>{loading && !data ? "正在翻检画谱…" : <>{sourceId === CURATED_SOURCE_ID ? "站主推荐" : "他山之石"} · 共 {total}<small>条提示词</small></>}</p>
      </div>
      <label className={styles.search}><Search size={15} aria-hidden="true" /><input type="search" aria-label="搜索提示词" placeholder="搜索标题、内容或标签" maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </header>

    <aside className={styles.filters} aria-label="提示词筛选">
      <div className={styles.sources} role="group" aria-label="筛选来源">
        <button type="button" aria-pressed={!sourceId} onClick={() => chooseSource("")}>全部来源</button>
        {visibleSources.map((source) => <button type="button" key={source.id} aria-pressed={sourceId === source.id} data-curated={source.id === CURATED_SOURCE_ID || undefined}
          onClick={() => chooseSource(source.id)}>{source.name}{failedSourceIds.has(source.id) ? "（暂不可用）" : <small aria-hidden="true">{source.count}</small>}</button>)}
        <button type="button" className={styles.favoriteFilter} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((value) => !value)}><Star size={13} strokeWidth={1.6} fill={favoritesOnly ? "currentColor" : "none"} aria-hidden="true" />只看收藏</button>
      </div>
      {tags.length ? <div className={styles.tagFilters} role="group" aria-label="筛选标签">
        <button type="button" aria-pressed={!tag} onClick={() => setTag("")}>全部</button>
        {shownTags.map(({ tag: value }) => <button type="button" key={value} aria-pressed={tag === value} onClick={() => setTag(tag === value ? "" : value)}>{value}</button>)}
        {tag && !shownTags.some((entry) => entry.tag === tag) ? <button type="button" aria-pressed="true" onClick={() => setTag("")}>{tag}</button> : null}
        {tags.length > TAG_PREVIEW ? <button type="button" className={styles.expand} aria-expanded={allTags} onClick={() => setAllTags((value) => !value)}>{allTags ? "收起" : `更多 ${tags.length - TAG_PREVIEW}`}<ChevronDown size={13} aria-hidden="true" /></button> : null}
      </div> : null}
    </aside>

    {sourceErrors.length > 0 && !loading && !error && <aside className={styles.sourceWarning} role="alert">
      <strong>{allSourcesFailed ? "公开来源暂时均不可用" : "部分来源暂不可用，其他来源仍可浏览和收藏"}</strong>
      {sourceErrors.map((failure) => <p key={failure.sourceId}>{data?.sources.find((source) => source.id === failure.sourceId)?.name ?? failure.sourceId}：{failure.message}</p>)}
      <button type="button" onClick={() => setReload((value) => value + 1)}>重试不可用来源</button>
    </aside>}
    <p className={styles.feedback} role="status" aria-live="polite">{feedback}</p>

    {loading && !data ? <div className={styles.loading} role="status"><span className={styles.srOnly}>正在读取公开来源…</span>
      <div className={styles.masonry} aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div key={index} className={styles.skeleton} style={{ aspectRatio: index % 3 ? "3 / 4" : "1" }} />)}</div></div>
      : error ? <div className={styles.state} role="alert"><Enso variant="broken" /><h2>暂时没能打开提示词库</h2><p>{error}</p><button type="button" onClick={() => setReload((value) => value + 1)}>重新加载</button></div>
      : items.length === 0 ? <div className={styles.state} aria-busy={loading}><Enso variant="still" />
        <h2>{allSourcesFailed ? "等待来源恢复" : selectedSourceFailed ? "当前来源加载失败" : "没有符合条件的作品"}</h2>
        <p>{allSourcesFailed ? "请稍后重试，未加载的作品不会被替换成演示数据。" : selectedSourceFailed ? "可切换其他来源继续浏览，或稍后重试当前来源。" : favoritesOnly ? "收藏喜欢的作品，下次从这里继续。" : "换个关键词或清除筛选，再找找灵感。"}</p>
        <button type="button" onClick={clearFilters}>清除筛选</button></div>
      : <div className={styles.results} aria-busy={loading} data-stale={loading || undefined}>
        <div className={styles.masonry}>
          {items.map((item, index) => <article key={item.id} className={styles.card} style={{ "--i": index % 24 } as CSSProperties}>
            <button type="button" className={styles.openCard} aria-label={"查看详情 " + item.title} onClick={() => { setFeedback(""); setSelectedId(item.id); }}><Cover item={item} /></button>
            <div className={styles.cardBody}>
              <h3 className={styles.cardTitle}>{item.title}</h3>
              {item.description ? <p className={styles.description}>{item.description}</p> : null}
              <div className={styles.cardFooter}>
                <button type="button" aria-label={"复制提示词 " + item.title} onClick={() => void copy(item)}>{copiedId === item.id ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copiedId === item.id ? "已复制" : "复制"}</button>
                <button type="button" aria-label={"选用提示词 " + item.title} disabled={!onUsePrompt} title={!onUsePrompt ? "创作入口尚未连接" : undefined} onClick={() => onUsePrompt?.(item.text)}><ArrowUpRight size={13} aria-hidden="true" />选用</button>
                {favoriteButton(item)}
              </div>
            </div>
          </article>)}
        </div>
        {items.length < total && <div className={styles.more}><button type="button" disabled={loadingMore || loading} onClick={() => void loadMore()}>{loadingMore ? "正在展卷…" : `再看一些 · 还有 ${total - items.length} 条`}</button></div>}
      </div>}

    {data?.sources.filter((source) => source.id !== CURATED_SOURCE_ID && (!sourceId || source.id === sourceId)).map((source) => <footer className={styles.sourceNote} key={source.id}>
      <MaybeLink href={source.homepage}>{source.name}</MaybeLink><span> · </span><MaybeLink href={source.licenseUrl}>{source.license}</MaybeLink><p>{source.compatibilityNote}</p>
    </footer>)}

    {selected && <dialog ref={dialog} className={styles.dialog} aria-labelledby="prompt-detail-title" onClose={() => setSelectedId(null)} onCancel={() => setSelectedId(null)}
      onClick={(event) => { if (event.target === event.currentTarget || (event.target as HTMLElement).dataset.backdrop !== undefined) setSelectedId(null); }}>
      <div className={styles.detailImage} data-backdrop><Cover key={selected.id} item={selected} full /></div>
      <div className={styles.detailBody}>
        <span className={styles.eyebrow}>{selected.model}</span>
        <h2 id="prompt-detail-title">{selected.title}</h2>
        {editing ? <CuratedEditor key={selected.id} item={selected} onCancel={() => setEditing(false)} onSaved={saveCurated} /> : <>
          {selected.description ? <p className={styles.detailDescription}>{selected.description}</p> : null}
          <label className={styles.promptLabel}><span>完整提示词</span><textarea aria-label="完整提示词" readOnly value={selected.text} rows={10} /></label>
          <div className={styles.actions}>
            <button type="button" className={styles.useButton} disabled={!onUsePrompt} title={!onUsePrompt ? "创作入口尚未连接" : undefined} onClick={() => { onUsePrompt?.(selected.text); setSelectedId(null); }}>选用提示词 · 去创作</button>
            <div className={styles.actionRow}>
              <button type="button" onClick={() => void copy(selected)}>{copiedId === selected.id ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copiedId === selected.id ? "已复制" : "复制提示词"}</button>
              {favoriteButton(selected)}
            </div>
            {canEditSelected ? <div className={styles.manageRow}>
              <button type="button" onClick={() => setEditing(true)}><PencilLine size={14} aria-hidden="true" />编辑</button>
              <button type="button" data-danger disabled={busy.has(selected.id)} onClick={() => confirmDelete ? void removeCurated(selected) : setConfirmDelete(true)}>
                <Trash2 size={14} aria-hidden="true" />{confirmDelete ? "确认移出站主推荐" : "移出站主推荐"}</button>
            </div> : null}
          </div>
          {!onUsePrompt && <p className={styles.hint}>创作入口尚未连接，可以先复制提示词。</p>}
        </>}
        <p className={styles.feedback} role="status" aria-live="polite">{feedback}</p>
        <Attribution item={selected} source={selectedSource} />
      </div>
      <button autoFocus type="button" className={styles.close} aria-label="关闭详情" title="关闭（Esc）" onClick={() => setSelectedId(null)}><X size={20} strokeWidth={1.5} aria-hidden="true" /></button>
    </dialog>}
  </section>;
}
