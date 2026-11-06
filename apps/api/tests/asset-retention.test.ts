import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";
import type { AppDatabase } from "../src/db/database.js";
import { findAsset, findGalleryByAsset } from "../src/db/repository.js";
import type { AssetStorage } from "../src/services/assetStorage.js";
import { createSession } from "../src/services/authService.js";
import { preservePermanentAsset } from "../src/services/assetRetention.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-retention-"));
  directories.push(dataDir);
  const app = await createServer({ dataDir, bootstrapEmail: "owner", bootstrapPassword: "password", webOrigin: "http://localhost:5173", sessionSecret: "test", cronSecret: "cron" });
  const db = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
  const storage = (app as unknown as { paintopiaStorage: AssetStorage }).paintopiaStorage;
  const owner = await db.queryOne<{ id: string }>("SELECT id FROM users WHERE email='owner'");
  const users = [{ id: owner!.id, name: "owner", role: "admin" }, { id: "ordinary", name: "ordinary", role: "user" }, { id: "other-admin", name: "other-admin", role: "admin" }];
  for (const user of users.slice(1)) await db.execute("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) VALUES(?,?,?,?,'active',100,?,?)", [user.id, user.name, "unused", user.role, new Date(), new Date()]);
  const cookies = new Map<string, string>();
  for (const user of users) cookies.set(user.name, `paintopia_session=${await createSession(db, user.id)}`);
  return { app, db, storage, cookies };
}

async function upload(app: Awaited<ReturnType<typeof createServer>>, cookie: string) {
  const intent = await app.inject({ method: "POST", url: "/api/assets/uploads", headers: { cookie }, payload: { fileName: "image.png", mimeType: "image/png", sizeBytes: png.length, prompt: "test" } });
  expect(intent.statusCode, intent.body).toBe(201);
  await app.inject({ method: "PUT", url: intent.json().uploadUrl, headers: { cookie, "content-type": "image/png" }, payload: png });
  const complete = await app.inject({ method: "POST", url: `/api/assets/${intent.json().assetId}/complete-upload`, headers: { cookie } });
  expect(complete.statusCode, complete.body).toBe(200);
  expect(complete.json().params).toMatchObject({ actualWidth: 1, actualHeight: 1 });
  return String(intent.json().assetId);
}

it("keeps only the owner's uploads and generated images forever, including a separate admin", async () => {
  const { app, db, cookies } = await setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 })));
  try {
    const provider = await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie: cookies.get("owner")! }, payload: { kind: "image", name: "Mock", baseUrl: "https://mock.example", apiKey: "mock", model: "gpt-image-2", mode: "generations" } });
    expect(provider.statusCode, provider.body).toBe(201);
    for (const name of ["owner", "ordinary", "other-admin"]) {
      const cookie = cookies.get(name)!;
      const uploadedId = await upload(app, cookie);
      const generation = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "test", params: { resolution: "1K", quality: "low", n: 1 } } });
      expect(generation.statusCode, generation.body).toBe(200);
      for (const id of [uploadedId, generation.json().assets[0].id]) {
        const asset = (await findAsset(db, id))!;
        if (name === "owner") {
          expect(asset.expiresAt).toBeNull();
          expect(asset.originalPath).toMatch(/^permanent\//);
        } else {
          expect(asset.expiresAt!.getTime() - asset.createdAt.getTime()).toBe(7 * 86_400_000);
          expect(asset.originalPath).toMatch(/^temporary\//);
        }
      }
    }
  } finally { await app.close(); }
});

