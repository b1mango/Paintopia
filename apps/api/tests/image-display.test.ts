import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";
import type { AppDatabase } from "../src/db/database.js";
import * as repo from "../src/db/repository.js";
import type { AssetStorage } from "../src/services/assetStorage.js";
import { createSession } from "../src/services/authService.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-display-"));
  directories.push(dataDir);
  const app = await createServer({ dataDir, bootstrapEmail: "owner", bootstrapPassword: "test-password", webOrigin: "http://localhost", sessionSecret: "test", cronSecret: "cron" });
  const { paintopiaDb: db, paintopiaStorage: storage } = app as unknown as { paintopiaDb: AppDatabase; paintopiaStorage: AssetStorage };
  const owner = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE email = 'owner'"))!;
  for (const id of ["alice", "bob"]) {
    await db.execute("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) VALUES (?,?,?,'user','active',100,1,1)", [id, id, "unused"]);
  }
  const headers = {
    owner: { cookie: `paintopia_session=${await createSession(db, owner.id)}` },
    alice: { cookie: `paintopia_session=${await createSession(db, "alice")}` },
    bob: { cookie: `paintopia_session=${await createSession(db, "bob")}` }
  };
  return { app, db, storage, headers, owner: owner.id };
}

async function insertAsset(db: AppDatabase, storage: AssetStorage, id: string, userId: string, bytes: Buffer, options?: { status?: "ready" | "uploading"; expiresAt?: Date | null; originalPath?: string }) {
  const originalPath = options?.originalPath ?? `temporary/${userId}/${id}.png`;
  await storage.put(originalPath, bytes, "image/png");
  await repo.insertAsset(db, {
    id, userId, jobId: null, originalPath, thumbPath: null, storageBackend: "local", mimeType: "image/png",
    sizeBytes: bytes.length, status: options?.status ?? "ready", expiresAt: options?.expiresAt ?? null,
    prompt: "lake", paramsJson: "{}", createdAt: new Date()
  });
}

it("stores a rotated, resized and transparent display alongside each generated image", async () => {
  const { app, storage, headers } = await setup();
  try {
    const image = await sharp({ create: { width: 3000, height: 1800, channels: 4, background: { r: 10, g: 60, b: 120, alpha: 0.4 } } }).png().withMetadata({ orientation: 6 }).toBuffer();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }))));
    const provider = await app.inject({ method: "POST", url: "/api/admin/providers", headers: headers.owner, payload: { kind: "image", name: "Mock", baseUrl: "https://mock.example", apiKey: "mock", model: "gpt-image-2", mode: "generations" } });
    expect(provider.statusCode).toBe(201);
    const generation = await app.inject({ method: "POST", url: "/api/generate", headers: headers.alice, payload: { prompt: "lake", params: { quality: "low", n: 1 } } });
    expect(generation.statusCode, generation.body).toBe(200);
    const asset = generation.json().assets[0];
    expect(asset.displayUrl).toBe(`/api/assets/${asset.id}/display`);
    const stored = await storage.read(`thumbnails/${asset.id}-display.webp`);
    expect(await sharp(stored).metadata()).toMatchObject({ format: "webp", width: 1536, height: 2560, hasAlpha: true });
    const pixels = await sharp(stored).raw().toBuffer();
    expect(pixels[3]).toBeGreaterThan(0);
    expect(pixels[3]).toBeLessThan(255);
    expect((await app.inject({ url: asset.displayUrl, headers: headers.alice })).rawPayload).toEqual(stored);
    const download = await app.inject({ url: `/api/assets/${asset.id}/download`, headers: headers.alice });
    expect(download.rawPayload).toEqual(image);
    expect(download.headers["content-disposition"]).toContain("attachment");
  } finally { await app.close(); }
});

