
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppDatabase } from "../src/db/database.js";
import { createPromptLibraryService, createPromptSourceService, parsePromptSource25, parsePromptSource, PROMPT_SOURCE, PROMPT_SOURCE_25, EXTERNAL_PROMPT_SOURCES } from "../src/services/promptSources.js";
import { registerPromptSourceRoutes } from "../src/routes/promptSources.js";

// Test-only fixture: never imported into application data or initialization.
const row = { id: "youmind-gpt-image-2:test", title: "Fixture", prompt: "Prompt", description: "", tags: ["test"], author: "Author", sourceUrl: "https://x.com/example/status/1", coverUrl: "https://cms-assets.youmind.com/media/test.jpg", imageModel: "gpt-image-2" };
afterEach(() => vi.restoreAllMocks());

describe("public source boundary", () => {
  it("imports only original single-step 2.5 generation prompts, preserving exact original text", () => {
    const entry = {
      id: "original", title: { "zh-CN": "真实来源标题" }, summary: { en: "Summary" }, mode: "generate", inputs: [],
      model: { family: "GPT Image 2.5" }, prompt: { kind: "original", original_steps: ["Original exact text"] },
      tags: ["design"], source: { author: "Creator", url: "https://x.com/example/status/1" },
      previews: [{ url: "https://pbs.twimg.com/media/example.jpg" }], curation: { decision: "publish" }
    };
    const result = parsePromptSource25({ schema_version: 2, entries: [entry, entry,
      { ...entry, id: "edit", mode: "edit" }, { ...entry, id: "needs-image", inputs: ["reference image"] },
      { ...entry, id: "multi", prompt: { kind: "original", original_steps: ["one", "two"] } },
      { ...entry, id: "adapted", prompt: { kind: "adaptation", original_steps: ["text"] } }
    ] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "image-2-5:original", text: "Original exact text", model: "gpt-image-2.5", author: "Creator" });
    expect(() => parsePromptSource25({ schema_version: 3, entries: [entry] })).toThrow();
  });

  it("preserves provenance and rejects unsafe links, unknown models and duplicates", () => {
    const items = parsePromptSource([row, row, { ...row, id: "youmind-gpt-image-2:bad", sourceUrl: "http://127.0.0.1/" }, { ...row, id: "youmind-gpt-image-2:model", imageModel: "gpt-image-2.5" }, { ...row, id: "youmind-gpt-image-2:no-cover", coverUrl: "https://127.0.0.1/secret" }]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ text: row.prompt, author: row.author, sourceUrl: row.sourceUrl, favorite: false });
    expect(items[1].coverUrl).toBeUndefined();
    expect(() => parsePromptSource({ items: [row] })).toThrow();
    expect(() => parsePromptSource([{ bad: true }])).toThrow();
    expect(parsePromptSource([])).toEqual([]);
  });
  it("fetches fixed URL with redirect denial, coalesces and expires cache", async () => {
    let time = 0;
    const fetcher = vi.fn(async () => new Response(JSON.stringify([row])));
    const service = createPromptSourceService(fetcher, () => time);
    await Promise.all([service.list(), service.list()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(PROMPT_SOURCE.feedUrl, expect.objectContaining({ redirect: "error" }));
    time = 7 * 24 * 60 * 60 * 1000 + 1;
    await service.list();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not return stale or synthetic data after upstream failure", async () => {
    let time = 0;
    const fetcher = vi.fn(async () => new Response(JSON.stringify([row])));
    const service = createPromptSourceService(fetcher, () => time);
    await service.list(); time = 7 * 24 * 60 * 60 * 1000 + 1;
    fetcher.mockRejectedValue(new Error("upstream"));
    await expect(service.list()).rejects.toThrow("暂不可用");
    await expect(service.list()).rejects.toThrow("暂不可用");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects oversized source responses", async () => {
    const fetcher = vi.fn(async () => new Response("[]", { headers: { "content-length": "99999999" } }));
    await expect(createPromptSourceService(fetcher).list()).rejects.toThrow();
  });
  it("persists favorites across service recreation, isolates users and requires auth", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paintopia-source-test-"));
    const db = await createAppDatabase({ dataDir: dir, bootstrapEmail: "a@test.local", bootstrapPassword: "test-password", skipBootstrap: true });
    const service = createPromptLibraryService(vi.fn(async () => new Response(JSON.stringify([row]))));
    const app = Fastify();
    try {
      for (const id of ["user-a", "user-b"]) await db.execute("INSERT INTO users (id,email,password_hash,role,status,quota,created_at,updated_at) VALUES (?,?,'test','user','active',100,0,0)", [id, id + "@test.local"]);
      const requireAuth = async (request: FastifyRequest) => { const id = request.headers["x-test-user"]; if (typeof id === "string") (request as FastifyRequest & { user: { id: string } }).user = { id }; };
      await registerPromptSourceRoutes(app, { db, requireAuth, service });
      const url = "/api/prompt-library/" + encodeURIComponent(row.id) + "/favorite";
      expect((await app.inject({ method: "GET", url: "/api/prompt-library" })).statusCode).toBe(401);
      expect((await app.inject({ method: "PUT", url, payload: { favorite: true } })).statusCode).toBe(401);
      const headers = { "x-test-user": "user-a" };
      expect((await app.inject({ method: "PUT", url, headers, payload: { favorite: "true" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url, headers, payload: { favorite: true } })).statusCode).toBe(200);
      await app.inject({ method: "PUT", url, headers, payload: { favorite: true } });
      expect((await db.query("SELECT * FROM sourced_prompt_favorites"))).toHaveLength(1);
      const first = await app.inject({ method: "GET", url: "/api/prompt-library", headers });
      expect(first.json().items[0].favorite).toBe(true);
      expect(first.headers["cache-control"]).toBe("private, no-store");
      const second = await app.inject({ method: "GET", url: "/api/prompt-library", headers: { "x-test-user": "user-b" } });
      expect(second.json().items[0].favorite).toBe(false);
      const restarted = Fastify();
      await registerPromptSourceRoutes(restarted, { db, requireAuth, service: createPromptLibraryService(vi.fn(async () => new Response(JSON.stringify([row])))) });
      try { expect((await restarted.inject({ method: "GET", url: "/api/prompt-library", headers })).json().items[0].favorite).toBe(true); } finally { await restarted.close(); }
      await app.inject({ method: "PUT", url, headers: { "x-test-user": "user-b" }, payload: { favorite: false } });
      expect((await db.query("SELECT * FROM sourced_prompt_favorites"))).toHaveLength(1);
      await app.inject({ method: "PUT", url, headers, payload: { favorite: false } });
      expect((await db.query("SELECT * FROM sourced_prompt_favorites"))).toHaveLength(0);
      expect((await app.inject({ method: "PUT", url: "/api/prompt-library/youmind-gpt-image-2:unknown/favorite", headers, payload: { favorite: true } })).statusCode).toBe(404);
    } finally { await app.close(); await db.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

const entry25 = {
  id: "original", title: { "zh-CN": "2.5 测试作品" }, summary: { en: "Summary" }, mode: "generate", inputs: [],
  model: { family: "GPT Image 2.5" }, prompt: { kind: "original", original_steps: ["Original exact text"] },
  tags: ["design"], source: { author: "Creator", url: "https://x.com/example/status/1" },
  previews: [], curation: { decision: "publish" }
};
/** 旧模型与 2.5 各给一条；新增的两个公开来源返回健康的空列表。 */
function upstreamPayload(url: string) {
  if (url === PROMPT_SOURCE.feedUrl) return [row];
  return url === PROMPT_SOURCE_25.feedUrl ? { schema_version: 2, entries: [entry25] } : [];
}
const feedOf = (id: string) => id === "youmind-gpt-image-2" ? PROMPT_SOURCE.feedUrl : PROMPT_SOURCE_25.feedUrl;
describe("independent source availability", () => {
  it.each(["youmind-gpt-image-2", "image-2-5"])("returns healthy entries when %s fails and recovers after cooldown", async (failedId) => {
    let now = 0; let failed = true;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (failed && String(url) === feedOf(failedId)) return new Response("sensitive upstream error", { status: 503 });
      return new Response(JSON.stringify(upstreamPayload(String(url))));
    });
    const service = createPromptLibraryService(fetcher, () => now);
    const first = await service.list();
    expect(first.items).toHaveLength(1);
    expect(first.items[0].sourceId).not.toBe(failedId);
    expect(first.sourceErrors).toEqual([{ sourceId: failedId, message: "来源暂不可用，请稍后重试" }]);
    expect(first.fetchedAt).toBe(new Date(0).toISOString());
    const calls = EXTERNAL_PROMPT_SOURCES.length;
    await service.list();
    expect(fetcher).toHaveBeenCalledTimes(calls);
    failed = false; now = 30001;
    const recovered = await service.list();
    expect(recovered.items).toHaveLength(2);
    expect(recovered.sourceErrors).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(calls + 1); // Only failed source refetched; healthy cache reused.
  });
  it("reports both failed sources with no fabricated fetch timestamp or prompts", async () => {
    const service = createPromptLibraryService(vi.fn(async () => new Response("down", { status: 503 })));
    const result = await service.list();
    expect(result.items).toEqual([]);
    expect(result.fetchedAt).toBeNull();
    expect(result.sourceErrors.map((error) => error.sourceId)).toEqual(EXTERNAL_PROMPT_SOURCES.map((source) => source.id));
    await expect(service.listSource("http://127.0.0.1")).rejects.toThrow("未知提示词来源");
  });
  it.each(["youmind-gpt-image-2", "image-2-5"])("API can favorite %s without contacting the other failed source", async (healthyId) => {
    const dir = await mkdtemp(path.join(tmpdir(), "paintopia-partial-source-"));
    const db = await createAppDatabase({ dataDir: dir, bootstrapEmail: "a@test.local", bootstrapPassword: "test-password", skipBootstrap: true });
    const app = Fastify();
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === feedOf(healthyId === "youmind-gpt-image-2" ? "image-2-5" : "youmind-gpt-image-2")) return new Response("down", { status: 503 });
      return new Response(JSON.stringify(upstreamPayload(String(url))));
    });
    const service = createPromptLibraryService(fetcher);
    try {
      await db.execute("INSERT INTO users (id,email,password_hash,role,status,quota,created_at,updated_at) VALUES ('user-a','a@test.local','test','user','active',100,0,0)");
      const requireAuth = async (request: FastifyRequest) => { (request as FastifyRequest & { user: { id: string } }).user = { id: "user-a" }; };
      await registerPromptSourceRoutes(app, { db, requireAuth, service });
      const healthyPrompt = healthyId === "youmind-gpt-image-2" ? row.id : "image-2-5:original";
      const failedPrompt = healthyId === "youmind-gpt-image-2" ? "image-2-5:original" : row.id;
      const favoriteUrl = (id: string) => "/api/prompt-library/" + encodeURIComponent(id) + "/favorite";
      const saved = await app.inject({ method: "PUT", url: favoriteUrl(healthyPrompt), payload: { favorite: true } });
      expect(saved.statusCode).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0][0]) === PROMPT_SOURCE.feedUrl).toBe(healthyId === "youmind-gpt-image-2");
      const listed = await app.inject({ method: "GET", url: "/api/prompt-library" });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items).toHaveLength(1);
      expect(listed.json().items[0]).toMatchObject({ id: healthyPrompt, favorite: true });
      expect(listed.json().sourceErrors).toHaveLength(1);
      expect(listed.json().sourceErrors[0].sourceId).not.toBe(healthyId);
      expect((await app.inject({ method: "PUT", url: favoriteUrl(failedPrompt), payload: { favorite: true } })).statusCode).toBe(503);
      const callCount = fetcher.mock.calls.length;
      expect((await app.inject({ method: "PUT", url: favoriteUrl(failedPrompt), payload: { favorite: false } })).statusCode).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(callCount); // Removing a favorite never needs upstream.
      expect((await db.query("SELECT * FROM sourced_prompt_favorites"))).toHaveLength(1);
    } finally { await app.close(); await db.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
