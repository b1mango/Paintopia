import type { CuratedPrompt, PromptLibraryResponse, SourcedPrompt } from "@paintopia/shared";

export const CURATED_SOURCE_ID = "paintopia-curated";
export const PROMPT_PAGE_SIZE = 24;

export type PromptLibraryQuery = { source: string; q: string; tag: string; favorites: boolean; offset?: number };
/** 列表里的站主推荐 id 带来源前缀，管理接口只认裸 id。 */
export const curatedBareId = (id: string) => id.slice(CURATED_SOURCE_ID.length + 1);
export type CuratedPromptPatch = { title?: string; text?: string; description?: string; tags?: string[] };

async function request<T>(path: string, options: RequestInit, failure: string): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...options });
  if (!response.ok) {
    if (response.status === 401) throw new Error("登录已失效，请重新登录后查看提示词库");
    if (response.status === 409) throw new Error("这张图已在站主推荐中");
    if (response.status === 429) throw new Error("操作过于频繁，请稍后重试");
    throw new Error(failure);
  }
  return (response.status === 204 ? undefined : response.json()) as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const promptLibraryApi = {
  list(query: PromptLibraryQuery, { signal, refresh = false }: { signal?: AbortSignal; refresh?: boolean } = {}) {
    const params = new URLSearchParams({ source: query.source, offset: String(query.offset ?? 0), limit: String(PROMPT_PAGE_SIZE) });
    if (query.q) params.set("q", query.q);
    if (query.tag) params.set("tag", query.tag);
    if (query.favorites) params.set("favorites", "true");
    if (refresh) params.set("refresh", "true");
    return request<PromptLibraryResponse>("/api/prompt-library?" + params, { signal }, "提示词来源暂不可用，请稍后重试");
  },
  setFavorite(id: string, favorite: boolean) {
    return request<{ id: string; favorite: boolean }>("/api/prompt-library/" + encodeURIComponent(id) + "/favorite", json("PUT", { favorite }), "收藏保存失败，请重试");
  },
  curate(assetId: string) {
    return request<CuratedPrompt>("/api/admin/curated-prompts", json("POST", { assetId }), "加入站主推荐失败，请重试");
  },
  /** 保存后把返回的 CuratedPrompt 合回列表项，保留收藏状态等列表字段。 */
  async updateCurated(item: SourcedPrompt, patch: CuratedPromptPatch): Promise<SourcedPrompt> {
    const saved = await request<CuratedPrompt>("/api/admin/curated-prompts/" + encodeURIComponent(curatedBareId(item.id)), json("PATCH", patch), "保存失败，请重试");
    return { ...item, title: saved.title, text: saved.text, description: saved.description ?? "", tags: saved.tags, coverUrl: saved.coverUrl, imageUrl: saved.imageUrl, width: saved.width, height: saved.height };
  },
  removeCurated(id: string) {
    return request<void>("/api/admin/curated-prompts/" + encodeURIComponent(curatedBareId(id)), { method: "DELETE" }, "移出失败，请重试");
  }
};
