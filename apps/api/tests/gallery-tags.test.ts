import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GALLERY_TAGS } from "@paintopia/shared";
import { createServer } from "../src/createServer.js";
import type { AppDatabase } from "../src/db/database.js";
import { findAsset, findGallery, listGalleryTags } from "../src/db/repository.js";
import type { AssetStorage } from "../src/services/assetStorage.js";
import { createSession } from "../src/services/authService.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0)) await close(); });

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "paintopia-gallery-tags-"));
  const app = await createServer({ dataDir: dir, bootstrapEmail: "admin@test.local", bootstrapPassword: "password", webOrigin: "http://localhost:5173", sessionSecret: "test" });
  closers.push(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const db = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
  const storage = (app as unknown as { paintopiaStorage: AssetStorage }).paintopiaStorage;
  const admin = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE role='admin'"))!;
  await db.execute("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) VALUES('user','user@test.local','unused','user','active',100,1,1)");
  const adminCookie = `paintopia_session=${await createSession(db, admin.id)}`;
  const userCookie = `paintopia_session=${await createSession(db, "user")}`;
  async function seed(id = "art", status = "pending", prompt = "untitled", createdAt = 100) {
    await storage.put(`temporary/${id}.png`, png, "image/png");
    await storage.put(`pending/${id}.png`, png, "image/png");
    await db.execute("INSERT INTO assets(id,user_id,original_path,storage_backend,mime_type,status,expires_at,prompt,params_json,created_at) VALUES(?,'user',?,'local','image/png','ready',9999999999999,?,'{}',?)", [id, `temporary/${id}.png`, prompt, createdAt]);
    await db.execute("INSERT INTO gallery_items(id,asset_id,user_id,title,prompt,status,object_key,created_at) VALUES(?,?,'user','untitled',?,?,?,?)", [id, id, prompt, status, `pending/${id}.png`, createdAt]);
  }
  const patch = (id: string, payload: object, cookie = adminCookie, suffix = "") => app.inject({ method: "PATCH", url: `/api/admin/gallery-review/${id}${suffix}`, headers: { cookie }, payload });
  const get = async (url: string, cookie = adminCookie) => { const response = await app.inject({ url, headers: { cookie } }); expect(response.statusCode, response.body).toBe(200); return response.json(); };
  return { app, db, storage, seed, patch, get, adminCookie, userCookie };
}

