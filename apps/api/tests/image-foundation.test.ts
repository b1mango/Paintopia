import { createSession } from "../src/services/authService.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";
import { callImageProvider, callImageProviderStream } from "../src/providers/imageProvider.js";
import { sanitizeRequestValue, type UpstreamRequestSnapshot } from "../src/providers/requestSnapshot.js";
import * as repo from "../src/db/repository.js";
import type { AppDatabase } from "../src/db/database.js";
import type { ImageProviderConfig } from "@paintopia/shared";

const provider: ImageProviderConfig = { id: "p", name: "test", baseUrl: "https://example.test", apiKey: "secret-key", model: "image-model", mode: "generations", maxConcurrency: 1 };
let close: (() => Promise<void>) | undefined;
let dataDir: string | undefined;
afterEach(async () => { await close?.(); close = undefined; if (dataDir) await rm(dataDir, { recursive: true, force: true }); vi.unstubAllGlobals(); });
async function setup() {
  dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-foundation-"));
  const app = await createServer({ dataDir, bootstrapEmail: "admin", bootstrapPassword: "password123", inviteCode: "test-invite", webOrigin: "http://localhost", sessionSecret: "test-secret" });
  close = () => app.close();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin", password: "password123" } });
  const cookie = String(login.headers["set-cookie"]);
  return { app, cookie, db: (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb };
}
const params = { size: "2048x1152", resolution: "2K", quality: "auto", background: "transparent" };

describe("provider wire payloads", () => {
  it.each(["generations", "responses", "chat_completions", "edits"] as const)("forwards options and observes the actual %s request", async mode => {
    const requests: UpstreamRequestSnapshot[] = [];
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: "output" }] })));
    await callImageProvider({ ...provider, mode, imageCapabilities: { sizeField: "image_size", resolutionField: null, qualities: ["auto"] } }, { prompt: "A lake", params: { ...params, image: new Blob(["reference"], { type: "image/png" }) }, onRequest: r => requests.push(r) }, fetcher);
    const init = fetcher.mock.calls[0]![1]!;
    const root = init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(String(init.body));
    const body = mode === "responses" ? root.tools[0] : root;
    expect(body).toMatchObject({ image_size: "2048x1152", quality: "auto", background: "transparent" });
    expect(body).not.toHaveProperty("resolution");
    expect(body).not.toHaveProperty("size");
    expect(requests[0]?.endpoint).toContain("https://example.test/v1/");
    const snapshot = JSON.stringify(requests);
    expect(snapshot).not.toContain("secret-key");
    expect(snapshot).not.toContain(Buffer.from("reference").toString("base64"));
    expect(snapshot).not.toContain("data:image");
  });
  it.each(["generations", "responses"] as const)("forwards background and size for streaming %s", async mode => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: "output" }] })));
    await callImageProviderStream({ ...provider, mode }, { prompt: "lake", params }, () => {}, fetcher);
    const root = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(root.stream).toBe(true);
    expect(mode === "responses" ? root.tools[0] : root).toMatchObject(params);
  });
  it("rejects unsupported quality before making a network request", async () => {
    const fetcher = vi.fn();
    await expect(callImageProvider({ ...provider, imageCapabilities: { qualities: ["standard"] } }, { prompt: "lake", params }, fetcher)).rejects.toThrow("允许值");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("redacts credential fields, URL credentials, query tokens and embedded binary", () => {
    const result = JSON.stringify(sanitizeRequestValue({ apiKey: "abc", nested: { url: "https://user:pass@example.test/v1?key=abc", prompt: "secret-key", image: "data:image/png;base64,YWJj" } }, "secret-key"));
    expect(result).not.toMatch(/abc|user:pass|secret-key|YWJj/);
  });
});

