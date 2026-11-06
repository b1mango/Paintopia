import type { PromptLibraryResponse, PromptSource, SourcedPrompt } from "@paintopia/shared";
import { PROMPT_PAGE_SIZE, type PromptLibraryQuery } from "../src/features/prompts/promptLibraryApi";

/** 按 GET /api/prompt-library 的契约在内存里筛选、分页，供灵感页测试使用。 */
export function servePromptLibrary(items: SourcedPrompt[], sources: PromptSource[], extra: Partial<PromptLibraryResponse> = {}) {
  return async (query: PromptLibraryQuery): Promise<PromptLibraryResponse> => {
    const scoped = items.filter(item => query.source === "all" || item.sourceId === query.source);
    const tagCounts = new Map<string, number>();
    for (const tag of scoped.flatMap(item => item.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    const term = query.q.toLocaleLowerCase();
    const filtered = scoped.filter(item => (!query.favorites || item.favorite) && (!query.tag || item.tags.includes(query.tag))
      && (!term || [item.title, item.text, item.description, item.author, ...item.tags].join(" ").toLocaleLowerCase().includes(term)));
    const offset = query.offset ?? 0;
    return {
      sources: sources.map(source => ({ ...source, count: items.filter(item => item.sourceId === source.id).length })),
      items: filtered.slice(offset, offset + PROMPT_PAGE_SIZE),
      total: filtered.length, offset, limit: PROMPT_PAGE_SIZE,
      tags: [...tagCounts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
      fetchedAt: "2026-10-09T00:00:00Z", sourceErrors: [], refreshNeeded: false,
      ...extra
    };
  };
}
