import {useEffect, useRef, useState, type SetStateAction} from "react";
import {apiClient, type GeneratedAsset, type GalleryItem} from "./apiClient";

type Item = GeneratedAsset | GalleryItem;
type Page = {items: Item[]; nextCursor: string | null};
type CachedPage = {page: Page; expires: number};
const memory = new Map<string, CachedPage>();
let epoch = 0;
const lifetime = 5 * 60_000;

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("paintopia-media", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("lists");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readCache(key: string): Promise<CachedPage | undefined> {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const request = db.transaction("lists").objectStore("lists").get(key);
    request.onsuccess = () => { db.close(); resolve(request.result?.expires > Date.now() ? request.result : undefined); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}
async function saveCache(key: string, cached: CachedPage, generation: number) {
  const db = await openCache();
  if (generation !== epoch) { db.close(); return; }
  const tx = db.transaction("lists", "readwrite");
  const store = tx.objectStore("lists");
  store.put(cached, key);
  const all = store.getAll();
  all.onsuccess = () => {
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      const entries = keys.result.map((key, index) => ({key, expires: all.result[index].expires})).sort((a,b) => b.expires-a.expires);
      for (const entry of entries.filter((entry,index) => index >= 30 || entry.expires <= Date.now())) store.delete(entry.key);
    };
  };
  tx.oncomplete = tx.onerror = tx.onabort = () => db.close();
}
export function clearMediaCache() {
  epoch++;
  memory.clear();
  if (typeof indexedDB !== "undefined") void openCache().then(db => {
    const tx = db.transaction("lists", "readwrite");
    tx.objectStore("lists").clear();
    tx.oncomplete = tx.onerror = tx.onabort = () => db.close();
  }).catch(() => {});
}
function cachedPage(key: string) {
  const cached = memory.get(key);
  return cached && cached.expires > Date.now() ? cached.page : undefined;
}
export function useMediaFeed<T extends Item>(kind: "assets" | "gallery", account: string, search = "", category = "all", revision = 0) {
  const key = JSON.stringify([account, kind, search, category]);
  const [items, updateItems] = useState<T[]>(() => cachedPage(key)?.items as T[] ?? []);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const current = useRef(key); current.current = key;
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const sentinel = useRef<HTMLButtonElement>(null);
  async function load(more = false) {
    if (more && (busy.current || !cursor)) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    busy.current = true; setLoading(true); setError("");
    const startEpoch = epoch;
    try {
      const query = new URLSearchParams({limit: "20", search, category});
      if (more && cursor) query.set("cursor", cursor);
      const page = await apiClient.listMediaFeed(kind, query, controller.signal);
      if (controller.signal.aborted || current.current !== key || epoch !== startEpoch) return;
      updateItems(old => more ? [...new Map([...old, ...page.items as T[]].map(x => [x.id,x])).values()] : page.items as T[]);
      setCursor(page.nextCursor);
      if (!more) {
        const cached = {page, expires: Date.now() + lifetime};
        memory.set(key, cached);
        if (memory.size > 30) memory.delete(memory.keys().next().value!);
        void saveCache(key, cached, startEpoch).catch(() => {});
      }
    } catch (e) {
      if (!controller.signal.aborted && current.current === key && epoch === startEpoch) setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (!controller.signal.aborted) { busy.current = false; setLoading(false); }
    }
  }
  useEffect(() => {
    let live = true;
    const startEpoch = epoch;
    const cached = cachedPage(key);
    updateItems(cached?.items as T[] ?? []); setCursor(cached?.nextCursor ?? null); setLoading(true); setError("");
    if (!cached) void readCache(key).then(cached => {
      if (live && epoch === startEpoch && cached && !memory.has(key)) {
        updateItems(cached.page.items as T[]); setCursor(cached.page.nextCursor);
      }
    }).catch(() => {});
    const timer = setTimeout(() => void load(), search ? 250 : 0);
    return () => { live = false; clearTimeout(timer); abort.current?.abort(); busy.current = false; };
  }, [key, revision]);
  useEffect(() => {
    if (!sentinel.current || loading || error || !cursor || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void load(true);
    }, {rootMargin: "300px"});
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [cursor, loading, error, key]);
  function setItems(update: SetStateAction<T[]>) {
    // Share/delete changes invalidate both views, including stored first pages.
    clearMediaCache();
    updateItems(update);
  }
  return {items, setItems, loading, error, hasMore: Boolean(cursor), sentinel, loadMore: () => load(true), reload: () => load()};
}