describe("generation and asset integration", () => {
  it("persists channel capabilities, charges auto correctly, saves undersized pixels once and snapshots attempts", async () => {
    const { app, cookie, db } = await setup();
    const image = await sharp({ create: { width: 1536, height: 1536, channels: 3, background: "white" } }).webp().toBuffer();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] })));
    vi.stubGlobal("fetch", fetcher);
    const created = await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { kind: "image", name: "test", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, mode: "generations", imageCapabilities: { supportsStreaming: false, qualities: ["auto"], sizeField: "size", resolutionField: null } } });
    expect(created.statusCode).toBe(201);
    expect((await repo.findProvider(db, created.json().id))?.imageCapabilities?.supportsStreaming).toBe(false);
    const result = await app.inject({ method: "POST", url: "/api/generate/stream", headers: { cookie }, payload: { prompt: "lake", params: { ...params, size: "2048x2048" } } });
    const events = result.body.trim().split("\n").map(line => JSON.parse(line));
    const completed = events.find(event => event.type === "completed").result;
    expect(completed.quotaCost).toBe(6);
    expect(completed.assets[0].params).toMatchObject({ actualWidth: 1536, actualHeight: 1536 });
    expect(completed.assets[0].params.resolutionWarning).toContain("2048x2048");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const job = (await repo.listGenerationJobs(db))[0]!;
    const generation = JSON.parse(job.paramsJson).__paintopiaRuntime.imageGeneration;
    expect(generation.outputs).toEqual([{ assetId: completed.assets[0].id, width: 1536, height: 1536, imageUrl: completed.assets[0].imageUrl }]);
    expect(completed.assets[0].params.providerId).toBe(created.json().id);
    const history = await app.inject({ url: "/api/generation-history", headers: { cookie } });
    expect(history.json().items[0].outputs).toEqual(generation.outputs);
    const attempt = generation.attempts[0];
    expect(attempt.requests[0]).toMatchObject({ endpoint: "https://example.test/v1/images/generations", parameters: { size: "2048x2048", quality: "auto", background: "transparent" } });
    expect(attempt.requests[0].parameters).not.toHaveProperty("stream");
    expect(JSON.stringify(attempt)).not.toContain(provider.apiKey);
  });
  it("rejects invalid pixel inputs before any provider call", async () => {
    const { app, cookie } = await setup(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const response = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "lake", params: { size: "1025x1024", resolution: "1K" } } });
    expect(response.statusCode).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps arrays for legacy lists and scopes admin pagination to owned ready assets", async () => {
    const { app, cookie, db } = await setup();
    const admin = await db.queryOne<{ id: string }>("SELECT id FROM users WHERE email = ?", ["admin"]);
    await db.execute("INSERT INTO users (id,email,password_hash,role,status,quota,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", ["other", "other", "unused", "user", "active", 100, new Date(), new Date()]);
    for (const [id, userId, status, createdAt] of [["a", admin!.id, "ready", 100], ["b", admin!.id, "ready", 200], ["c", "other", "ready", 300], ["d", admin!.id, "uploading", 400]] as const) {
      await repo.insertAsset(db, { id, userId, jobId: null, originalPath: "unused", thumbPath: null, storageBackend: "local", mimeType: "image/png", sizeBytes: 1, status, expiresAt: null, prompt: id, paramsJson: "{}", createdAt: new Date(createdAt) });
    }
    const legacy = await app.inject({ url: "/api/assets", headers: { cookie } });
    expect(legacy.json().map((row: { id: string }) => row.id)).toEqual(["b", "a"]);
    const page = await app.inject({ url: "/api/assets?scope=mine&page=2&pageSize=1", headers: { cookie } });
    expect(page.json()).toMatchObject({ total: 2, page: 2, pageSize: 1, items: [{ id: "a" }] });
    expect((await app.inject({ url: "/api/assets?page=0", headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/assets?page=1" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/prompt-library" })).statusCode).toBe(401);
  });
});

