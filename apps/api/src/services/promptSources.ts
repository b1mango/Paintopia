import type { PromptSource, PromptSourceError, SourcedPrompt } from "@paintopia/shared";
import { z } from "zod";

/** Fixed upstream URL only. No user-supplied URL, image proxy, or redirect following. */
export const PROMPT_SOURCE: Readonly<PromptSource> = Object.freeze({
  id: "youmind-gpt-image-2",
  name: "YouMind · GPT Image 2",
  homepage: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2",
  feedUrl: "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/youmind-gpt-image-2.json",
  license: "CC BY 4.0",
  licenseUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2/blob/main/LICENSE",
  aggregatorUrl: "https://github.com/yukkcat/image-prompts",
  aggregatorLicenseUrl: "https://github.com/yukkcat/image-prompts/blob/main/LICENSE",
  model: "gpt-image-2",
  compatibilityNote: "来源标注 GPT Image 2；可选用文本尝试当前模型，GPT-image-2.5 效果尚未验证。"
});

/** Source prompts/media retain creator rights; MIT covers repository tooling/docs. */
export const PROMPT_SOURCE_25: Readonly<PromptSource> = Object.freeze({
  id: "image-2-5", name: "Image 2.5 · 来源作品集",
  homepage: "https://github.com/wangrunlin/awesome-gpt-image-2-5-prompts",
  feedUrl: "https://raw.githubusercontent.com/wangrunlin/awesome-gpt-image-2-5-prompts/main/data/catalog.json",
  license: "MIT（工具与原创文档）；提示词/图片按原作者条款",
  licenseUrl: "https://github.com/wangrunlin/awesome-gpt-image-2-5-prompts/blob/main/README.md#license",
  aggregatorUrl: "https://github.com/wangrunlin/awesome-gpt-image-2-5-prompts",
  aggregatorLicenseUrl: "https://github.com/wangrunlin/awesome-gpt-image-2-5-prompts/blob/main/LICENSE",
  model: "gpt-image-2.5",
  compatibilityNote: "来源作者标注 GPT Image 2.5，本站未独立生图验证。只收录单步文生图原文；编辑/多步骤案例请到来源查阅。"
});
export const CURATED_SOURCE: Readonly<PromptSource> = Object.freeze({
  id: "paintopia-curated", name: "站主推荐", homepage: "https://paintopia.b1mango.cc",
  feedUrl: "/api/prompt-library?source=paintopia-curated", license: "站主原创",
  licenseUrl: "", aggregatorUrl: "", aggregatorLicenseUrl: "",
  model: "gpt-image-2", compatibilityNote: "站主推荐的提示词与本站生成的效果图。"
});
export const FREESTYLEFLY_SOURCE: Readonly<PromptSource> = Object.freeze({
  ...PROMPT_SOURCE, id: "freestylefly-gpt-image-2", name: "Freestylefly · GPT Image 2",
  homepage: "https://github.com/freestylefly/awesome-gpt-image-2",
  feedUrl: "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/freestylefly-gpt-image-2.json",
  license: "MIT", licenseUrl: "https://github.com/freestylefly/awesome-gpt-image-2/blob/main/LICENSE",
  compatibilityNote: "来源标注 GPT Image 2，本站未独立验证。"
});
export const ZEROLU_SOURCE: Readonly<PromptSource> = Object.freeze({
  ...PROMPT_SOURCE, id: "awesome-gpt-image", name: "ZeroLu · Awesome GPT Image",
  homepage: "https://github.com/ZeroLu/awesome-gpt-image",
  feedUrl: "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/awesome-gpt-image.json",
  license: "MIT", licenseUrl: "https://github.com/ZeroLu/awesome-gpt-image/blob/main/LICENSE",
  compatibilityNote: "来源标注 GPT Image 2，本站未独立验证。"
});
export const PROMPT_SOURCES = [CURATED_SOURCE, PROMPT_SOURCE, PROMPT_SOURCE_25, FREESTYLEFLY_SOURCE, ZEROLU_SOURCE] as const;
export const EXTERNAL_PROMPT_SOURCES = PROMPT_SOURCES.filter(source => source.id !== CURATED_SOURCE.id);
const localized = z.object({ "zh-CN": z.string().max(3000).optional(), en: z.string().max(3000).optional() });
const source25Item = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/), title: localized, summary: localized,
  mode: z.literal("generate"), inputs: z.array(z.unknown()).max(0),
  model: z.object({ family: z.literal("GPT Image 2.5") }),
  prompt: z.object({ kind: z.literal("original"), original_steps: z.array(z.string().min(1).max(20000).refine((text) => text.trim().length > 0)).length(1) }),
  tags: z.array(z.string().max(100)).max(40),
  source: z.object({ author: z.string().max(200), url: z.string().max(2000) }),
  previews: z.array(z.object({ url: z.string().max(2000) })).max(30),
  curation: z.object({ decision: z.literal("publish") })
});
export function parsePromptSource25(payload: unknown): SourcedPrompt[] {
  const root = z.object({ schema_version: z.literal(2), entries: z.array(z.unknown()).max(5000) }).parse(payload);
  const seen = new Set<string>(); const items: SourcedPrompt[] = [];
  for (const value of root.entries) {
    const parsed = source25Item.safeParse(value); if (!parsed.success) continue;
    const row = parsed.data; const title = row.title["zh-CN"] || row.title.en;
    const sourceUrl = safeUrl(row.source.url, ["x.com", "twitter.com", "developers.openai.com", "openai.com"]);
    if (!title || !sourceUrl || seen.has(row.id)) continue;
    seen.add(row.id);
    items.push({
      id: "image-2-5:" + row.id, sourceId: PROMPT_SOURCE_25.id, title,
      text: row.prompt.original_steps[0], description: row.summary["zh-CN"] || row.summary.en || "",
      tags: [...new Set(["GPT Image 2.5", ...row.tags])], author: row.source.author, sourceUrl,
      coverUrl: safeUrl(row.previews[0]?.url, ["pbs.twimg.com", "developers.openai.com"]),
      model: "gpt-image-2.5", favorite: false
    });
  }
  if (root.entries.length && !items.length) throw new Error("来源未返回可识别的单步文生图提示词");
  return items;
}

