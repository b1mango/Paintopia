import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createServer } from "../src/createServer.js";
import type { AppDatabase } from "../src/db/database.js";
import { migrate } from "../src/db/migrate.js";
import { migratePostgres } from "../src/db/migratePostgres.js";
import { CURATED_PROMPT_MIGRATION_SQL } from "../src/db/curatedPromptMigration.js";
import type { AssetStorage } from "../src/services/assetStorage.js";
import type { CuratedPromptRecord } from "../src/services/curatedPrompts.js";
import { createSession } from "../src/services/authService.js";
import { createMediaEdgeUrl } from "../src/services/mediaEdge.js";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const close of closers.splice(0)) await close(); });
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "paintopia-curated-"));
  const app = await createServer({ dataDir: dir, bootstrapEmail: "admin@test.local", bootstrapPassword: "password", webOrigin: "http://localhost:5173", sessionSecret: "test" });
  closers.push(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const { paintopiaDb: db, paintopiaStorage: storage } = app as unknown as { paintopiaDb: AppDatabase; paintopiaStorage: AssetStorage };
  const admin = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE role = 'admin'"))!;
  await db.execute("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) VALUES('user','user@test.local','unused','user','active',100,1,1)");
  const adminCookie = "paintopia_session=" + await createSession(db, admin.id);
  const userCookie = "paintopia_session=" + await createSession(db, "user");
  await db.execute("UPDATE prompt_source_cache SET items_json = '[]', fetched_at = ?", [Date.now()]);
  const png = await sharp({ create: { width: 32, height: 48, channels: 3, background: "red" } }).png().toBuffer();
  async function seed(id = "art", owner = admin.id, status = "ready") {
    const key = "temporary/" + owner + "/" + id + ".png";
    await storage.put(key, png, "image/png");
    await db.execute("INSERT INTO assets(id,user_id,original_path,storage_backend,mime_type,status,expires_at,prompt,params_json,created_at) VALUES(?,?,?,'local','image/png',?,9999999999999,?,'{}',100)", [id, owner, key, status, "完整的站长提示词 abcdefghijklmnopqrstuvwxyz"]);
    return key;
  }
  const create = (payload: object = { assetId: "art" }, cookie: string | undefined = adminCookie) => app.inject({ method: "POST", url: "/api/admin/curated-prompts", headers: cookie ? { cookie } : {}, payload });
  const get = async (url: string, cookie = adminCookie) => { const response = await app.inject({ url, headers: { cookie } }); expect(response.statusCode, response.body).toBe(200); return response.json(); };
  return { app, db, storage, admin, adminCookie, userCookie, seed, create, get, png };
}
it("creates permanent copies and real thumbnails, exposes them to signed-in users, and survives source deletion", async () => {
  const { app, db, storage, seed, create, get, png, adminCookie, userCookie } = await setup();
  const original = await seed();
  await seed("unselected");
  const copy = vi.spyOn(storage, "copy");
  const response = await create({ assetId: "art", tags: ["插画", "精选", "插画"] });
  expect(response.statusCode, response.body).toBe(201);
  const curated = response.json();
  expect(curated).toMatchObject({ text: "完整的站长提示词 abcdefghijklmnopqrstuvwxyz", title: Array.from("完整的站长提示词 abcdefghijklmnopqrstuvwxyz").slice(0, 24).join(""), tags: ["插画", "精选"], width: 32, height: 48, sourceAssetId: "art", sortOrder: 0 });
  const row = (await db.queryOne<CuratedPromptRecord>("SELECT * FROM curated_prompts WHERE id = ?", [curated.id]))!;
  expect(row.object_key).toMatch(/^permanent\/curated\/[\w-]+\.png$/);
  expect(row.thumb_key).toMatch(/^permanent\/curated\/[\w-]+-thumb\.webp$/);
  expect(copy).toHaveBeenCalledWith(original, row.object_key, "image/png");
  expect(await storage.read(row.object_key)).toEqual(png);
  expect((await sharp(await storage.read(row.thumb_key)).metadata()).format).toBe("webp");
  expect((await db.queryOne<{ expires_at: number }>("SELECT expires_at FROM assets WHERE id = 'art'"))!.expires_at).toBe(9999999999999);
  expect((await create()).statusCode).toBe(409);
  const feed = await get("/api/media-feed/assets");
  expect(feed.items.find((item: { id: string }) => item.id === "art").curatedPromptId).toBe(curated.id);
  expect(feed.items.find((item: { id: string }) => item.id === "unselected").curatedPromptId).toBeNull();
  expect((await get("/api/assets")).find((item: { id: string }) => item.id === "art").curatedPromptId).toBe(curated.id);
  const fullId = "paintopia-curated:" + curated.id;
  const page = await get("/api/prompt-library?source=paintopia-curated", userCookie);
  expect(page.sources[0]).toMatchObject({ id: "paintopia-curated", count: 1, license: "站主原创" });
  expect(page.items[0]).toMatchObject({ id: fullId, author: "绘境", sourceUrl: "", coverUrl: "/api/curated-prompts/" + curated.id + "/thumbnail", imageUrl: "/api/curated-prompts/" + curated.id + "/image", width: 32, height: 48 });
  const favorite = await app.inject({ method: "PUT", url: "/api/prompt-library/" + fullId + "/favorite", headers: { cookie: userCookie }, payload: { favorite: true } });
  expect(favorite.statusCode, favorite.body).toBe(200);
  expect((await get("/api/prompt-library/items/" + fullId, userCookie)).favorite).toBe(true);
  expect((await get("/api/prompt-library/items/" + fullId)).favorite).toBe(false);
  expect((await get("/api/prompt-library?favorites=true", userCookie)).total).toBe(1);
  expect((await app.inject({ method: "DELETE", url: "/api/assets/art", headers: { cookie: adminCookie } })).statusCode).toBe(204);
  expect((await db.queryOne<CuratedPromptRecord>("SELECT * FROM curated_prompts WHERE id = ?", [curated.id]))!.source_asset_id).toBeNull();
  for (const kind of ["image", "thumbnail"]) {
    const url = "/api/curated-prompts/" + curated.id + "/" + kind;
    expect((await app.inject({ url })).statusCode).toBe(401);
    const media = await app.inject({ url, headers: { cookie: userCookie } });
    expect(media.statusCode, media.body).toBe(200);
    expect(media.headers["content-type"]).toContain(kind === "image" ? "image/png" : "image/webp");
  }
  expect((await db.query("SELECT action FROM audit_logs WHERE target_id = ?", [curated.id]))).toEqual([{ action: "curated_prompt.create" }]);
});
it("patches content and sort order, deletes only owned copies and records all admin actions", async () => {
  const { app, db, storage, seed, create, get, adminCookie } = await setup();
  const original = await seed(); await seed("second");
  const first = (await create()).json();
  const second = (await create({ assetId: "second", title: "Second" })).json();
  await db.execute("UPDATE curated_prompts SET created_at = 100 WHERE id = ?", [first.id]);
  await db.execute("UPDATE curated_prompts SET created_at = 200 WHERE id = ?", [second.id]);
  const order = async () => (await get("/api/prompt-library")).items.map((item: { id: string }) => item.id);
  expect(await order()).toEqual(["paintopia-curated:" + second.id, "paintopia-curated:" + first.id]);
  const patched = await app.inject({ method: "PATCH", url: "/api/admin/curated-prompts/" + first.id, headers: { cookie: adminCookie }, payload: { title: "Edited", text: "New text", description: "Summary", tags: ["new"], sortOrder: 9 } });
  expect(patched.statusCode, patched.body).toBe(200);
  expect(patched.json()).toMatchObject({ title: "Edited", text: "New text", description: "Summary", tags: ["new"], sortOrder: 9 });
  expect((await order())[0]).toBe("paintopia-curated:" + first.id);
  expect((await get("/api/prompt-library?q=summary")).total).toBe(1);
  const row = (await db.queryOne<CuratedPromptRecord>("SELECT * FROM curated_prompts WHERE id = ?", [first.id]))!;
  await db.execute("INSERT INTO sourced_prompt_favorites VALUES (?,?,0)", [row.created_by, "paintopia-curated:" + first.id]);
  const deleted = await app.inject({ method: "DELETE", url: "/api/admin/curated-prompts/" + first.id, headers: { cookie: adminCookie } });
  expect(deleted.statusCode).toBe(204);
  expect(await storage.head(row.object_key)).toBeUndefined(); expect(await storage.head(row.thumb_key)).toBeUndefined();
  expect(await storage.head(original)).toBeDefined();
  expect(await db.query("SELECT * FROM sourced_prompt_favorites")).toEqual([]);
  expect((await get("/api/assets")).find((item: { id: string }) => item.id === "art").curatedPromptId).toBeNull();
  expect((await app.inject({ url: "/api/curated-prompts/" + first.id + "/image", headers: { cookie: adminCookie } })).statusCode).toBe(404);
  expect((await db.query<{ action: string }>("SELECT action FROM audit_logs WHERE target_id = ? ORDER BY created_at", [first.id])).map(row => row.action)).toEqual(["curated_prompt.create", "curated_prompt.update", "curated_prompt.delete"]);
});
it("enforces admin-only mutations and input bounds without exposing markers to ordinary owners", async () => {
  const { app, db, seed, create, get, adminCookie, userCookie } = await setup();
  await seed("art", "user");
  expect((await app.inject({ method: "POST", url: "/api/admin/curated-prompts", payload: { assetId: "art" } })).statusCode).toBe(401);
  expect((await create({ assetId: "art" }, userCookie)).statusCode).toBe(403);
  expect((await create({ assetId: "missing" })).statusCode).toBe(404);
  await seed("uploading", "user", "uploading");
  expect((await create({ assetId: "uploading" })).statusCode).toBe(409);
  for (const body of [{ title: "x".repeat(81) }, { text: "x".repeat(20001) }, { text: " " }, { description: "x".repeat(501) }, { tags: Array(13).fill("tag") }, { tags: ["x".repeat(21)] }]) {
    expect((await create({ assetId: "art", ...body })).statusCode).toBe(400);
  }
  const curated = (await create()).json();
  const url = "/api/admin/curated-prompts/" + curated.id;
  for (const method of ["PATCH", "DELETE"] as const) {
    expect((await app.inject({ method, url, headers: { cookie: userCookie }, ...(method === "PATCH" ? { payload: { title: "x" } } : {}) })).statusCode).toBe(403);
    expect((await app.inject({ method, url, ...(method === "PATCH" ? { payload: { title: "x" } } : {}) })).statusCode).toBe(401);
  }
  for (const body of [{ title: "x".repeat(81) }, { text: "x".repeat(20001) }, { description: "x".repeat(501) }, { tags: Array(13).fill("tag") }, { tags: ["x".repeat(21)] }, { sortOrder: 1.5 }, { sortOrder: 2147483648 }]) {
    expect((await app.inject({ method: "PATCH", url, headers: { cookie: adminCookie }, payload: body })).statusCode).toBe(400);
  }
  expect((await get("/api/assets", userCookie)).find((item: { id: string }) => item.id === "art").curatedPromptId).toBeUndefined();
  expect((await get("/api/media-feed/assets", userCookie)).items.find((item: { id: string }) => item.id === "art").curatedPromptId).toBeUndefined();
  expect((await db.query("SELECT * FROM curated_prompts"))).toHaveLength(1);
});
it("handles simultaneous collection by retaining only the winning request's objects", async () => {
  const { db, storage, seed, create } = await setup(); await seed();
  const copy = storage.copy.bind(storage);
  let copies = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const targets: string[] = [];
  vi.spyOn(storage, "copy").mockImplementation(async (source, target, mime) => {
    targets.push(target); await copy(source, target, mime);
    if (++copies === 2) release(); await ready;
  });
  const results = await Promise.all([create(), create()]);
  expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
  const rows = await db.query<CuratedPromptRecord>("SELECT * FROM curated_prompts");
  expect(rows).toHaveLength(1);
  expect(await storage.head(rows[0].object_key)).toBeDefined();
  expect(await storage.head(rows[0].thumb_key)).toBeDefined();
  expect(await storage.head(targets.find(target => target !== rows[0].object_key)!)).toBeUndefined();
  expect(await db.query("SELECT * FROM audit_logs WHERE action = 'curated_prompt.create'")).toHaveLength(1);
});
it("cleans up copies on thumbnail or transaction failure and preserves the personal original", async () => {
  const { db, storage, seed, create } = await setup(); const original = await seed();
  const put = vi.spyOn(storage, "put").mockRejectedValueOnce(new Error("thumbnail unavailable"));
  const remove = vi.spyOn(storage, "delete");
  expect((await create()).statusCode).toBe(500);
  expect(await db.query("SELECT * FROM curated_prompts")).toEqual([]);
  expect(remove).toHaveBeenCalledTimes(2); expect(await storage.head(original)).toBeDefined();
  put.mockRestore(); remove.mockClear();
  vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("database unavailable"));
  expect((await create()).statusCode).toBe(500);
  expect(remove).toHaveBeenCalledTimes(2);
  for (const [key] of remove.mock.calls) expect(await storage.head(key)).toBeUndefined();
  expect(await storage.head(original)).toBeDefined();
});
it("uses already-supported edge keys while origin fallback remains usable", async () => {
  const { app, db, seed, create, get, userCookie } = await setup(); await seed();
  const curated = (await create()).json();
  vi.stubEnv("PAINTOPIA_MEDIA_EDGE_URL", "https://media.test");
  vi.stubEnv("PAINTOPIA_MEDIA_SIGNING_KEY", "test-only-signing-key");
  const row = (await db.queryOne<CuratedPromptRecord>("SELECT * FROM curated_prompts WHERE id = ?", [curated.id]))!;
  expect(createMediaEdgeUrl(row.object_key)).toMatch(/^\/edge\?/);
  expect(createMediaEdgeUrl(row.thumb_key)).toMatch(/^\/edge\?/);
  const item = (await get("/api/prompt-library?source=paintopia-curated", userCookie)).items[0];
  expect(new URL(item.coverUrl, "https://test.local").searchParams.get("key")).toBe(row.thumb_key);
  expect(new URL(item.imageUrl, "https://test.local").searchParams.get("key")).toBe(row.object_key);
  const fallback = await app.inject({ url: "/api/curated-prompts/" + curated.id + "/thumbnail", headers: { cookie: userCookie } });
  expect(fallback.statusCode).toBe(200); expect(fallback.headers.location).toBeUndefined();
});
it("applies the same curated DDL in SQLite and PostgreSQL and keeps migrations repeatable", async () => {
  const { db } = await setup();
  migrate(db.sqlite!.raw);
  const columns = await db.query<{ name: string }>("PRAGMA table_info(curated_prompts)");
  expect(columns.map(column => column.name)).toEqual(["id", "title", "text", "description", "tags", "object_key", "thumb_key", "mime_type", "width", "height", "sort_order", "source_asset_id", "created_by", "created_at", "updated_at"]);
  const unsafe = vi.fn().mockResolvedValue([]);
  await migratePostgres({ unsafe } as unknown as Parameters<typeof migratePostgres>[0]);
  expect(unsafe).toHaveBeenCalledWith(CURATED_PROMPT_MIGRATION_SQL);
});