describe("capability and failure contracts", () => {
  it("accepts empty quality configuration and rejects conflicting upstream fields", async () => {
    const { app, cookie } = await setup();
    const base = { kind: "image", name: "test", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, mode: "generations" };
    const conflict = await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { ...base, imageCapabilities: { sizeField: "image_size", resolutionField: "image_size" } } });
    expect(conflict.statusCode).toBe(400);
    const good = await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { ...base, imageCapabilities: { qualities: [], supportsStreaming: false } } });
    expect(good.statusCode).toBe(201);
    const patch = await app.inject({ method: "PATCH", url: "/api/admin/providers/" + good.json().id, headers: { cookie }, payload: { ...base, name: "renamed", apiKey: "" } });
    expect(patch.json().imageCapabilities).toEqual({ qualities: [], supportsStreaming: false });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] })));
    vi.stubGlobal("fetch", fetcher);
    const result = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "lake", params: { resolution: "auto", aspectRatio: "auto", size: "auto", quality: "auto", actualWidth: 9999, actualHeight: 9999 } } });
    expect(result.statusCode).toBe(200);
    expect(result.json().quotaCost).toBe(12);
    expect(result.json().assets[0].params).not.toHaveProperty("actualWidth");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("records a sanitized failed stream attempt and the actual nonstream fallback", async () => {
    const { app, cookie, db } = await setup();
    await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { kind: "image", name: "test", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, mode: "generations", imageCapabilities: { supportsStreaming: true } } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "stream unsupported " + provider.apiKey } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] })));
    vi.stubGlobal("fetch", fetcher);
    const result = await app.inject({ method: "POST", url: "/api/generate/stream", headers: { cookie }, payload: { prompt: "lake", params: { quality: "auto" } } });
    expect(result.body).toContain('"type":"completed"');
    const attempts = JSON.parse((await repo.listGenerationJobs(db))[0]!.paramsJson).__paintopiaRuntime.imageGeneration.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ status: "failed", requests: [{ parameters: { stream: true, size: "1024x1024", quality: "auto" } }] });
    expect(attempts[1]).toMatchObject({ status: "succeeded", requests: [{ parameters: { size: "1024x1024", quality: "auto" } }] });
    expect(JSON.stringify(attempts)).not.toContain(provider.apiKey);
  });
  it("records each actual HTTP request during the adapter's transient retry", async () => {
    const requests: UpstreamRequestSnapshot[] = [];
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("stream INTERNAL_ERROR"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: "output" }] })));
    await callImageProvider(provider, { prompt: "lake", params, onRequest: r => requests.push(r) }, fetcher);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
  });
  it("rejects a high pixel request disguised as a cheap resolution", async () => {
    const { app, cookie } = await setup(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const result = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "lake", params: { size: "3840x2160", resolution: "1K" } } });
    expect(result.statusCode).toBe(400); expect(result.json().error).toContain("不一致"); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("successful fallback attribution", () => {
  it("records the provider that actually generated each saved asset", async () => {
    const { app, cookie, db } = await setup();
    const base = { kind: "image", name: "first", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, mode: "generations" };
    await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: base });
    const backup = await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { ...base, name: "backup", model: "backup-model" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }))));
    const result = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "lake" } });
    expect(result.statusCode).toBe(200);
    expect(result.json().assets[0].params).toMatchObject({ providerId: backup.json().id, providerName: "backup", model: "backup-model" });
    const job = JSON.parse((await repo.listGenerationJobs(db))[0]!.paramsJson);
    expect(job).toMatchObject({ providerId: backup.json().id, providerName: "backup", model: "backup-model" });
    expect(job.__paintopiaRuntime.imageGeneration.outputs[0]).toMatchObject({ width: null, height: null });
  });
});

