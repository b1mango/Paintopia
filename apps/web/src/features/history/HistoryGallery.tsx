import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { GeneratedAsset } from '../../lib/apiClient';
import { dayLabel } from "../../lib/artMeta";
import { smallThumbnail, smallThumbnailFallback } from "../../lib/thumbnail";
import styles from './HistoryGallery.module.css';

export interface HistoryGalleryProps { onSelect: (asset: GeneratedAsset) => void; refreshKey: number; selectedId?: string | null; disabled?: boolean }
type AssetPage = { items: GeneratedAsset[]; total: number; page: number; pageSize: number };
const PAGE_SIZE = 20;
async function fetchPage(page: number, signal: AbortSignal): Promise<AssetPage> {
  const response = await fetch('/api/assets?scope=mine&page=' + page + '&pageSize=' + PAGE_SIZE, { credentials: 'include', signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.error === 'string' ? body.error : '加载失败（' + response.status + '），请重试');
  }
  const data = await response.json();
  if (!data || !Array.isArray(data.items) || !Number.isInteger(data.total) || data.total < 0 ||
      data.page !== page || data.pageSize !== PAGE_SIZE || data.items.length > PAGE_SIZE ||
      !data.items.every((item: GeneratedAsset) => item && typeof item.id === 'string' &&
        typeof item.imageUrl === 'string' && typeof item.prompt === 'string' &&
        typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)))) {
    throw new Error('历史资产分页响应不符合约定，请稍后重试');
  }
  return data;
}
function newestFirst(items: GeneratedAsset[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
}
export function HistoryGallery({ onSelect, refreshKey, selectedId, disabled }: HistoryGalleryProps) {
  const headingId = useId();
  const [items, setItems] = useState<GeneratedAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedMode, setFailedMode] = useState<'refresh' | 'more'>('refresh');
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const loadedIds = useRef<Set<string> | null>(null);
  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());
  const controller = useRef<AbortController | null>(null);
  const loadedPage = useRef(0);
  const busy = useRef(false);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const load = useCallback(async (mode: 'refresh' | 'more') => {
    if (mode === 'more' && busy.current) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request; busy.current = true;
    setLoading(true); setError(null); setFailedMode(mode);
    try {
      let result: AssetPage;
      let incoming: GeneratedAsset[];
      if (mode === 'refresh') {
        // New assets shift page boundaries: refresh the whole loaded window.
        const lastPage = Math.max(1, loadedPage.current);
        result = await fetchPage(1, request.signal);
        incoming = [...result.items];
        const end = Math.min(lastPage, Math.max(1, Math.ceil(result.total / PAGE_SIZE)));
        for (let next = 2; next <= end; next += 1) {
          result = await fetchPage(next, request.signal); incoming.push(...result.items);
        }
      } else {
        result = await fetchPage(loadedPage.current + 1, request.signal); incoming = result.items;
      }
      if (request.signal.aborted) return;
      loadedPage.current = result.page; setPage(result.page); setTotal(result.total);
      // 新落成的作品从卷轴顶端落入
      if (mode === 'refresh' && loadedIds.current) { const known = loadedIds.current; setFresh(new Set(incoming.filter((item) => !known.has(item.id)).map((item) => item.id))); }
      loadedIds.current = new Set([...(mode === 'refresh' ? [] : loadedIds.current ?? []), ...incoming.map((item) => item.id)]);
      setItems((current) => newestFirst(mode === 'refresh' ? incoming : [...current, ...incoming]));
      if (mode === 'refresh') setBrokenImages(new Set());
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : '加载失败，请重试');
    } finally {
      if (!request.signal.aborted) { busy.current = false; setLoading(false); }
    }
  }, []);
  useEffect(() => {
    void load('refresh');
    return () => { controller.current?.abort(); };
  }, [refreshKey, load]);
  const hasMore = page > 0 && page * PAGE_SIZE < total;
  useEffect(() => {
    if (!hasMore || loading || error || !sentinel.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load('more');
    }, { root: scrollRoot.current, rootMargin: '120px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [hasMore, loading, error, load]);
  let lastDay = '';
  return <aside className={styles.gallery} aria-labelledby={headingId}>
    <h3 id={headingId} className={styles.heading}>最近创作</h3>
    <div ref={scrollRoot} className={styles.scrollArea} aria-label="最近创作列表" tabIndex={0}>
      <ul className={styles.list}>{items.map((asset) => {
        const day = dayLabel(asset.createdAt);
        const showDay = day !== lastDay; lastDay = day;
        const ratio = asset.width && asset.height ? asset.width / asset.height : Number(asset.params?.actualWidth) / Number(asset.params?.actualHeight);
        return <li key={asset.id} data-new={fresh.has(asset.id) || undefined}>
          {showDay ? <span className={styles.day}>{day}</span> : null}
          <button type="button" className={styles.thumbnail} disabled={disabled} aria-pressed={selectedId === asset.id} title={(asset.prompt || '未命名创作') + (selectedId === asset.id ? '\n再次点击返回编辑中的创作' : '')} onClick={() => onSelect(asset)} aria-label={'回填参数：' + (asset.prompt || '未命名创作')}
            style={Number.isFinite(ratio) && ratio > 0 ? { aspectRatio: String(Math.min(2.4, Math.max(.42, ratio))) } : undefined}>
            {brokenImages.has(asset.id) ? <span className={styles.noImage}>预览暂不可用</span> : <img src={smallThumbnail(asset)} alt="" loading="lazy" decoding="async" onError={smallThumbnailFallback(asset, () => setBrokenImages((current) => new Set(current).add(asset.id)))} />}
          </button>
        </li>;
      })}</ul>
      {loading && <p className={styles.state} role="status">{items.length ? '正在更新最近创作…' : '正在加载最近创作…'}</p>}
      {error && <div className={styles.state}><p role="alert">{error}</p><button type="button" className={styles.action} onClick={() => void load(failedMode)}>重试</button></div>}
      {!loading && !error && !items.length && <p className={`${styles.state} ${styles.vertical}`}>还没有创作，完成的图片会保留在这里。</p>}
      <div ref={sentinel} className={styles.sentinel} aria-hidden="true" />
      {hasMore && !error && <button type="button" className={styles.more} disabled={loading} onClick={() => void load('more')}>加载更多</button>}
      {!loading && !error && items.length > 0 && !hasMore && <p className={`${styles.state} ${styles.end}`}><span aria-hidden="true">卷终</span><span className={styles.srOnly}>已显示全部创作</span></p>}
    </div>
  </aside>;
}