it("preserves the successful original and display when thumbnail storage fails", async () => {
  const { app, storage, headers } = await setup();
  try {
    const image = await sharp({ create: { width: 100, height: 80, channels: 3, background: "blue" } }).png().toBuffer();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }))));
    await app.inject({ method: "POST", url: "/api/admin/providers", headers: headers.owner, payload: { kind: "image", name: "Mock", baseUrl: "https://mock.example", apiKey: "mock", model: "gpt-image-2", mode: "generations" } });
    const originalPut = storage.put;
    vi.spyOn(storage, "put").mockImplementation(async (key, bytes, mimeType) => {
      if (key.startsWith("thumbnails/") && !key.endsWith("-display.webp")) throw new Error("thumbnail unavailable");
      return originalPut(key, bytes, mimeType);
    });
    const generation = await app.inject({ method: "POST", url: "/api/generate", headers: headers.alice, payload: { prompt: "lake", params: { quality: "low" } } });
    expect(generation.statusCode, generation.body).toBe(200);
    const asset = generation.json().assets[0];
    expect(await storage.head(`thumbnails/${asset.id}-display.webp`)).toBeDefined();
    expect((await app.inject({ url: asset.imageUrl, headers: headers.alice })).rawPayload).toEqual(image);
  } finally { await app.close(); }
});

it("keeps the paid original when display storage fails and generates the display later", async () => {
  const { app, storage, headers } = await setup();
  try {
    const image = await sharp({ create: { width: 100, height: 80, channels: 3, background: "blue" } }).png().toBuffer();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }))));
    await app.inject({ method: "POST", url: "/api/admin/providers", headers: headers.owner, payload: { kind: "image", name: "Mock", baseUrl: "https://mock.example", apiKey: "mock", model: "gpt-image-2", mode: "generations" } });
    const originalPut = storage.put.bind(storage);
    const put = vi.spyOn(storage, "put").mockImplementation(async (key, bytes, mimeType) => {
      if (key.endsWith("-display.webp")) throw new Error("display unavailable");
      return originalPut(key, bytes, mimeType);
    });
    const generation = await app.inject({ method: "POST", url: "/api/generate", headers: headers.alice, payload: { prompt: "lake", params: { quality: "low" } } });
    expect(generation.statusCode).toBe(200);
    const [asset] = generation.json().assets;
    expect((await app.inject({ url: asset.imageUrl, headers: headers.alice })).rawPayload).toEqual(image);
    expect(await storage.head(`thumbnails/${asset.id}-display.webp`)).toBeUndefined();
    put.mockRestore();
    const display = await app.inject({ url: asset.displayUrl, headers: headers.alice });
    expect(display.statusCode).toBe(200);
    expect(display.headers["content-type"]).toContain("image/webp");
  } finally { await app.close(); }
});

it("authorizes historical assets, generates display on demand and reuses it", async () => {
  const { app, db, storage, headers } = await setup();
  try {
    const image = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "blue" } }).png().toBuffer();
    await insertAsset(db, storage, "historic", "alice", image);
    await insertAsset(db, storage, "uploading", "alice", image, { status: "uploading" });
    const read = vi.spyOn(storage, "read");
    const put = vi.spyOn(storage, "put");
    expect((await app.inject({ url: "/api/assets/historic/display" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/assets/historic/display", headers: headers.bob })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/assets/uploading/display", headers: headers.alice })).statusCode).toBe(409);
    expect(read).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    const first = await app.inject({ url: "/api/assets/historic/display", headers: headers.alice });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("image/webp");
    expect(first.headers["cache-control"]).toBe("private, max-age=300");
    expect(await sharp(first.rawPayload).metadata()).toMatchObject({ format: "webp", width: 1200, height: 800 });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe("thumbnails/historic-display.webp");
    const second = await app.inject({ url: "/api/assets/historic/display", headers: headers.owner });
    expect(second.rawPayload).toEqual(first.rawPayload);
    expect(put).toHaveBeenCalledTimes(1);
    expect(read.mock.calls.filter(([key]) => key === "temporary/alice/historic.png")).toHaveLength(1);
    expect((await app.inject({ url: "/api/assets", headers: headers.alice })).json()[0].displayUrl).toBe("/api/assets/historic/display");
    expect((await app.inject({ url: "/api/media-feed/assets", headers: headers.alice })).json().items[0].displayUrl).toBe("/api/assets/historic/display");
  } finally { await app.close(); }
});