describe("manual gallery tags", () => {
  it("creates custom tags, reuses normalized names and built-in vocabulary, and lists tags for signed-in users", async () => {
    const { app, db, get, adminCookie, userCookie } = await setup();
    const create = (label: string, group = "style") => app.inject({
      method: "POST", url: "/api/admin/gallery-tags", headers: { cookie: adminCookie }, payload: { label, group }
    });
    expect((await app.inject({ url: "/api/gallery-tags" })).statusCode).toBe(401);
    const response = await create("  Poster  ");
    expect(response.statusCode, response.body).toBe(201);
    const tag = response.json();
    expect(tag).toEqual({ id: expect.stringMatching(/^custom-[0-9a-f]{8}$/), label: "Poster", aliases: [], group: "style" });
    for (const label of ["poster", "  POSTER  "]) {
      const duplicate = await create(label, "subject");
      expect(duplicate.statusCode, duplicate.body).toBe(200);
      expect(duplicate.json()).toEqual(tag);
    }
    for (const label of [" Portrait ", "PEOPLE", "人像"]) {
      const builtin = await create(label);
      expect(builtin.statusCode, builtin.body).toBe(200);
      expect(builtin.json()).toEqual(GALLERY_TAGS.find((tag) => tag.id === "portrait"));
    }
    await db.execute("UPDATE gallery_tags SET created_at = 1 WHERE id = ?", [tag.id]);
    const second = await create("海报", "subject");
    expect(second.statusCode, second.body).toBe(201);
    expect((await get("/api/gallery-tags", userCookie)).tags).toEqual([...GALLERY_TAGS, tag, second.json()]);
    const stored = await db.queryOne<{ created_by: string; created_at: number }>("SELECT created_by, created_at FROM gallery_tags WHERE id = ?", [second.json().id]);
    expect(stored!.created_at).toBeGreaterThan(0);
    const audit = await db.query("SELECT actor_user_id, action, target_type, target_id, detail_json FROM audit_logs WHERE action = 'gallery.tag.create' ORDER BY created_at");
    expect(audit).toHaveLength(2);
    expect(audit[1]).toEqual({ actor_user_id: stored!.created_by, action: "gallery.tag.create", target_type: "gallery_tag", target_id: second.json().id, detail_json: JSON.stringify({ label: "海报", group: "subject" }) });
  });

  it("counts only tags on works the viewer can see in the gallery", async () => {
    const { app, db, seed, get, adminCookie, userCookie } = await setup();
    await db.execute("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) VALUES('viewer','viewer@test.local','unused','user','active',100,1,1)");
    const viewerCookie = `paintopia_session=${await createSession(db, "viewer")}`;
    await seed("live", "approved");
    await seed("draft", "pending");
    const tag = (item: string, tagId: string) => db.execute("INSERT INTO gallery_item_tags(gallery_item_id, tag_id) VALUES(?, ?)", [item, tagId]);
    await tag("live", "city"); await tag("live", "portrait"); await tag("draft", "city"); await tag("draft", "dreamcore");
    expect((await app.inject({ url: "/api/gallery-tags/in-use" })).statusCode).toBe(401);
    expect((await get("/api/gallery-tags/in-use", viewerCookie)).counts).toEqual({ city: 1, portrait: 1 });
    expect((await get("/api/gallery-tags/in-use", userCookie)).counts).toEqual({ city: 2, portrait: 1, dreamcore: 1 });
    expect((await get("/api/gallery-tags/in-use", adminCookie)).counts).toEqual({ city: 2, portrait: 1, dreamcore: 1 });
  });

  it("restricts tag creation to admins and validates trimmed labels and groups", async () => {
    const { app, adminCookie, userCookie } = await setup();
    const create = (payload: object, cookie?: string) => app.inject({
      method: "POST", url: "/api/admin/gallery-tags", headers: cookie ? { cookie } : {}, payload
    });
    expect((await create({ label: "海报", group: "style" })).statusCode).toBe(401);
    expect((await create({ label: "海报", group: "style" }, userCookie)).statusCode).toBe(403);
    for (const label of ["", "   ", "海".repeat(21)]) {
      const invalid = await create({ label, group: "style" }, adminCookie);
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.json().details[0].message).toContain("标签名称");
    }
    expect((await create({ label: "海报", group: "invalid" }, adminCookie)).statusCode).toBe(400);
    expect((await create({ label: "海".repeat(20), group: "scene" }, adminCookie)).statusCode).toBe(201);
  });

  it("returns the same tag when concurrent normalized names conflict at the unique index", async () => {
    const { app, db, adminCookie } = await setup();
    const transaction = db.transaction.bind(db);
    let release!: () => void;
    const bothCreating = new Promise<void>((resolve) => { release = resolve; });
    let creating = 0;
    vi.spyOn(db, "transaction").mockImplementation(async (work) => {
      if (++creating === 2) release();
      await bothCreating;
      return transaction(work);
    });
    const responses = await Promise.all(["Poster", "  POSTER  "].map((label) => app.inject({
      method: "POST", url: "/api/admin/gallery-tags", headers: { cookie: adminCookie }, payload: { label, group: "style" }
    })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(responses[0].json()).toEqual(responses[1].json());
    expect(await db.query("SELECT id FROM gallery_tags")).toHaveLength(1);
    expect(await db.query("SELECT id FROM audit_logs WHERE action = 'gallery.tag.create'")).toHaveLength(1);
  });

  it("publishes and edits custom tags, serializes their labels and filters and searches the feed", async () => {
    const { app, db, seed, patch, get, adminCookie, userCookie } = await setup();
    const create = async (label: string) => {
      const response = await app.inject({ method: "POST", url: "/api/admin/gallery-tags", headers: { cookie: adminCookie }, payload: { label, group: "style" } });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    };
    const poster = await create("海报");
    await db.execute("UPDATE gallery_tags SET created_at = 1 WHERE id = ?", [poster.id]);
    const cover = await create("Cover Design");
    await seed();
    await seed("other", "approved", "untitled", 200);
    const approved = await patch("art", { decision: "approve", tagIds: [poster.id, "city"] });
    expect(approved.statusCode, approved.body).toBe(200);
    const city = GALLERY_TAGS.find((tag) => tag.id === "city");
    expect(approved.json().tags).toEqual([city, poster]);
    expect((await get("/api/gallery", userCookie)).find((item: { id: string }) => item.id === "art").tags).toEqual([city, poster]);
    expect((await get("/api/admin/gallery-review?status=approved")).find((item: { id: string }) => item.id === "art").tags).toEqual([city, poster]);
    const edited = await patch("art", { tagIds: [cover.id, poster.id, "city"] }, undefined, "/tags");
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().tags).toEqual([city, poster, cover]);
    for (const query of [`category=${poster.id}`, `search=${encodeURIComponent(poster.label)}`, `search=${encodeURIComponent("cover design")}`]) {
      const feed = await get(`/api/media-feed/gallery?${query}`, userCookie);
      expect(feed.items.map((item: { id: string }) => item.id)).toEqual(["art"]);
      expect(feed.items[0].tags).toEqual([city, poster, cover]);
    }
    expect((await get(`/api/media-feed/assets?category=${poster.id}`, userCookie)).items.map((item: { id: string }) => item.id)).toEqual(["art"]);
    for (const kind of ["gallery", "assets"]) {
      const invalid = await app.inject({ url: `/api/media-feed/${kind}?category=custom-unknown`, headers: { cookie: userCookie } });
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.json().details).toContainEqual({ path: ["category"], message: "无效画廊标签", code: "custom" });
    }
    const invalid = await patch("art", { tagIds: ["custom-unknown"] }, undefined, "/tags");
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(invalid.json().details).toContainEqual({ path: ["tagIds", 0], message: "无效画廊标签", code: "custom" });
    expect((await listGalleryTags(db, ["art"])).get("art")).toEqual([city, poster, cover]);
  });

  it.each(["approve", "tags"])("returns a conflict if a work is withdrawn immediately after %s commits", async (action) => {
    const { app, seed, patch, db, userCookie } = await setup();
    await seed("art", action === "tags" ? "approved" : "pending");
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (work) => {
      const result = await transaction(work);
      const removed = await app.inject({ method: "DELETE", url: "/api/assets/art/gallery", headers: { cookie: userCookie } });
      expect(removed.statusCode).toBe(200);
      return result;
    });
    const response = await patch("art", action === "tags" ? { tagIds: ["city"] } : { decision: "approve", tagIds: ["city"] }, undefined, action === "tags" ? "/tags" : "");
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error).toContain("撤回");
    expect(await findGallery(db, "art")).toBeUndefined();
    expect((await listGalleryTags(db, ["art"])).get("art")).toEqual([]);
  });

  it("requires admin access and 1–8 unique vocabulary IDs before publishing", async () => {
    const { app, seed, patch, db, userCookie } = await setup();
    await seed();
    const valid = { decision: "approve", tagIds: ["city"] };
    expect((await app.inject({ method: "PATCH", url: "/api/admin/gallery-review/art", payload: valid })).statusCode).toBe(401);
    expect((await patch("art", valid, userCookie)).statusCode).toBe(403);
    for (const tagIds of [undefined, [], ["made-up"], ["city", "city"], GALLERY_TAGS.slice(0, 9).map((tag) => tag.id)]) {
      expect((await patch("art", { decision: "approve", tagIds })).statusCode).toBe(400);
    }
    expect((await findGallery(db, "art"))!.status).toBe("pending");
    expect((await listGalleryTags(db, ["art"])).get("art")).toEqual([]);
    expect((await patch("art", { decision: "reject", reason: "不适合公开" })).statusCode).toBe(200);
  });

  it("persists publication, tags and permanent asset reference together and supports editing legacy tags", async () => {
    const { seed, patch, db, storage, get, userCookie } = await setup();
    await seed();
    const response = await patch("art", { decision: "approve", tagIds: ["city", "illustration"] });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().tags.map((tag: { id: string }) => tag.id)).toEqual(["city", "illustration"]);
    const asset = (await findAsset(db, "art"))!;
    expect(asset.expiresAt).toBeNull();
    expect(asset.originalPath).toBe((await findGallery(db, "art"))!.objectKey);
    expect(await storage.read(asset.originalPath)).toEqual(png);
    expect((await get("/api/gallery"))[0].tags).toEqual(response.json().tags);
    expect((await get("/api/admin/gallery-review?status=approved"))[0].tags).toEqual(response.json().tags);
    expect((await get("/api/media-feed/gallery" )).items[0].tags).toEqual(response.json().tags);
    expect((await patch("art", { tagIds: ["portrait"] }, userCookie, "/tags")).statusCode).toBe(403);
    expect((await patch("art", { tagIds: [] }, undefined, "/tags")).statusCode).toBe(400);
    expect((await patch("art", { tagIds: ["portrait"] }, undefined, "/tags")).statusCode).toBe(200);
    expect((await get("/api/gallery"))[0].tags.map((tag: { id: string }) => tag.id)).toEqual(["portrait"]);
    expect((await findGallery(db, "art"))!.objectKey).toBe(asset.originalPath);
    await seed("legacy", "approved");
    expect((await patch("legacy", { tagIds: ["nature"] }, undefined, "/tags")).statusCode).toBe(200);
    await seed("pending");
    expect((await patch("pending", { tagIds: ["nature"] }, undefined, "/tags")).statusCode).toBe(404);
    expect((await patch("art", { decision: "approve", tagIds: ["city"] })).statusCode).toBe(404);
  });

  it("rolls back publication and copied objects when tag persistence fails", async () => {
    const { seed, patch, db, storage } = await setup();
    await seed();
    const copy = vi.spyOn(storage, "copy");
    db.sqlite!.raw.exec("CREATE TRIGGER fail_gallery_tags BEFORE INSERT ON gallery_item_tags BEGIN SELECT RAISE(ABORT, 'tag write failed'); END");
    expect((await patch("art", { decision: "approve", tagIds: ["city"] })).statusCode).toBe(500);
    expect((await findGallery(db, "art"))!).toMatchObject({ status: "pending", objectKey: "pending/art.png", reviewedAt: null });
    expect((await findAsset(db, "art"))!).toMatchObject({ originalPath: "temporary/art.png" });
    expect((await findAsset(db, "art"))!.expiresAt).not.toBeNull();
    expect((await listGalleryTags(db, ["art"])).get("art")).toEqual([]);
    expect(await storage.read("pending/art.png")).toEqual(png);
    expect(await storage.head(copy.mock.calls[0][1])).toBeUndefined();
    expect(await db.query("SELECT id FROM audit_logs WHERE action='gallery.approve'")).toHaveLength(0);
  });

  it("preserves published tags if replacing tags fails", async () => {
    const { seed, patch, db, get } = await setup();
    await seed();
    await patch("art", { decision: "approve", tagIds: ["city"] });
    db.sqlite!.raw.exec("CREATE TRIGGER fail_gallery_tags BEFORE INSERT ON gallery_item_tags BEGIN SELECT RAISE(ABORT, 'tag write failed'); END");
    expect((await patch("art", { tagIds: ["portrait"] }, undefined, "/tags")).statusCode).toBe(500);
    expect((await get("/api/gallery"))[0].tags.map((tag: { id: string }) => tag.id)).toEqual(["city"]);
  });

  it("keeps the pending state and original if the storage copy fails", async () => {
    const { seed, patch, db, storage } = await setup();
    await seed();
    vi.spyOn(storage, "copy").mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await patch("art", { decision: "approve", tagIds: ["city"] })).statusCode).toBe(500);
    expect((await findGallery(db, "art"))!.status).toBe("pending");
    expect((await findAsset(db, "art"))!.originalPath).toBe("temporary/art.png");
    expect(await storage.read("pending/art.png")).toEqual(png);
  });

  it("allows one concurrent approval and never deletes the winner's permanent object", async () => {
    const { seed, patch, db, storage } = await setup();
    await seed();
    const originalCopy = storage.copy.bind(storage);
    let release!: () => void;
    const bothCopies = new Promise<void>((resolve) => { release = resolve; });
    let copied = 0;
    const copy = vi.spyOn(storage, "copy").mockImplementation(async (...args) => {
      await originalCopy(...args);
      if (++copied === 2) release();
      await bothCopies;
    });
    const responses = await Promise.all([
      patch("art", { decision: "approve", tagIds: ["city"] }),
      patch("art", { decision: "approve", tagIds: ["portrait"] })
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const gallery = (await findGallery(db, "art"))!;
    expect((await findAsset(db, "art"))!.originalPath).toBe(gallery.objectKey);
    expect(await storage.read(gallery.objectKey!)).toEqual(png);
    const loserKey = copy.mock.calls.map((call) => call[1]).find((key) => key !== gallery.objectKey)!;
    expect(await storage.head(loserKey)).toBeUndefined();
    expect((await listGalleryTags(db, ["art"])).get("art")!.map((tag) => tag.id)).toEqual(responses.find((response) => response.statusCode === 200)!.json().tags.map((tag: { id: string }) => tag.id));
  });

  it("does not change asset references or tags when rejection wins an in-flight approval", async () => {
    const { seed, patch, db, storage } = await setup();
    await seed();
    const originalCopy = storage.copy.bind(storage);
    let started!: () => void;
    let release!: () => void;
    const copyStarted = new Promise<void>((resolve) => { started = resolve; });
    const releaseCopy = new Promise<void>((resolve) => { release = resolve; });
    const copy = vi.spyOn(storage, "copy").mockImplementation(async (...args) => { await originalCopy(...args); started(); await releaseCopy; });
    const approve = Promise.resolve(patch("art", { decision: "approve", tagIds: ["city"] }));
    await copyStarted;
    expect((await patch("art", { decision: "reject" })).statusCode).toBe(200);
    release();
    expect((await approve).statusCode).toBe(409);
    expect((await findGallery(db, "art"))!.status).toBe("rejected");
    expect((await findAsset(db, "art"))!.originalPath).toBe("temporary/art.png");
    expect((await listGalleryTags(db, ["art"])).get("art")).toEqual([]);
    expect(await storage.head(copy.mock.calls[0][1])).toBeUndefined();
  });

  it("filters persisted tags before pagination and searches Chinese labels and aliases", async () => {
    const { seed, patch, get } = await setup();
    await seed("new-untagged", "approved", "city architecture", 400);
    await seed("tagged-b", "approved", "untitled", 300);
    await seed("tagged-a", "approved", "untitled", 200);
    await seed("not-city", "approved", "untitled", 100);
    await patch("tagged-b", { tagIds: ["city", "architecture"] }, undefined, "/tags");
    await patch("tagged-a", { tagIds: ["city"] }, undefined, "/tags");
    await patch("not-city", { tagIds: ["nature"] }, undefined, "/tags");
    const first = await get("/api/media-feed/gallery?category=city&limit=1");
    expect(first.items.map((item: { id: string }) => item.id)).toEqual(["tagged-b"]);
    const second = await get(`/api/media-feed/gallery?category=city&limit=1&cursor=${first.nextCursor}`);
    expect(second.items.map((item: { id: string }) => item.id)).toEqual(["tagged-a"]);
    expect(second.nextCursor).toBeNull();
    for (const word of ["城市", "urban", "街景"]) {
      expect((await get(`/api/media-feed/gallery?search=${encodeURIComponent(word)}`)).items.map((item: { id: string }) => item.id)).toEqual(["tagged-b", "tagged-a"]);
    }
    expect((await get("/api/media-feed/gallery?search=untitled&category=nature")).items.map((item: { id: string }) => item.id)).toEqual(["not-city"]);
  });
});
