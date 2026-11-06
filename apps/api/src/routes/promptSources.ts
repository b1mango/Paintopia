import type { PromptLibraryResponse } from "@paintopia/shared";
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { consumeRateLimit } from "../db/repository.js";
import { findCuratedPrompt, listCuratedPrompts } from "../services/curatedPrompts.js";
import { createPersistentPromptLibrary, promptSearchText } from "../services/promptSourceCache.js";

import { createPromptLibraryService, CURATED_SOURCE, PROMPT_SOURCES } from "../services/promptSources.js";
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const favoriteId = z.string().max(160).regex(new RegExp(`^(?:${PROMPT_SOURCES.map(source => escapeRegex(source.id)).join("|")}):[a-zA-Z0-9_-]+$`));
type Options = {
  db: AppDatabase;
  requireAuth: preHandlerAsyncHookHandler;
  cronSecret?: string;
  service?: ReturnType<typeof createPromptLibraryService>;
};
type Authenticated = FastifyRequest & { user: { id: string } };

/** Register once in createServer. Never deletes or rewrites legacy prompts. */
export async function registerPromptSourceRoutes(app: FastifyInstance, options: Options) {
  const { db, requireAuth } = options;
  const persistent = options.service ? undefined : await createPersistentPromptLibrary(db);
  const service = options.service ?? persistent!;
  app.get("/api/internal/refresh-prompt-sources", async (request, reply) => {
    if (!options.cronSecret || request.headers.authorization !== `Bearer ${options.cronSecret}`) {
      return reply.code(401).send({ error: "未授权" });
    }
    const result = persistent ? await persistent.refresh() : await service.list();
    return { updatedAt: result.fetchedAt, count: result.items.length, sourceErrors: result.sourceErrors };
  });
  const auth = { preHandler: requireAuth };
  app.get("/api/prompt-library", auth, async (request, reply) => {
    const userId = (request as Authenticated).user?.id;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const query = z.object({
      source: z.string().refine(id => id === "all" || PROMPT_SOURCES.some(source => source.id === id)).default("all"),
      q: z.string().max(200).default(""), tag: z.string().max(100).optional(),
      favorites: z.enum(["true", "false"]).default("false"),
      offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      limit: z.coerce.number().int().min(1).max(60).default(24),
      refresh: z.enum(["true", "false"]).optional()
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "提示词筛选参数无效" });
    let result;
    try { result = query.data.refresh === "true" && persistent ? await persistent.refresh() : await service.list(); }
    catch { return reply.code(503).send({ error: "公开提示词来源暂不可用，请稍后重试" }); }
    const rows = await db.query<{ promptId: string }>(
      'SELECT prompt_id AS "promptId" FROM sourced_prompt_favorites WHERE user_id = ?', [userId]
    );
    const favorites = new Set(rows.map((row) => row.promptId));
    const allItems = [...await listCuratedPrompts(db), ...result.items];
    const { source, q, tag, offset, limit } = query.data;
    const counts = new Map<string, number>();
    allItems.forEach(item => counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1));
    const selected = allItems.filter(item => (source === "all" || item.sourceId === source)
      && (query.data.favorites !== "true" || favorites.has(item.id)));
    const tagCounts = new Map<string, number>();
    selected.forEach(item => new Set<string>(item.tags).forEach(tag => tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)));
    const search = q.trim().toLowerCase();
    const filtered = selected.filter(item => (!tag || item.tags.includes(tag)) && (!search || promptSearchText(item).includes(search)));
    const response: PromptLibraryResponse = {
      sources: PROMPT_SOURCES.map(source => ({ ...source, count: counts.get(source.id) ?? 0 })),
      fetchedAt: result.fetchedAt, sourceErrors: result.sourceErrors,
      refreshNeeded: "refreshNeeded" in result && result.refreshNeeded === true,
      items: filtered.slice(offset, offset + limit).map(item => ({ ...item, favorite: favorites.has(item.id) })),
      total: filtered.length, offset, limit,
      tags: [...tagCounts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN")).slice(0, 200)
    };
    reply.header("Cache-Control", "private, no-store");
    return response;
  });
  async function findItem(id: string) {
    const sourceId = id.slice(0, id.indexOf(":"));
    if (sourceId === CURATED_SOURCE.id) return findCuratedPrompt(db, id.slice(sourceId.length + 1));
    return (await service.listSource(sourceId)).items.find(item => item.id === id);
  }
  app.get("/api/prompt-library/items/:id", auth, async (request, reply) => {
    const userId = (request as Authenticated).user?.id;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = z.object({ id: favoriteId }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "提示词 ID 无效" });
    let item;
    try { item = await findItem(params.data.id); }
    catch { return reply.code(503).send({ error: "来源暂不可用，请稍后重试" }); }
    if (!item) return reply.code(404).send({ error: "提示词不存在" });
    const favorite = await db.queryOne("SELECT prompt_id FROM sourced_prompt_favorites WHERE user_id = ? AND prompt_id = ?", [userId, item.id]);
    return reply.header("Cache-Control", "private, no-store").send({ ...item, favorite: Boolean(favorite) });
  });
  app.put("/api/prompt-library/:id/favorite", auth, async (request, reply) => {
    const userId = (request as Authenticated).user?.id;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = z.object({ id: favoriteId }).safeParse(request.params);
    const body = z.object({ favorite: z.boolean() }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "收藏参数无效" });
    if (!await consumeRateLimit(db, `prompt-source-favorite:${userId}`, 60, 60000)) {
      return reply.code(429).send({ error: "操作过于频繁，请稍后重试" });
    }
    const id = params.data.id;
    if (body.data.favorite) {
      let result;
      try { result = await findItem(id); }
      catch { return reply.code(503).send({ error: "来源暂不可用，收藏未保存" }); }
      if (!result) return reply.code(404).send({ error: "提示词不存在" });
      await db.execute(`INSERT INTO sourced_prompt_favorites (user_id, prompt_id, created_at)
        VALUES (?, ?, ?) ON CONFLICT (user_id, prompt_id) DO NOTHING`, [userId, id, Date.now()]);
    } else {
      await db.execute("DELETE FROM sourced_prompt_favorites WHERE user_id = ? AND prompt_id = ?", [userId, id]);
    }
    reply.header("Cache-Control", "private, no-store");
    return { id, favorite: body.data.favorite };
  });
}