describe("delivery review regressions", () => {
  it("caps custom-size batches and recorded counts at eight with exact quota debits", async () => {
    const { app, cookie, db } = await setup();
    await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { kind: "image", name: "batch", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, mode: "generations" } });
    const bytes = await sharp({ create: { width: 1280, height: 800, channels: 3, background: "white" } }).png().toBuffer();
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ data: Array.from({ length: 8 }, () => ({ b64_json: bytes.toString("base64") })) })));
    vi.stubGlobal("fetch", fetcher);
    const result = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "eight scenes", params: { size: "1280x800", resolution: "1K", quality: "auto", n: 99 } } });
    expect(result.statusCode).toBe(200);
    expect(result.json().quotaCost).toBe(24);
    expect(result.json().assets).toHaveLength(8);
    expect(result.json().assets.every((asset: { params: { n: number; actualWidth: number; actualHeight: number } }) => asset.params.n === 8 && asset.params.actualWidth === 1280 && asset.params.actualHeight === 800)).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ n: 8, size: "1280x800", resolution: "1K", quality: "auto" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const job = (await repo.listGenerationJobs(db))[0]!;
    const ledger = await repo.imageGenerationLedger(db, job.userId);
    expect(ledger).toHaveLength(1); expect(ledger[0]!.amount).toBe(-24);
    expect(JSON.parse(job.paramsJson).__paintopiaRuntime.imageGeneration.outputs).toHaveLength(8);
  });
  it("rejects legacy size-tier conflicts before contacting the upstream", async () => {
    const { app, cookie } = await setup(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const result = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "lake", params: { size: "4K", resolution: "1K" } } });
    expect(result.statusCode).toBe(400); expect(result.json().error).toContain("不一致"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("strips all server result fields from generation and uploaded-asset metadata", async () => {
    const { app, cookie, db } = await setup();
    const forged = { actualWidth: 9999, actualHeight: 9999, actualResolution: "4K", resolutionWarning: "fake", __paintopiaRuntime: { imageGeneration: { outputs: [{ width: 9999 }] } }, upstreamSize: "9999x9999", upstreamQuality: "fake", upstreamResolution: "fake", upstreamModel: "fake", providerId: "fake", providerName: "fake", outputs: [{ width: 9999 }], mode: "fake", referenceImageCount: 99, referenceSources: ["fake"], assetIds: ["fake"] };
    const uploaded = await app.inject({ method: "POST", url: "/api/assets/uploads", headers: { cookie }, payload: { fileName: "ref.png", mimeType: "image/png", sizeBytes: 5, params: { ...forged, sourceId: "prompt-library-item" } } });
    expect(uploaded.statusCode).toBe(201);
    const uploadedParams = JSON.parse((await repo.findAsset(db, uploaded.json().assetId))!.paramsJson);
    for (const key of Object.keys(forged)) expect(uploadedParams).not.toHaveProperty(key);
    expect(uploadedParams.sourceId).toBe("prompt-library-item");
    const configured = await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { kind: "image", name: "real", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, mode: "generations" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }))));
    const result = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "lake", params: { ...forged, sourceId: "prompt-library-item", resolution: "auto", size: "auto" } } });
    expect(result.statusCode).toBe(200);
    const stored = result.json().assets[0].params;
    for (const key of Object.keys(forged).filter(key => !["providerId", "providerName", "resolutionWarning"].includes(key))) expect(stored).not.toHaveProperty(key);
    expect(stored).toMatchObject({ providerId: configured.json().id, providerName: "real", sourceId: "prompt-library-item" });
    expect(stored.resolutionWarning).not.toBe("fake");
  });
  it("prices auto using configured 4K/high and blocks insufficient quota without upstream calls", async () => {
    const { app, cookie, db } = await setup();
    await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { kind: "image", name: "test", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, mode: "generations" } });
    const pricing = await app.inject({ method: "PATCH", url: "/api/admin/quota-pricing", headers: { cookie }, payload: { rules: [{ key: "resolution.4k.quality.high", amount: 17 }] } });
    expect(pricing.statusCode).toBe(200);
    await db.execute("UPDATE users SET quota = ? WHERE email = ?", [16, "admin"]);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const result = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "lake", params: { resolution: "auto", size: "auto", quality: "auto" } } });
    expect(result.statusCode).toBe(402); expect(result.json().quotaCost).toBe(17); expect(fetcher).not.toHaveBeenCalled();
    expect(await repo.imageGenerationLedger(db)).toHaveLength(0);
  });
  it("keeps legacy prompt storage empty at startup while still initializing templates", async () => {
    const { db } = await setup();
    expect(await repo.listPrompts(db)).toEqual([]);
    expect((await repo.listTemplates(db)).length).toBeGreaterThan(0);
  });
});


