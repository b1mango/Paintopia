import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";
import type { AppDatabase } from "../src/db/database.js";
import type { AssetStorage } from "../src/services/assetStorage.js";
import * as repo from "../src/db/repository.js";
import { createSession } from "../src/services/authService.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setup(assetState: "missing" | "unreadable" | "invalid" | "ready") {
  const dataDir = await mkdtemp(path.join(tmpdir(), "gallery-thumbnail-"));
  dirs.push(dataDir);
  const app = await createServer({ dataDir, bootstrapEmail: "admin", bootstrapPassword: "test-password", webOrigin: "http://localhost", sessionSecret: "test" });
  const { paintopiaDb: db, paintopiaStorage: storage } = app as unknown as { paintopiaDb: AppDatabase; paintopiaStorage: AssetStorage };
  const admin = (await db.query<{ id: string }>("SELECT id FROM users WHERE email='admin'"))[0];
  const headers = { cookie: `paintopia_session=${await createSession(db, admin.id)}` };
  const image = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "blue" } }).png().toBuffer();
  await storage.put("gallery/item.png", image, "image/png");
  await repo.insertAsset(db, { id: "source", userId: admin.id, jobId: null, originalPath: "permanent/source.png",
    thumbPath: assetState === "unreadable" ? "thumbnails/source.webp" : null,
    storageBackend: "local", mimeType: "image/png", sizeBytes: image.length, status: "ready", expiresAt: null,
    prompt: "lake", paramsJson: "{}", createdAt: new Date() });
  await db.execute("INSERT INTO gallery_items(id,asset_id,user_id,title,prompt,status,object_key,created_at) VALUES ('item','source',?,'lake','lake','approved','gallery/item.png',1)", [admin.id]);
  if (assetState === "missing") {
    // Model historical orphaned gallery rows without cascading their deletion.
    db.sqlite!.raw.pragma("foreign_keys = OFF");
    await db.execute("DELETE FROM assets WHERE id='source'");
    db.sqlite!.raw.pragma("foreign_keys = ON");
  } else if (assetState === "invalid") {
    await storage.put("permanent/source.png", Buffer.from("not an image"), "image/png");
  } else if (assetState === "ready") {
    await storage.put("permanent/source.png", image, "image/png");
  }
  return { app, db, storage, headers };
}

it.each(["missing", "unreadable", "invalid"] as const)("generates and caches both gallery sizes when the source is %s", async assetState => {
  const { app, storage, headers } = await setup(assetState);
  try {
    const put = vi.spyOn(storage, "put");
    for (const size of [640, 320]) {
      const url = `/api/gallery/item/thumbnail${size === 320 ? "?size=320" : ""}`;
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("image/webp");
      const metadata = await sharp(response.rawPayload).metadata();
      expect(metadata.width).toBe(size);
      expect(metadata.height).toBe(Math.round(size * 800 / 1200));
      expect(await storage.read(`thumbnails/gallery-item${size === 320 ? "-320" : ""}.webp`)).toEqual(response.rawPayload);
      const count = put.mock.calls.length;
      expect((await app.inject({ url, headers })).rawPayload).toEqual(response.rawPayload);
      expect(put).toHaveBeenCalledTimes(count);
    }
    await storage.delete("gallery/item.png");
    expect((await app.inject({ url: "/api/gallery/item/thumbnail", headers })).statusCode).toBe(200);
    if (assetState === "missing") {
      const feed = await app.inject({ url: "/api/media-feed/gallery", headers });
      expect(feed.json().items[0].thumbnailEdgeUrl).toBeNull();
    }
  } finally { await app.close(); }
});

it("retains asset thumbnails and visibility checks before accessing gallery storage", async () => {
  const { app, db, storage, headers } = await setup("ready");
  try {
    expect((await app.inject({ url: "/api/gallery/item/thumbnail", headers })).statusCode).toBe(200);
    expect(await storage.head("thumbnails/source.webp")).toBeDefined();
    expect(await storage.head("thumbnails/gallery-item.webp")).toBeUndefined();
    await db.execute("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) VALUES ('other','other','unused','user','active',100,1,1)");
    const otherHeaders = { cookie: `paintopia_session=${await createSession(db, "other")}` };
    await db.execute("UPDATE gallery_items SET status='pending' WHERE id='item'");
    const read = vi.spyOn(storage, "read");
    expect((await app.inject({ url: "/api/gallery/item/thumbnail", headers: otherHeaders })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/gallery/item/thumbnail" })).statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