it.each(["jpeg", "webp"] as const)("creates a display for a small %s original without enlarging it", async (format) => {
  const { app, db, storage, headers } = await setup();
  try {
    const image = await sharp({ create: { width: 48, height: 32, channels: 3, background: "blue" } }).toFormat(format).toBuffer();
    const asset = {
      id: format, userId: "alice", jobId: null, originalPath: `temporary/alice/${format}.${format}`, thumbPath: null,
      storageBackend: "local" as const, mimeType: `image/${format}`, sizeBytes: image.length, status: "ready" as const,
      expiresAt: null, prompt: "lake", paramsJson: "{}", createdAt: new Date()
    };
    await storage.put(asset.originalPath, image, asset.mimeType);
    await repo.insertAsset(db, asset);
    const response = await app.inject({ url: `/api/assets/${format}/display`, headers: headers.alice });
    expect(response.statusCode).toBe(200);
    expect(await sharp(response.rawPayload).metadata()).toMatchObject({ format: "webp", width: 48, height: 32 });
    expect(await storage.head(`thumbnails/${format}-display.webp`)).toBeDefined();
  } finally { await app.close(); }
});

it("enforces gallery visibility and caches a surviving gallery copy", async () => {
  const { app, db, storage, headers } = await setup();
  try {
    const image = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "green" } }).png().toBuffer();
    await insertAsset(db, storage, "source", "alice", image);
    await storage.delete("temporary/alice/source.png");
    await storage.put("gallery/item.png", image, "image/png");
    await db.execute("INSERT INTO gallery_items(id,asset_id,user_id,title,prompt,status,object_key,created_at) VALUES ('item','source','alice','lake','lake','pending','gallery/item.png',1)");
    const read = vi.spyOn(storage, "read");
    const put = vi.spyOn(storage, "put");
    expect((await app.inject({ url: "/api/gallery/item/display" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/gallery/item/display", headers: headers.bob })).statusCode).toBe(404);
    expect(read).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    const first = await app.inject({ url: "/api/gallery/item/display", headers: headers.alice });
    expect(first.statusCode).toBe(200);
    expect(await sharp(first.rawPayload).metadata()).toMatchObject({ format: "webp", width: 1200, height: 800 });
    expect(put.mock.calls[0]![0]).toBe("thumbnails/gallery-item-display.webp");
    const second = await app.inject({ url: "/api/gallery/item/display", headers: headers.owner });
    expect(second.rawPayload).toEqual(first.rawPayload);
    expect(put).toHaveBeenCalledTimes(1);
    await db.execute("UPDATE gallery_items SET status = 'approved' WHERE id = 'item'");
    expect((await app.inject({ url: "/api/gallery/item/display", headers: headers.bob })).rawPayload).toEqual(first.rawPayload);
    expect((await app.inject({ url: "/api/gallery", headers: headers.bob })).json()[0].displayUrl).toBe("/api/gallery/item/display");
    expect((await app.inject({ url: "/api/media-feed/gallery", headers: headers.bob })).json().items[0].displayUrl).toBe("/api/gallery/item/display");
    db.sqlite!.raw.pragma("foreign_keys = OFF");
    await db.execute("DELETE FROM assets WHERE id='source'");
    db.sqlite!.raw.pragma("foreign_keys = ON");
    expect((await app.inject({ url: "/api/gallery/item/display", headers: headers.bob })).rawPayload).toEqual(first.rawPayload);
  } finally { await app.close(); }
});

it("generates the gallery preview from the asset when there is no gallery copy", async () => {
  const { app, db, storage, headers } = await setup();
  try {
    const image = await sharp({ create: { width: 100, height: 80, channels: 3, background: "red" } }).png().toBuffer();
    await insertAsset(db, storage, "source", "alice", image);
    await db.execute("INSERT INTO gallery_items(id,asset_id,user_id,title,prompt,status,created_at) VALUES ('item','source','alice','lake','lake','approved',1)");
    const response = await app.inject({ url: "/api/gallery/item/display", headers: headers.bob });
    expect(response.statusCode).toBe(200);
    expect(await storage.read("thumbnails/source-display.webp")).toEqual(response.rawPayload);
    expect(await storage.head("thumbnails/gallery-item-display.webp")).toBeUndefined();
  } finally { await app.close(); }
});

it("uses stored asset previews in the gallery and signs R2 display delivery", async () => {
  const { app, db, storage, headers } = await setup();
  try {
    const image = await sharp({ create: { width: 100, height: 80, channels: 3, background: "red" } }).png().toBuffer();
    const display = await sharp(image).webp().toBuffer();
    await insertAsset(db, storage, "source", "alice", image);
    await storage.put("thumbnails/source-display.webp", display, "image/webp");
    await db.execute("INSERT INTO gallery_items(id,asset_id,user_id,title,prompt,status,object_key,created_at) VALUES ('item','source','alice','lake','lake','approved','gallery/item.png',1)");
    expect((await app.inject({ url: "/api/gallery/item/display", headers: headers.bob })).rawPayload).toEqual(display);
    expect(await storage.head("thumbnails/gallery-item-display.webp")).toBeUndefined();
    storage.backend = "r2";
    vi.stubEnv("PAINTOPIA_MEDIA_EDGE_URL", "https://media.example");
    vi.stubEnv("PAINTOPIA_MEDIA_SIGNING_KEY", "test-signing-key");
    const edge = await app.inject({ url: "/api/assets/source/display", headers: headers.alice });
    expect(edge.statusCode).toBe(302);
    expect(edge.headers["cache-control"]).toBe("private, max-age=60");
    expect(new URL(edge.headers.location!, "https://example.test").searchParams.get("key")).toBe("thumbnails/source-display.webp");
    vi.stubEnv("PAINTOPIA_MEDIA_EDGE_URL", "");
    vi.spyOn(storage, "createDownloadUrl").mockResolvedValue("https://signed.example/display");
    const signed = await app.inject({ url: "/api/gallery/item/display", headers: headers.bob });
    expect(signed.statusCode).toBe(302);
    expect(signed.headers.location).toBe("https://signed.example/display");
    expect(signed.headers["cache-control"]).toBe("private, max-age=120");
  } finally { await app.close(); }
});

it("cleans up a gallery preview when its item is withdrawn", async () => {
  const { app, db, storage, headers } = await setup();
  try {
    const image = await sharp({ create: { width: 20, height: 10, channels: 3, background: "white" } }).png().toBuffer();
    await insertAsset(db, storage, "source", "alice", image);
    await storage.put("pending/alice/item.png", image, "image/png");
    await db.execute("INSERT INTO gallery_items(id,asset_id,user_id,title,prompt,status,object_key,created_at) VALUES ('item','source','alice','lake','lake','pending','pending/alice/item.png',1)");
    expect((await app.inject({ url: "/api/gallery/item/display", headers: headers.alice })).statusCode).toBe(200);
    expect(await storage.head("thumbnails/gallery-item-display.webp")).toBeDefined();
    expect((await app.inject({ method: "DELETE", url: "/api/assets/source/gallery", headers: headers.alice })).statusCode).toBe(200);
    expect(await storage.head("thumbnails/gallery-item-display.webp")).toBeUndefined();
  } finally { await app.close(); }
});

it("deletes personal and gallery display variants and preserves protected assets during expiry cleanup", async () => {
  const { app, db, storage, headers, owner } = await setup();
  try {
    const image = await sharp({ create: { width: 20, height: 10, channels: 3, background: "white" } }).png().toBuffer();
    await insertAsset(db, storage, "delete", "alice", image);
    await storage.put("pending/alice/item.png", image, "image/png");
    await db.execute("INSERT INTO gallery_items(id,asset_id,user_id,title,prompt,status,object_key,created_at) VALUES ('item','delete','alice','lake','lake','pending','pending/alice/item.png',1)");
    for (const key of ["thumbnails/delete-display.webp", "thumbnails/delete-320.webp", "thumbnails/gallery-item-display.webp"]) await storage.put(key, image, "image/webp");
    expect((await app.inject({ method: "DELETE", url: "/api/assets/delete", headers: headers.alice })).statusCode).toBe(204);
    for (const key of ["thumbnails/delete-display.webp", "thumbnails/delete-320.webp", "thumbnails/gallery-item-display.webp"]) expect(await storage.head(key)).toBeUndefined();
    await insertAsset(db, storage, "expired", "alice", image, { expiresAt: new Date(1) });
    await insertAsset(db, storage, "protected", owner, image, { expiresAt: new Date(1), originalPath: `permanent/${owner}/protected.png` });
    for (const id of ["expired", "protected"]) await storage.put(`thumbnails/${id}-display.webp`, image, "image/webp");
    const cleanup = await app.inject({ url: "/api/internal/cleanup", headers: { authorization: "Bearer cron" } });
    expect(cleanup.statusCode).toBe(200);
    expect(await storage.head("thumbnails/expired-display.webp")).toBeUndefined();
    expect(await storage.head("thumbnails/protected-display.webp")).toBeDefined();
  } finally { await app.close(); }
});