describe("final permission and selected-model review", () => {
  it("blocks an implicit tiered default model before any upstream call or debit", async () => {
    const { app, cookie, db } = await setup();
    await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { kind: "image", name: "tiered", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: "gpt-image-2.5-4k", mode: "generations" } });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const result = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "lake", params: { resolution: "1K", size: "1024x1024" } } });
    expect(result.statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled(); expect(await repo.imageGenerationLedger(db)).toEqual([]);
  });
  it("skips an incompatible tiered default and records the compatible fallback request", async () => {
    const { app, cookie } = await setup();
    const base = { kind: "image", name: "tiered", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: "gpt-image-2.5-4k", mode: "generations" };
    await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: base });
    const backup = await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { ...base, name: "compatible", model: "gpt-image-2.5-1k" } });
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] })));
    vi.stubGlobal("fetch", fetcher);
    const result = await app.inject({ method: "POST", url: "/api/generate", headers: { cookie }, payload: { prompt: "lake", params: { resolution: "1K", size: "1024x1024" } } });
    expect(result.statusCode).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ model: "gpt-image-2.5-1k", size: "1024x1024", resolution: "1K" });
    expect(result.json().assets[0].params.providerId).toBe(backup.json().id);
  });
  it("denies ordinary-user access to foreign assets, references and admin pricing without calling upstream", async () => {
    const { app, cookie, db } = await setup();
    const admin = await db.queryOne<{ id: string }>("SELECT id FROM users WHERE email = ?", ["admin"]);
    await repo.insertAsset(db, { id: "private-asset", userId: admin!.id, jobId: null, originalPath: "not-read", thumbPath: null, storageBackend: "local", mimeType: "image/png", sizeBytes: 1, status: "ready", expiresAt: null, prompt: "private", paramsJson: "{}", createdAt: new Date() });
    await db.execute("INSERT INTO users (id,email,password_hash,role,status,quota,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", ["ordinary", "ordinary", "unused", "user", "active", 100, new Date(), new Date()]);
    const session = await createSession(db, "ordinary");
    const headers = { cookie: "paintopia_session=" + session };
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    for (const suffix of ["original", "download", "thumbnail"]) expect((await app.inject({ url: "/api/assets/private-asset/" + suffix, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/assets/private-asset", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/generate/edit", headers, payload: { prompt: "lake", assetIds: ["private-asset"] } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/admin/quota-pricing", headers, payload: { rules: [{ key: "resolution.4k.quality.high", amount: 0 }] } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/assets?page=1&pageSize=20", headers })).json()).toMatchObject({ total: 0, items: [] });
    expect(await repo.findAsset(db, "private-asset")).toBeDefined();
    await db.execute("UPDATE users SET status = ? WHERE id = ?", ["disabled", "ordinary"]);
    expect((await app.inject({ method: "POST", url: "/api/generate", headers, payload: { prompt: "lake" } })).statusCode).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

async function reviewReference(app: Awaited<ReturnType<typeof createServer>>, cookie: string) {
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).png().toBuffer();
  const created = await app.inject({ method: "POST", url: "/api/assets/uploads", headers: { cookie }, payload: { fileName: "ref.png", mimeType: "image/png", sizeBytes: bytes.length } });
  expect(created.statusCode).toBe(201);
  expect((await app.inject({ method: "PUT", url: created.json().uploadUrl, headers: { cookie, "content-type": "image/png" }, payload: bytes })).statusCode).toBe(204);
  expect((await app.inject({ method: "POST", url: "/api/assets/" + created.json().assetId + "/complete-upload", headers: { cookie } })).statusCode).toBe(200);
  return created.json().assetId as string;
}
function reviewMultipart(fields: Record<string, string>) {
  const boundary = "paintopia-review-boundary";
  const payload = Object.entries(fields).map(([name, value]) => "--" + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + "\r\n").join("") + "--" + boundary + "--\r\n";
  return { payload, contentType: "multipart/form-data; boundary=" + boundary };
}

describe("P1 auto-size and long prompt regressions", () => {
  it.each(["generation", "stream", "edit", "multipart"] as const)("rejects cheap auto-size aliases and charges legitimate auto for %s", async mode => {
    const { app, cookie, db } = await setup();
    const editing = mode === "edit" || mode === "multipart";
    const assetId = editing ? await reviewReference(app, cookie) : undefined;
    const created = await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { kind: "image", name: "auto", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, mode: editing ? "edits" : "generations", imageCapabilities: { resolutionField: null, supportsStreaming: false } } });
    expect(created.statusCode).toBe(201);
    const output = await sharp({ create: { width: 32, height: 32, channels: 3, background: "black" } }).png().toBuffer();
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: output.toString("base64") }] })));
    vi.stubGlobal("fetch", fetcher);
    const request = (resolution: string) => {
      if (mode === "multipart") {
        const form = reviewMultipart({ prompt: "lake", assetId: assetId!, size: "auto", resolution, quality: "auto" });
        return app.inject({ method: "POST", url: "/api/generate/edit", headers: { cookie, "content-type": form.contentType }, payload: form.payload });
      }
      return app.inject({ method: "POST", url: editing ? "/api/generate/edit" : mode === "stream" ? "/api/generate/stream" : "/api/generate", headers: { cookie }, payload: { prompt: "lake", ...(editing ? { assetIds: [assetId] } : {}), params: { size: "auto", resolution, quality: "auto" } } });
    };
    for (const resolution of ["1K", "2K", "4K"]) {
      const invalid = await request(resolution);
      if (mode === "stream") expect(JSON.parse(invalid.body.trim())).toMatchObject({ type: "error", statusCode: 400, error: expect.stringContaining("自动尺寸") });
      else { expect(invalid.statusCode).toBe(400); expect(invalid.json().error ?? invalid.json().message).toContain("自动尺寸"); }
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(await repo.imageGenerationLedger(db)).toEqual([]);
    const valid = await request("auto");
    const result = mode === "stream" ? valid.body.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "completed").result : valid.json();
    expect(valid.statusCode).toBe(200); expect(result.quotaCost).toBe(12); expect(fetcher).toHaveBeenCalledTimes(1);
    const wire = fetcher.mock.calls[0]![1]!.body;
    const parameters = wire instanceof FormData ? Object.fromEntries(wire) : JSON.parse(String(wire));
    expect(parameters).toMatchObject({ size: "auto", quality: "auto" }); expect(parameters).not.toHaveProperty("resolution");
    expect((await repo.imageGenerationLedger(db))[0]!.amount).toBe(-12);
  });

  it.each(["generation", "stream", "edit", "multipart", "optimize"] as const)("accepts complete source prompts through 20000 and rejects 20001 in %s", async mode => {
    const { app, cookie } = await setup();
    const editing = mode === "edit" || mode === "multipart";
    const textTool = mode === "optimize";
    const assetId = editing ? await reviewReference(app, cookie) : undefined;
    await app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie }, payload: { kind: textTool ? "text" : "image", name: "length", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: textTool ? "gpt-text" : provider.model, mode: textTool ? "chat_completions" : editing ? "edits" : "generations", imageCapabilities: { supportsStreaming: false } } });
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(textTool ? { choices: [{ message: { content: "A lake in soft light." } }] } : { data: [{ b64_json: "aW1hZ2U=" }] })));
    vi.stubGlobal("fetch", fetcher);
    for (const length of [4001, 20000, 20001]) {
      const prompt = "A".repeat(length);
      const form = reviewMultipart({ prompt, assetId: assetId!, size: "1024x1024", resolution: "1K" });
      const response = mode === "multipart"
        ? await app.inject({ method: "POST", url: "/api/generate/edit", headers: { cookie, "content-type": form.contentType }, payload: form.payload })
        : await app.inject({ method: "POST", url: textTool ? "/api/prompt-tools/" + mode : editing ? "/api/generate/edit" : mode === "stream" ? "/api/generate/stream" : "/api/generate", headers: { cookie }, payload: textTool ? { inputPrompt: prompt } : { prompt, ...(editing ? { assetIds: [assetId] } : {}) } });
      expect(response.statusCode).toBe(length > 20000 ? 400 : 200);
      if (length > 20000) { expect(response.json()).toMatchObject({ error: "请求参数无效", details: expect.any(Array) }); continue; }
      if (mode === "stream") expect(response.body).toContain('"type":"completed"');
      const wire = fetcher.mock.calls.at(-1)![1]!.body;
      const parameters = wire instanceof FormData ? Object.fromEntries(wire) : JSON.parse(String(wire));
      expect(textTool ? parameters.messages[1].content : parameters.prompt).toBe(prompt);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("returns 400 for uncaught Zod validation failures outside generation", async () => {
    const { app, cookie } = await setup();
    const response = await app.inject({ method: "PATCH", url: "/api/admin/quota-pricing", headers: { cookie }, payload: { rules: "invalid" } });
    expect(response.statusCode).toBe(400); expect(response.json().error).toBe("请求参数无效");
  });
});