const upstreamItem = z.object({
  id: z.string().min(1).max(160),
  sourceId: z.string().optional(),
  title: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(20000),
  description: z.string().max(2000).optional().default(""),
  tags: z.array(z.string().max(100)).max(40).optional().default([]),
  author: z.string().max(200).optional().default(""),
  sourceUrl: z.string().max(2000),
  coverUrl: z.string().max(2000).optional(),
  imageModel: z.string().min(1).max(100)
});

function safeUrl(value: string | undefined, hosts: string[]): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

function coverUrl(value: string | undefined): string | undefined {
  const safe = safeUrl(value, ["raw.githubusercontent.com", "github.com", "pbs.twimg.com", "cms-assets.youmind.com"]);
  if (!safe) return undefined;
  const url = new URL(safe);
  if (url.hostname === "github.com" && !/^\/user-attachments\/assets\/[^/]+$/.test(url.pathname)) return undefined;
  if (url.hostname === "raw.githubusercontent.com") {
    const match = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    return match ? `https://cdn.jsdelivr.net/gh/${match[1]}/${match[2]}@${match[3]}/${match[4]}${url.search}` : undefined;
  }
  return safe;
}

export function parsePromptSource(payload: unknown, source: PromptSource = PROMPT_SOURCE): SourcedPrompt[] {
  if (!Array.isArray(payload) || payload.length > 5000) throw new Error("提示词来源格式异常");
  const seen = new Set<string>();
  const items: SourcedPrompt[] = [];
  const idPattern = new RegExp(`^${escapeRegex(source.id)}:[a-zA-Z0-9_-]+$`);
  for (const value of payload) {
    const result = upstreamItem.safeParse(value);
    if (!result.success) continue;
    const row = result.data;
    if (!idPattern.test(row.id) || row.imageModel !== source.model || (row.sourceId !== undefined && row.sourceId !== source.id)) continue;
    const sourceUrl = safeUrl(row.sourceUrl, ["x.com", "twitter.com", "github.com", "youmind.com", "opennana.com", "mp.weixin.qq.com"]);
    if (!sourceUrl || seen.has(row.id)) continue;
    seen.add(row.id);
    items.push({
      id: row.id, sourceId: source.id, title: row.title, text: row.prompt,
      description: row.description, tags: [...new Set(row.tags)], author: row.author,
      sourceUrl, coverUrl: coverUrl(row.coverUrl),
      model: row.imageModel, favorite: false
    });
  }
  if (payload.length > 0 && items.length === 0) throw new Error("来源未返回可识别的提示词");
  return items;
}

