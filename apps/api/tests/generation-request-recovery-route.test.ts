import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";

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

describe("generation request recovery", () => {
  it("reports running and then recovers the succeeded stream assets", async () => {
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    let finishProvider!: (response: Response) => void;
    const providerResponse = new Promise<Response>((resolve) => { finishProvider = resolve; });
    const fetchImpl = vi.fn(async () => {
      markProviderStarted();
      return providerResponse;
    });
    const { app, cookie } = await createTestApp(fetchImpl);
    const clientRequestId = "stream_recovery-1";

    try {
      const generationPromise = app.inject({
        method: "POST",
        url: "/api/generate/stream",
        headers: { cookie },
        payload: {
          prompt: "recover this streamed image",
          params: { quality: "low", n: 1, clientRequestId }
        }
      });
      await providerStarted;
      const running = await app.inject({
        method: "GET",
        url: `/api/generate/requests/${clientRequestId}`,
        headers: { cookie }
      });
      finishProvider(new Response(JSON.stringify({
        data: [{ b64_json: generatedPng.toString("base64") }]
      }), { status: 200 }));

      expect(running.statusCode).toBe(200);
      expect(running.json()).toEqual({
        status: "running",
        startedAt: expect.any(String)
      });
      expect(Number.isNaN(Date.parse(running.json().startedAt))).toBe(false);

      const generation = await generationPromise;
      expect(generation.statusCode).toBe(200);
      const events = generation.body.trim().split("\n").map((line) => JSON.parse(line));
      const completed = events.find((event) => event.type === "completed").result;
      const recovered = await app.inject({
        method: "GET",
        url: `/api/generate/requests/${clientRequestId}`,
        headers: { cookie }
      });

      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toMatchObject({
        status: "succeeded",
        jobId: completed.jobId,
        remainingQuota: completed.remainingQuota,
        assets: [{
          id: completed.assets[0].id,
          imageUrl: completed.assets[0].imageUrl,
          thumbnailUrl: completed.assets[0].thumbnailUrl,
          prompt: "recover this streamed image",
          params: expect.objectContaining({ clientRequestId })
        }]
      });
    } finally {
      finishProvider(new Response(null, { status: 502 }));
      await app.close();
    }
  });

  it("reports an upstream generation failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "upstream generation exploded" }
    }), { status: 502 }));
    const { app, cookie } = await createTestApp(fetchImpl);
    const clientRequestId = "failed_generation-1";

    try {
      const generation = await app.inject({
        method: "POST",
        url: "/api/generate",
        headers: { cookie },
        payload: {
          prompt: "this generation should fail",
          params: { quality: "low", clientRequestId }
        }
      });
      expect(generation.statusCode).toBe(502);

      const recovered = await app.inject({
        method: "GET",
        url: `/api/generate/requests/${clientRequestId}`,
        headers: { cookie }
      });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toEqual({
        status: "failed",
        error: expect.stringContaining("upstream generation exploded")
      });
    } finally {
      await app.close();
    }
  });

  it("does not expose another user's request and validates access and ids", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: generatedPng.toString("base64") }]
    }), { status: 200 }));
    const { app, cookie } = await createTestApp(fetchImpl);
    const clientRequestId = "private_generation-1";

    try {
      const generation = await app.inject({
        method: "POST",
        url: "/api/generate",
        headers: { cookie },
        payload: {
          prompt: "only the owner can recover this",
          params: { quality: "low", clientRequestId }
        }
      });
      expect(generation.statusCode).toBe(200);

      const invite = await app.inject({
        method: "POST",
        url: "/api/admin/invite-codes",
        headers: { cookie }
      });
      const registration = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          email: "other@paintopia.local",
          password: "other-test-password",
          inviteCode: invite.json().code
        }
      });
      expect(registration.statusCode).toBe(200);
      const otherCookie = String(registration.headers["set-cookie"]);

      const otherUserLookup = await app.inject({
        method: "GET",
        url: `/api/generate/requests/${clientRequestId}`,
        headers: { cookie: otherCookie }
      });
      expect(otherUserLookup.statusCode).toBe(200);
      expect(otherUserLookup.json()).toEqual({ status: "not_found" });

      const missing = await app.inject({
        method: "GET",
        url: "/api/generate/requests/not_started-1",
        headers: { cookie }
      });
      expect(missing.statusCode).toBe(200);
      expect(missing.json()).toEqual({ status: "not_found" });

      for (const invalidId of ["invalid.id", "a".repeat(81)]) {
        const invalid = await app.inject({
          method: "GET",
          url: `/api/generate/requests/${invalidId}`,
          headers: { cookie }
        });
        expect(invalid.statusCode).toBe(400);
      }

      const unauthenticated = await app.inject({
        method: "GET",
        url: `/api/generate/requests/${clientRequestId}`
      });
      expect(unauthenticated.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

async function createTestApp(fetchImpl: unknown) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
  tempDirs.push(dataDir);
  vi.stubGlobal("fetch", fetchImpl);
  const app = await createServer({
    dataDir,
    bootstrapEmail: "admin@paintopia.local",
    bootstrapPassword: "test-password-123",
    webOrigin: "http://localhost:5173",
    sessionSecret: "test-secret"
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@paintopia.local", password: "test-password-123" }
  });
  const cookie = String(login.headers["set-cookie"]);
  const provider = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    headers: { cookie },
    payload: {
      kind: "image",
      name: "Recovery Provider",
      baseUrl: "https://recovery.example/v1",
      apiKey: "test-key",
      model: "gpt-image-2",
      mode: "generations",
      maxConcurrency: 1
    }
  });
  expect(provider.statusCode).toBe(201);
  return { app, cookie };
}