describe("upfront quota reservations", () => {
  it("settles only returned images and retains partial results when a sibling call fails", async () => {
    const {app,cookie,db} = await setup();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[{b64_json:Buffer.from("partial-image").toString("base64") }]}))).mockResolvedValue(new Response(JSON.stringify({error:{message:"invalid quality"}}),{status:400}));
    vi.stubGlobal("fetch",fetcher);
    await app.inject({method:"POST",url:"/api/admin/providers",headers:{cookie},payload:{kind:"image",name:"partial",baseUrl:"https://partial.test",apiKey:"test",model:"image-model",mode:"generations"}});
    const before = (await app.inject({method:"GET",url:"/api/auth/me",headers:{cookie}})).json().quota;
    const response = await app.inject({method:"POST",url:"/api/generate",headers:{cookie},payload:{prompt:"two images",params:{resolution:"1K",quality:"low",n:2}}});
    expect(response.statusCode).toBe(200); expect(response.json().assets).toHaveLength(1); expect(response.json().quotaCost).toBe(1); expect(response.json().remainingQuota).toBe(before-1);
    const reservation = await db.queryOne<{state:string}>("SELECT state FROM image_quota_reservations WHERE job_id = ?",[response.json().jobId]);
    expect(reservation?.state).toBe("settled");
  });
  it("refunds failures exactly once and reports zero actual usage", async () => {
    const {app,cookie,db} = await setup();
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:"invalid quality"}}),{status:400})));
    await app.inject({method:"POST",url:"/api/admin/providers",headers:{cookie},payload:{kind:"image",name:"failed",baseUrl:"https://failed.test",apiKey:"test",model:"image-model",mode:"generations"}});
    const user = (await app.inject({method:"GET",url:"/api/auth/me",headers:{cookie}})).json();
    const response = await app.inject({method:"POST",url:"/api/generate",headers:{cookie},payload:{prompt:"an image",params:{resolution:"1K",quality:"low"}}});
    expect(response.statusCode).toBe(502);
    await repo.refundImageQuota(db,user.id,response.json().jobId);
    expect(await repo.getQuota(db,user.id)).toBe(user.quota);
    expect(await db.query("SELECT id FROM usage_ledger WHERE action = 'image_generation'")).toHaveLength(0);
  });
});

