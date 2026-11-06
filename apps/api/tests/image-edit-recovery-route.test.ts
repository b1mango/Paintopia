import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const generatedPng = (() => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(1024, 16);
  bytes.writeUInt32BE(1024, 20);
  return bytes;
})();

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("image edit recovery contract", () => {
  it.each(["edits", "generations"])("exposes the client request id through %s providers", async (mode) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: generatedPng.toString("base64") }]
    }), { status: 200 })));
    const app = await createServer({
      dataDir,
      bootstrapEmail: "admin@paintopia.local",
      bootstrapPassword: "test-password-123",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@paintopia.local", password: "test-password-123" }
      });
      const cookie = String(login.headers["set-cookie"]);

      await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie },
        payload: {
          kind: "image",
          name: "Recovery edit provider",
          baseUrl: "https://edit.example/v1",
          apiKey: "test-key",
          model: "gpt-image-2",
          mode,
          maxConcurrency: 1
        }
      });

      for (const [sizeBytes, expected] of [[20 * 1024 * 1024, 201], [20 * 1024 * 1024 + 1, 400]]) {
        const boundary = await app.inject({method:"POST",url:"/api/assets/uploads",headers:{cookie},payload:{fileName:"large.png",mimeType:"image/png",sizeBytes,prompt:"size boundary"}});
        expect(boundary.statusCode).toBe(expected);
      }

      const intent = await app.inject({
        method: "POST",
        url: "/api/assets/uploads",
        headers: { cookie },
        payload: {
          fileName: "reference.png",
          mimeType: "image/png",
          sizeBytes: onePixelPng.length,
          prompt: "recovery reference"
        }
      });
      const assetId = intent.json().assetId as string;
      await app.inject({
        method: "PUT",
        url: intent.json().uploadUrl,
        headers: { cookie, "content-type": "image/png" },
        payload: onePixelPng
      });
      await app.inject({
        method: "POST",
        url: `/api/assets/${assetId}/complete-upload`,
        headers: { cookie }
      });

      const clientRequestId = "edit-recovery-contract";
      const generation = await app.inject({
        method: "POST",
        url: "/api/generate/edit",
        headers: { cookie },
        payload: {
          prompt: "recover the completed edit",
          params: {
            model: "gpt-image-2",
            resolution: "1K",
            quality: "high",
            n: 1,
            clientRequestId
          },
          transientAssetIds: [assetId]
        }
      });
      expect(generation.statusCode).toBe(200);
      expect(fetch).toHaveBeenCalledWith("https://edit.example/v1/images/edits", expect.objectContaining({body:expect.any(FormData)}));

      const assets = await app.inject({
        method: "GET",
        url: "/api/assets",
        headers: { cookie }
      });
      expect(assets.statusCode).toBe(200);
      expect(assets.json()).toEqual([
        expect.objectContaining({
          id: generation.json().assets[0].id,
          params: expect.objectContaining({
            clientRequestId,
            mode: "image-edit"
          })
        })
      ]);
    } finally {
      await app.close();
    }
  });
});