it("keeps approved ordinary-user art permanently, resets withdrawal to seven days, and protects legacy owner assets during cleanup", async () => {
  const { app, db, storage, cookies } = await setup();
  try {
    const cookie = cookies.get("ordinary")!;
    const assetId = await upload(app, cookie);
    const pending = await app.inject({ method: "POST", url: `/api/assets/${assetId}/gallery`, headers: { cookie } });
    const approved = await app.inject({ method: "PATCH", url: `/api/admin/gallery-review/${pending.json().id}`, headers: { cookie: cookies.get("owner")! }, payload: { decision: "approve", tagIds: ["illustration"] } });
    expect(approved.statusCode, approved.body).toBe(200);
    const permanent = (await findAsset(db, assetId))!;
    expect(permanent.originalPath).toMatch(/^gallery\//);
    expect(permanent.expiresAt).toBeNull();
    // Simulate old database values that contradict permanent gallery membership.
    await db.execute("UPDATE assets SET expires_at = 1 WHERE id = ?", [assetId]);
    const ownerId = await upload(app, cookies.get("owner")!);
    const ownerAsset = (await findAsset(db, ownerId))!;
    const legacyKey = `temporary/${ownerAsset.userId}/${ownerId}.png`;
    await storage.put(legacyKey, png, "image/png");
    await db.execute("UPDATE assets SET original_path = ?, expires_at = 1 WHERE id = ?", [legacyKey, ownerId]);
    const expiredId = await upload(app, cookies.get("other-admin")!);
    await db.execute("UPDATE assets SET expires_at = 1 WHERE id = ?", [expiredId]);
    const cleanup = await app.inject({ method: "GET", url: "/api/internal/cleanup", headers: { authorization: "Bearer cron" } });
    expect(cleanup.statusCode, cleanup.body).toBe(200);
    expect(cleanup.json().deletedAssets).toBe(1);
    expect(await findAsset(db, expiredId)).toBeUndefined();
    expect((await findAsset(db, assetId))!.expiresAt).toBeNull();
    const protectedOwner = (await findAsset(db, ownerId))!;
    expect(protectedOwner.originalPath).toMatch(/^permanent\//);
    expect(protectedOwner.expiresAt).toBeNull();
    expect(await storage.read(protectedOwner.originalPath)).toEqual(png);
    expect(await storage.read(legacyKey)).toEqual(png);
    const withdrawal = await app.inject({ method: "DELETE", url: `/api/assets/${assetId}/gallery`, headers: { cookie } });
    expect(withdrawal.statusCode).toBe(200);
    const privateAsset = (await findAsset(db, assetId))!;
    expect(privateAsset.originalPath).toMatch(/^temporary\//);
    expect(privateAsset.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6.99 * 86_400_000);
    expect(withdrawal.json().expiresAt).toBe(privateAsset.expiresAt!.toISOString());
    expect(await findGalleryByAsset(db, assetId)).toBeUndefined();
    expect(await storage.read(privateAsset.originalPath)).toEqual(png);
  } finally { await app.close(); }
});

it("does not replace database references or overwrite an existing permanent object when preservation verification fails", async () => {
  const { app, db, storage, cookies } = await setup();
  try {
    const id = await upload(app, cookies.get("owner")!);
    const asset = (await findAsset(db, id))!;
    const legacyKey = `temporary/${asset.userId}/${id}.png`;
    await storage.put(legacyKey, Buffer.from("different-source"), "image/png");
    await db.execute("UPDATE assets SET original_path = ?, expires_at = 1 WHERE id = ?", [legacyKey, id]);
    await expect(preservePermanentAsset(db, storage, (await findAsset(db, id))!)).rejects.toThrow("verification failed");
    expect((await findAsset(db, id))!.originalPath).toBe(legacyKey);
    expect(await storage.read(asset.originalPath)).toEqual(png);
    expect(await storage.read(legacyKey)).toEqual(Buffer.from("different-source"));
  } finally { await app.close(); }
});

it("persists a submission only for the selected asset in both asset feeds", async () => {
  const { app, db, cookies } = await setup();
  try {
    const cookie = cookies.get("owner")!;
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) ids.push(await upload(app, cookie));
    const submission = await app.inject({ method: "POST", url: `/api/assets/${ids[0]}/gallery`, headers: { cookie } });
    expect(submission.statusCode).toBe(201);
    for (let refresh = 0; refresh < 2; refresh += 1) {
      for (const url of ["/api/assets", "/api/media-feed/assets"]) {
        const response = await app.inject({ method: "GET", url, headers: { cookie } });
        expect(response.statusCode, response.body).toBe(200);
        const items = url === "/api/assets" ? response.json() : response.json().items;
        expect(items).toHaveLength(3);
        expect(items.filter((item: { gallerySynced: boolean }) => item.gallerySynced).map((item: { id: string }) => item.id)).toEqual([ids[0]]);
        expect(items.find((item: { id: string }) => item.id === ids[0])).toMatchObject({ galleryStatus: "pending", galleryItemId: submission.json().id });
        for (const id of ids.slice(1)) expect(items.find((item: { id: string }) => item.id === id)).toMatchObject({ gallerySynced: false, galleryItemId: null, galleryStatus: null });
      }
    }
    const repeat = await app.inject({ method: "POST", url: `/api/assets/${ids[0]}/gallery`, headers: { cookie } });
    expect(repeat.statusCode).toBe(200);
    expect(await db.query("SELECT id FROM gallery_items WHERE asset_id = ?", [ids[0]!])).toHaveLength(1);
    await expect(db.execute("INSERT INTO gallery_items(id,asset_id,user_id,title,prompt,status,created_at) SELECT 'duplicate',asset_id,user_id,title,prompt,status,created_at FROM gallery_items WHERE id = ?", [submission.json().id])).rejects.toThrow(/UNIQUE constraint failed/);
    const concurrent = await Promise.all([0, 1].map(() => app.inject({ method: "POST", url: `/api/assets/${ids[1]}/gallery`, headers: { cookie } })));
    expect(concurrent.map(response => response.statusCode).sort()).toEqual([200, 201]);
    expect(concurrent[0]!.json().id).toBe(concurrent[1]!.json().id);
    expect(await db.query("SELECT id FROM gallery_items WHERE asset_id = ?", [ids[1]!])).toHaveLength(1);
  } finally { await app.close(); }
});