it("retains saved images and never calls backup when local settlement fails", async () => {
  const {app,cookie,db} = await setup();
  const fetcher = vi.fn(async()=>new Response(JSON.stringify({data:[{b64_json:Buffer.from("already-paid-output").toString("base64") }]})));
  vi.stubGlobal("fetch",fetcher);
  for (const name of ["primary","backup"]) await app.inject({method:"POST",url:"/api/admin/providers",headers:{cookie},payload:{kind:"image",name,baseUrl:"https://"+name+".test",apiKey:"test",model:"image-model",mode:"generations"}});
  const user = (await app.inject({method:"GET",url:"/api/auth/me",headers:{cookie}})).json();
  const fail = vi.spyOn(repo,"settleImageQuota").mockRejectedValueOnce(new Error("ledger unavailable"));
  try {
    const response = await app.inject({method:"POST",url:"/api/generate",headers:{cookie},payload:{prompt:"an image",params:{resolution:"1K",quality:"low"}}});
    expect(response.statusCode).toBe(200); expect(response.json().assets).toHaveLength(1); expect(response.json().quotaCost).toBe(0); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await app.inject({method:"GET",url:"/api/assets",headers:{cookie}})).json()).toHaveLength(1);
    expect(await repo.getQuota(db,user.id)).toBe(user.quota);
  } finally { fail.mockRestore(); }
});

it("accepts images/results envelopes without dropping completed images", async () => {
  for (const key of ["images", "results"]) {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({[key]:[{b64_json:"complete-image"}]})));
    const result = await callImageProvider(provider, {prompt:"lake",params:{}}, fetcher as typeof fetch);
    expect(result.images[0]?.b64Json).toBe("complete-image");
  }
});
it("finishes an SSE event-name completion without waiting for upstream EOF", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({start(controller) { controller.enqueue(new TextEncoder().encode('event: image_generation.completed\ndata: {"b64_json":"complete-image"}\n\n')); }, cancel() { cancelled = true; }});
  const result = await callImageProviderStream(provider, {prompt:"lake",params:{}}, () => {}, vi.fn(async () => new Response(stream,{headers:{"content-type":"text/event-stream"}})) as typeof fetch);
  expect(result.images[0]?.b64Json).toBe("complete-image");
  expect(cancelled).toBe(true);
});
