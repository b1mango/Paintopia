import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";
import type { AppDatabase } from "../src/db/database";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
let tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("production-ready asset and secret flows", () => {
  it("removes transient edit references and serves generated downloads as attachments", async () => {
    const generatedBytes = Buffer.from("distinct-generated-image");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: generatedBytes.toString("base64") }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const { app, cookie } = await createAuthenticatedApp();
    try {
      await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie },
        payload: {
          kind: "image",
          name: "Edit Provider",
          baseUrl: "https://edit.example",
          apiKey: "test-key",
          model: "gpt-image-2",
          mode: "edits",
          maxConcurrency: 1
        }
      });
      const transientAssetId = await uploadAsset(app, cookie);

      const generation = await app.inject({
        method: "POST",
        url: "/api/generate/edit",
        headers: { cookie },
        payload: {
          prompt: "change the background",
          params: { resolution: "1K", quality: "low", n: 1 },
          assetIds: [],
          transientAssetIds: [transientAssetId]
        }
      });

      expect(generation.statusCode).toBe(200);
      const generatedAssetId = generation.json().assets[0].id as string;
      const assets = await app.inject({
        method: "GET",
        url: "/api/assets",
        headers: { cookie }
      });
      expect(assets.json().map((asset: { id: string }) => asset.id)).toEqual([generatedAssetId]);

      const assetDownload = await app.inject({
        method: "GET",
        url: "/api/assets/" + generatedAssetId + "/download",
        headers: { cookie }
      });
      expect(assetDownload.statusCode).toBe(200);
      expect(assetDownload.headers["content-disposition"]).toContain("attachment");

      const gallery = await app.inject({
        method: "POST",
        url: "/api/assets/" + generatedAssetId + "/gallery",
        headers: { cookie }
      });
      const galleryDownload = await app.inject({
        method: "GET",
        url: "/api/gallery/" + gallery.json().id + "/download",
        headers: { cookie }
      });
      expect(galleryDownload.statusCode).toBe(200);
      expect(galleryDownload.headers["content-disposition"]).toContain("attachment");
    } finally {
      await app.close();
    }
  });

  it("uploads an asset in two phases and completes it without multipart generation payloads", async () => {
    const { app, cookie } = await createAuthenticatedApp();
    try {
      const intent = await app.inject({
        method: "POST",
        url: "/api/assets/uploads",
        headers: { cookie },
        payload: {
          fileName: "reference.png",
          mimeType: "image/png",
          sizeBytes: onePixelPng.length,
          prompt: "reference image"
        }
      });
      expect(intent.statusCode).toBe(201);
      expect(intent.json().uploadUrl).toBe(`/api/assets/${intent.json().assetId}/upload`);

      const upload = await app.inject({
        method: "PUT",
        url: intent.json().uploadUrl,
        headers: {
          cookie,
          "content-type": "image/png"
        },
        payload: onePixelPng
      });
      expect(upload.statusCode).toBe(204);

      const complete = await app.inject({
        method: "POST",
        url: `/api/assets/${intent.json().assetId}/complete-upload`,
        headers: { cookie }
      });
      expect(complete.statusCode).toBe(200);
      expect(complete.json()).toMatchObject({
        id: intent.json().assetId,
        prompt: "reference image",
        gallerySynced: false,
        ownerName: "admin",
        ownerEmail: "admin@paintopia.local",
        thumbnailUrl: `/api/assets/${intent.json().assetId}/thumbnail`
      });

      const original = await app.inject({
        method: "GET",
        url: complete.json().imageUrl,
        headers: { cookie }
      });
      expect(original.statusCode).toBe(200);
      expect(original.headers["content-type"]).toContain("image/png");

      const thumbnail = await app.inject({
        method: "GET",
        url: complete.json().thumbnailUrl,
        headers: { cookie }
      });
      expect(thumbnail.statusCode).toBe(200);
      expect(thumbnail.headers["content-type"]).toContain("image/webp");
      expect(thumbnail.rawPayload.length).toBeLessThan(original.rawPayload.length + 256);
    } finally {
      await app.close();
    }
  });

  it("keeps gallery submissions pending until approval and preserves the owner's permanent retention on unsync", async () => {
    const { app, cookie } = await createAuthenticatedApp();
    try {
      const assetId = await uploadAsset(app, cookie);
      const submit = await app.inject({
        method: "POST",
        url: `/api/assets/${assetId}/gallery`,
        headers: { cookie }
      });
      expect(submit.statusCode).toBe(201);
      expect(submit.json().status).toBe("pending");

      const reviewList = await app.inject({
        method: "GET",
        url: "/api/admin/gallery-review?status=pending",
        headers: { cookie }
      });
      expect(reviewList.statusCode).toBe(200);
      expect(reviewList.json()).toEqual([
        expect.objectContaining({
          id: submit.json().id,
          status: "pending",
          authorName: "admin",
          thumbnailUrl: `/api/gallery/${submit.json().id}/thumbnail`
        })
      ]);

      const approve = await app.inject({
        method: "PATCH",
        url: `/api/admin/gallery-review/${submit.json().id}`,
        headers: { cookie },
        payload: { decision: "approve", tagIds: ["illustration"] }
      });
      expect(approve.statusCode).toBe(200);
      expect(approve.json().status).toBe("approved");

      const appDb = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
      const permanent = await appDb.queryOne<{ originalPath: string; expiresAt: number | null }>(`
        SELECT original_path AS "originalPath", expires_at AS "expiresAt" FROM assets WHERE id = ?
      `, [assetId]);
      expect(permanent?.originalPath).toMatch(/^gallery\//);
      expect(permanent?.expiresAt).toBeNull();

      const unsync = await app.inject({
        method: "DELETE",
        url: `/api/assets/${assetId}/gallery`,
        headers: { cookie }
      });
      expect(unsync.statusCode).toBe(200);
      expect(unsync.json().expiresAt).toBeNull();
      const temporary = await appDb.queryOne<{ originalPath: string; expiresAt: number | null }>(`
        SELECT original_path AS "originalPath", expires_at AS "expiresAt" FROM assets WHERE id = ?
      `, [assetId]);
      expect(temporary?.originalPath).toMatch(/^permanent\//);
      expect(temporary?.expiresAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("encrypts provider keys at rest and never returns them to the admin client", async () => {
    const { app, cookie } = await createAuthenticatedApp({
      providerEncryptionKey: Buffer.alloc(32, 7).toString("base64")
    });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie },
        payload: {
          kind: "image",
          name: "Encrypted Provider",
          baseUrl: "https://provider.example",
          apiKey: "provider-secret",
          model: "gpt-image-2",
          mode: "generations"
        }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().apiKey).toBe("********");

      const appDb = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
      const row = await appDb.queryOne<{ apiKey: string }>(
        `SELECT api_key AS "apiKey" FROM provider_configs WHERE id = ?`,
        [created.json().id]
      );
      expect(row?.apiKey).toMatch(/^enc:v1:/);
      expect(row?.apiKey).not.toContain("provider-secret");
    } finally {
      await app.close();
    }
  });
});

async function createAuthenticatedApp(overrides: { providerEncryptionKey?: string } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-production-routes-"));
  tempDirs.push(dataDir);
  const app = await createServer({
    dataDir,
    bootstrapEmail: "admin@paintopia.local",
    bootstrapPassword: "paintopia123",
    webOrigin: "http://localhost:5173",
    sessionSecret: "test-secret",
    assetRetentionDays: 7,
    pendingGalleryRetentionDays: 30,
    cronSecret: "cron-test-secret",
    ...overrides
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "admin@paintopia.local",
      password: "paintopia123"
    }
  });
  const setCookie = login.headers["set-cookie"];
  return {
    app,
    cookie: Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)
  };
}

async function uploadAsset(app: Awaited<ReturnType<typeof createServer>>, cookie: string) {
  const intent = await app.inject({
    method: "POST",
    url: "/api/assets/uploads",
    headers: { cookie },
    payload: {
      fileName: "gallery.png",
      mimeType: "image/png",
      sizeBytes: onePixelPng.length,
      prompt: "gallery candidate"
    }
  });
  await app.inject({
    method: "PUT",
    url: intent.json().uploadUrl,
    headers: {
      cookie,
      "content-type": "image/png"
    },
    payload: onePixelPng
  });
  const complete = await app.inject({
    method: "POST",
    url: `/api/assets/${intent.json().assetId}/complete-upload`,
    headers: { cookie }
  });
  expect(complete.statusCode).toBe(200);
  return intent.json().assetId as string;
}
