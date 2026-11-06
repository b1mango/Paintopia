import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { SourcedPrompt } from "@paintopia/shared";
import { createAppDatabase } from "../src/db/database.js";
import { createPersistentPromptLibrary } from "../src/services/promptSourceCache.js";
import { CURATED_SOURCE, EXTERNAL_PROMPT_SOURCES, PROMPT_SOURCES } from "../src/services/promptSources.js";
import { registerPromptSourceRoutes } from "../src/routes/promptSources.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
const item = (id: string, sourceId = EXTERNAL_PROMPT_SOURCES[0].id): SourcedPrompt => ({
  id: sourceId + ":" + id, sourceId, title: "Title " + id, text: "Original text", description: "Description", author: "Author",
  tags: ["shared", id], sourceUrl: "https://x.com/example/1", model: "gpt-image-2", favorite: false
});
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "prompt-page-"));
  const db = await createAppDatabase({ dataDir: dir, bootstrapEmail: "unused", bootstrapPassword: "unused", skipBootstrap: true });
  const app = Fastify();
  cleanup.push(async () => { await app.close(); await db.close(); await rm(dir, { recursive: true, force: true }); });
  for (const id of ["a", "b"]) await db.execute("INSERT INTO users (id,email,password_hash,role,status,quota,created_at,updated_at) VALUES (?,?,'unused','user','active',0,0,0)", [id, id]);
  const items = [item("first"), item("second"), item("third", EXTERNAL_PROMPT_SOURCES[1].id), item("fourth", EXTERNAL_PROMPT_SOURCES[2].id)];
  const now = Date.now();
  for (const source of EXTERNAL_PROMPT_SOURCES) await db.execute("UPDATE prompt_source_cache SET items_json = ?, fetched_at = ? WHERE source_id = ?", [JSON.stringify(items.filter(item => item.sourceId === source.id)), now, source.id]);
  await registerPromptSourceRoutes(app, { db, requireAuth: async request => {
    if (request.headers["x-user"]) Object.assign(request, { user: { id: request.headers["x-user"] } });
  } });
  const get = async (query = "", user = "a") => {
    const response = await app.inject({ url: "/api/prompt-library" + query, headers: { "x-user": user } });
    expect(response.statusCode, response.body).toBe(200); return response.json();
  };
  return { db, app, items, get };
}
it("paginates after filtering, keeps source counts and facets independent of q/tag, and preserves source order", async () => {
  const { app, get, items } = await setup();
  const page = await get("?offset=1&limit=2");
  expect(page).toMatchObject({ total: 4, offset: 1, limit: 2, refreshNeeded: false, sourceErrors: [] });
  expect(page.items.map((item: SourcedPrompt) => item.id)).toEqual(items.slice(1, 3).map(item => item.id));
  expect(page.sources.map((source: { id: string }) => source.id)).toEqual(PROMPT_SOURCES.map(source => source.id));
  expect(page.sources.map((source: { count: number }) => source.count)).toEqual([0, 2, 1, 1, 0]);
  expect(page.tags[0]).toEqual({ tag: "shared", count: 4 });
  expect((await get("?offset=100")).items).toEqual([]);
  const filtered = await get("?source=youmind-gpt-image-2&q=FIRST&tag=shared");
  expect(filtered.items.map((item: SourcedPrompt) => item.id)).toEqual([items[0].id]);
  expect(filtered.total).toBe(1);
  expect(filtered.tags).toEqual([{ tag: "shared", count: 2 }, { tag: "first", count: 1 }, { tag: "second", count: 1 }]);
  expect(filtered.sources).toEqual(page.sources);
  for (const q of ["TITLE", "original", "description", "AUTHOR", "shared"]) expect((await get("?q=" + q)).total).toBe(4);
  expect((await get("?source=paintopia-curated")).items).toEqual([]);
  expect((await app.inject({ url: "/api/prompt-library" })).statusCode).toBe(401);
  expect((await app.inject({ url: "/api/prompt-library", headers: { "x-user": "a" } })).headers["cache-control"]).toBe("private, no-store");
});
it("supports cross-source favorites and details without leaking another user's favorites", async () => {
  const { db, app, get, items } = await setup();
  for (const entry of [items[0], items[3]]) await db.execute("INSERT INTO sourced_prompt_favorites VALUES (?,?,0)", ["a", entry.id]);
  const page = await get("?favorites=true");
  expect(page.total).toBe(2); expect(page.items.every((item: SourcedPrompt) => item.favorite)).toBe(true);
  expect((await get("?favorites=true", "b")).total).toBe(0);
  expect((await get("?favorites=false")).total).toBe(4);
  expect(page.tags[0]).toEqual({ tag: "shared", count: 2 });
  const url = "/api/prompt-library/items/" + items[3].id;
  const detail = await app.inject({ url, headers: { "x-user": "a" } });
  expect(detail.statusCode).toBe(200); expect(detail.json()).toMatchObject({ id: items[3].id, favorite: true });
  expect(detail.headers["cache-control"]).toBe("private, no-store");
  expect((await app.inject({ url, headers: { "x-user": "b" } })).json().favorite).toBe(false);
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect((await app.inject({ url: "/api/prompt-library/items/awesome-gpt-image:missing", headers: { "x-user": "a" } })).statusCode).toBe(404);
  expect((await app.inject({ url: "/api/prompt-library/items/unknown:missing", headers: { "x-user": "a" } })).statusCode).toBe(400);
  for (const source of EXTERNAL_PROMPT_SOURCES) {
    const entry = item("new", source.id);
    await db.execute("UPDATE prompt_source_cache SET items_json = ?, fetched_at = fetched_at + 1 WHERE source_id = ?", [JSON.stringify([entry]), source.id]);
    expect((await app.inject({ method: "PUT", url: "/api/prompt-library/" + entry.id + "/favorite", headers: { "x-user": "a" }, payload: { favorite: true } })).statusCode).toBe(200);
  }
});
it("validates pagination and bounds tag facets", async () => {
  const { db, app, get } = await setup();
  for (const query of ["source=invalid", "q=" + "x".repeat(201), "offset=-1", "offset=1.5", "limit=0", "limit=61", "limit=NaN", "favorites=yes", "refresh=1"]) {
    expect((await app.inject({ url: "/api/prompt-library?" + query, headers: { "x-user": "a" } })).statusCode, query).toBe(400);
  }
  const items = Array.from({ length: 210 }, (_, i) => item(String(i)));
  await db.execute("UPDATE prompt_source_cache SET items_json = ?, fetched_at = fetched_at + 1 WHERE source_id = ?", [JSON.stringify(items), EXTERNAL_PROMPT_SOURCES[0].id]);
  const page = await get(); expect(page.items).toHaveLength(24); expect(page.tags).toHaveLength(200);
  expect(page.tags[0]).toEqual({ tag: "shared", count: 212 });
});
it("reuses decoded snapshots on warm requests and observes database changes from another instance", async () => {
  const { db } = await setup();
  const fetcher = vi.fn(async () => new Response("[]"));
  const service = await createPersistentPromptLibrary(db, fetcher);
  const first = await service.list();
  const query = vi.spyOn(db, "query");
  const warm = await service.list();
  expect(warm.items[0]).toBe(first.items[0]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]).not.toContain(", items_json");
  const replacement = item("new-version");
  await db.execute("UPDATE prompt_source_cache SET items_json = ?, fetched_at = fetched_at + 1, retry_at = ? WHERE source_id = ?", [JSON.stringify([replacement]), Date.now() + 30000, replacement.sourceId]);
  const updated = await service.list();
  expect(updated.items[0]).toEqual(replacement);
  expect(updated.sourceErrors[0].sourceId).toBe(replacement.sourceId);
  const restarted = await createPersistentPromptLibrary(db, fetcher);
  expect((await restarted.list()).items).toEqual(updated.items);
  expect(fetcher).not.toHaveBeenCalled();
  expect(CURATED_SOURCE.id).toBe("paintopia-curated");
});