export const PROMPT_SOURCE_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache public source content only; favorites are read per request and per user. */
export function createPromptSourceService(fetcher: typeof fetch = fetch, now = Date.now, sourceId = PROMPT_SOURCE.id) {
  const source = EXTERNAL_PROMPT_SOURCES.find((item) => item.id === sourceId);
  if (!source) throw new Error("未知提示词来源");
  let cache: { items: SourcedPrompt[]; fetchedAt: string; expiresAt: number } | undefined;
  let pending: Promise<{ items: SourcedPrompt[]; fetchedAt: string }> | undefined;
  let retryAt = 0;
  async function refresh() {
    try {
      const response = await fetcher(source!.feedUrl, {
        redirect: "error", signal: AbortSignal.timeout(12000),
        headers: { Accept: "application/json" }
      });
      if (!response.ok || !response.body) throw new Error("来源暂不可用");
      const limit = 4 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body.cancel();
        throw new Error("来源响应过大");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let content = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); throw new Error("来源响应过大"); }
          content += decoder.decode(value, { stream: true });
        }
        content += decoder.decode();
      } finally { reader.releaseLock(); }
      const items = sourceId === "image-2-5" ? parsePromptSource25(JSON.parse(content)) : parsePromptSource(JSON.parse(content), source);
      cache = { items, fetchedAt: new Date(now()).toISOString(), expiresAt: now() + PROMPT_SOURCE_UPDATE_INTERVAL_MS };
      retryAt = 0;
      return cache;
    } catch {
      retryAt = now() + 30000;
      throw new Error("公开提示词来源暂不可用，请稍后重试");
    }
  }
  return {
    async list() {
      if (cache && cache.expiresAt > now()) return cache;
      if (pending) return pending;
      if (now() < retryAt) throw new Error("公开提示词来源暂不可用，请稍后重试");
      pending = refresh().finally(() => { pending = undefined; });
      return pending;
    }
  };
}

export function createPromptLibraryService(fetcher: typeof fetch = fetch, now = Date.now) {
  const services = EXTERNAL_PROMPT_SOURCES.map((source) => ({
    source,
    service: createPromptSourceService(fetcher, now, source.id)
  }));
  return {
    async list() {
      const results = await Promise.allSettled(services.map(({ service }) => service.list()));
      const items: SourcedPrompt[] = [];
      const fetchedTimes: string[] = [];
      const sourceErrors: PromptSourceError[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          items.push(...result.value.items);
          fetchedTimes.push(result.value.fetchedAt);
        } else {
          // Do not expose upstream response bodies, URL details, or transport exceptions.
          sourceErrors.push({ sourceId: services[index].source.id, message: "来源暂不可用，请稍后重试" });
        }
      });
      return { items, fetchedAt: fetchedTimes.sort()[0] ?? null, sourceErrors };
    },
    async listSource(sourceId: string) {
      const entry = services.find(({ source }) => source.id === sourceId);
      if (!entry) throw new Error("未知提示词来源");
      return entry.service.list();
    }
  };
}


const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
