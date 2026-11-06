import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";

let tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("generation route", () => {
  it("syncs an asset to gallery once", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = Buffer.from("gallery-sync-png");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: imageBytes.toString("base64") }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "NewAPI GPT Image 2",
        baseUrl: "https://newapi.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "gallery prompt should become title",
        params: {}
      }
    });
    const assetId = generation.json().assets[0].id;

    const firstSync = await app.inject({
      method: "POST",
      url: `/api/assets/${assetId}/gallery`,
      headers: { cookie: cookieHeader }
    });

    expect(firstSync.statusCode).toBe(201);
    expect(firstSync.json()).toMatchObject({
      assetId,
      title: "gallery prompt should bec",
      prompt: "gallery prompt should become title",
      status: "pending"
    });

    const secondSync = await app.inject({
      method: "POST",
      url: `/api/assets/${assetId}/gallery`,
      headers: { cookie: cookieHeader }
    });

    expect(secondSync.statusCode).toBe(200);
    expect(secondSync.json().id).toBe(firstSync.json().id);

    const gallery = await app.inject({
      method: "GET",
      url: "/api/gallery",
      headers: { cookie: cookieHeader }
    });

    expect(gallery.statusCode).toBe(200);
    expect(gallery.json()).toMatchObject([
      {
        id: firstSync.json().id,
        assetId,
        imageUrl: `/api/gallery/${firstSync.json().id}/image`,
        prompt: "gallery prompt should become title",
        status: "pending"
      }
    ]);

    const assets = await app.inject({
      method: "GET",
      url: "/api/assets",
      headers: { cookie: cookieHeader }
    });

    expect(assets.json()[0]).toMatchObject({
      id: assetId,
      gallerySynced: true,
      galleryItemId: firstSync.json().id
    });

    const unsync = await app.inject({
      method: "DELETE",
      url: `/api/assets/${assetId}/gallery`,
      headers: { cookie: cookieHeader }
    });
    expect(unsync.statusCode).toBe(200);
    expect(unsync.json().expiresAt).toBeNull();

    const galleryAfterUnsync = await app.inject({
      method: "GET",
      url: "/api/gallery",
      headers: { cookie: cookieHeader }
    });
    expect(galleryAfterUnsync.json()).toEqual([]);

    const assetsAfterUnsync = await app.inject({
      method: "GET",
      url: "/api/assets",
      headers: { cookie: cookieHeader }
    });
    expect(assetsAfterUnsync.json()[0]).toMatchObject({
      id: assetId,
      gallerySynced: false,
      galleryItemId: null
    });

    await app.close();
  });

  it("generates through OpenAI-compatible images endpoint and returns an asset URL", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = Buffer.from("fake-png-bytes");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: imageBytes.toString("base64") }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "NewAPI GPT Image 2",
        baseUrl: "https://newapi.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "minimal Paintopia icon",
        params: {
          size: "1024x1024",
          quality: "low"
        }
      }
    });

    expect(generation.statusCode).toBe(200);
    const body = generation.json();
    expect(body).toMatchObject({
      quotaCost: 1,
      remainingQuota: 99
    });
    expect(body.assets[0]).toMatchObject({
      imageUrl: expect.stringMatching(/^\/api\/assets\/.+\/original$/),
      prompt: "minimal Paintopia icon",
      params: expect.objectContaining({ resolutionWarning: expect.stringContaining("无法读取实际尺寸") })
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://newapi.example/v1/images/generations", expect.objectContaining({
      method: "POST"
    }));

    const asset = await app.inject({
      method: "GET",
      url: body.assets[0].imageUrl,
      headers: { cookie: cookieHeader }
    });

    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("image/png");
    expect(asset.body).toBe("fake-png-bytes");

    const list = await app.inject({
      method: "GET",
      url: "/api/assets",
      headers: { cookie: cookieHeader }
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([
      {
        id: body.assets[0].id,
        imageUrl: body.assets[0].imageUrl,
        prompt: "minimal Paintopia icon"
      }
    ]);

    const deleteAsset = await app.inject({
      method: "DELETE",
      url: `/api/assets/${body.assets[0].id}`,
      headers: { cookie: cookieHeader }
    });

    expect(deleteAsset.statusCode).toBe(204);

    const afterDelete = await app.inject({
      method: "GET",
      url: "/api/assets",
      headers: { cookie: cookieHeader }
    });
    expect(afterDelete.json()).toEqual([]);

    await app.close();

    const database = new Database(path.join(dataDir, "paintopia.sqlite"), { readonly: true });
    try {
      const user = database.prepare("SELECT quota FROM users WHERE email = ?").get("owner") as { quota: number };
      const ledger = database.prepare(
        "SELECT action, amount, note FROM usage_ledger ORDER BY created_at DESC LIMIT 1"
      ).get() as { action: string; amount: number; note: string };
      expect(user.quota).toBe(99);
      expect(ledger).toMatchObject({
        action: "image_generation",
        amount: -1
      });
      expect(ledger.note).toContain(body.jobId);
    } finally {
      database.close();
    }
  });

  it("generates through Chat Completions image mode and extracts the gateway Markdown result", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = Buffer.from("chat-route-png");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        choices: [
          {
            message: {
              content: "![image](data:image/png;base64," + imageBytes.toString("base64") + ")"
            }
          }
        ]
      }
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner", password: "owner-test-password" }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "688 Chat Image",
        baseUrl: "https://relay.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "chat_completions",
        maxConcurrency: 1
      }
    });

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate/stream",
      headers: { cookie: cookieHeader },
      payload: { prompt: "chat image prompt", params: { quality: "low" } }
    });

    expect(generation.statusCode).toBe(200);
    expect(generation.headers["content-type"]).toContain("application/x-ndjson");
    const events = generation.body.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type === "stage" ? event.stage : event.type)).toEqual(["requesting", "waiting", "saving", "completed"]);
    expect(events[1].message).toContain("不提供过程预览");
    const body = events[3].result;
    expect(body.assets[0]).toMatchObject({
      imageUrl: expect.stringMatching(/^\/api\/assets\/.+\/original$/),
      prompt: "chat image prompt"
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://relay.example/v1/chat/completions", expect.objectContaining({
      method: "POST"
    }));
    await app.close();
  });

  it("streams a partial preview before returning the completed asset", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const finalImageBytes = Buffer.from("stream-final-png");
    const sse = [
      `data: ${JSON.stringify({
        type: "image_generation.partial_image",
        b64_json: Buffer.from("stream-preview").toString("base64"),
        output_format: "png",
        partial_image_index: 0
      })}`,
      "",
      `data: ${JSON.stringify({
        type: "image_generation.completed",
        b64_json: finalImageBytes.toString("base64"),
        output_format: "png"
      })}`,
      ""
    ].join("\n");
    const fetchImpl = vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);
    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Streaming GPT Image 2",
        imageCapabilities: { supportsStreaming: true },
        baseUrl: "https://stream.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate/stream",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "stream a fast preview",
        params: { size: "1024x1024", quality: "low", n: 1 }
      }
    });

    expect(generation.statusCode).toBe(200);
    expect(generation.headers["content-type"]).toContain("application/x-ndjson");
    const events = generation.body.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map(event => event.type === "stage" ? event.stage : event.type)).toEqual(["requesting", "waiting", "preview", "saving", "completed"]);
    expect(events[2]).toMatchObject({
      type: "preview",
      mimeType: "image/png",
      partialImageIndex: 0
    });
    expect(events[4]).toMatchObject({
      type: "completed",
      result: {
        assets: [{ imageUrl: expect.stringMatching(/^\/api\/assets\/.+\/original$/) }]
      }
    });
    const providerCalls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(String(providerCalls[0]![1].body))).toMatchObject({
      stream: true,
      partial_images: 1
    });

    await app.close();
  });

  it("falls back to the regular request when a gateway rejects streaming parameters", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unsupported parameter: stream" }
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("fallback-final").toString("base64") }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);
    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Legacy Gateway",
        imageCapabilities: { supportsStreaming: true },
        baseUrl: "https://legacy.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate/stream",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "fallback without duplicate output",
        params: { quality: "low", n: 1 }
      }
    });

    expect(generation.statusCode).toBe(200);
    const events = generation.body.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map(event => event.type === "stage" ? event.stage : event.type)).toEqual(["requesting", "waiting", "waiting", "saving", "completed"]);
    expect(events[2]).toMatchObject({ type: "stage", stage: "waiting", message: "上游不支持过程预览，等待最终图片" });
    expect(events[4]).toMatchObject({
      type: "completed",
      result: { assets: [expect.objectContaining({ prompt: "fallback without duplicate output" })] }
    });
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]![1].body))).toMatchObject({ stream: true, partial_images: 1 });
    expect(JSON.parse(String(calls[1]![1].body))).not.toHaveProperty("stream");

    await app.close();
  });

  it("rejects generation before calling the provider when quota is insufficient", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);
    const userId = login.json().id;

    await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${userId}`,
      headers: { cookie: cookieHeader },
      payload: { quota: 0 }
    });

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Quota Provider",
        baseUrl: "https://quota.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "should not reach provider",
        params: {
          size: "1024x1024",
          quality: "high",
          n: 1
        }
      }
    });

    expect(generation.statusCode).toBe(402);
    expect(generation.json().error).toContain("额度不足");
    expect(fetchImpl).not.toHaveBeenCalled();

    await app.close();
  });

  it("reserves quota before upstream calls when concurrent jobs compete for balance", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    let providerCalls = 0;
    const fetchImpl = vi.fn(async () => {
      providerCalls++;
      await new Promise(resolve => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("concurrent-one").toString("base64") }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);
    const userId = login.json().id;
    await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${userId}`,
      headers: { cookie: cookieHeader },
      payload: { quota: 1 }
    });
    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Concurrent Quota Provider",
        baseUrl: "https://quota-race.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });

    const request = (prompt: string) => app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt,
        params: { quality: "low", n: 1 }
      }
    });
    const responses = await Promise.all([
      request("concurrent quota one"),
      request("concurrent quota two")
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 402]);
    expect(providerCalls).toBe(1);
    const assets = await app.inject({
      method: "GET",
      url: "/api/assets",
      headers: { cookie: cookieHeader }
    });
    expect(assets.json()).toHaveLength(1);
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader }
    });
    expect(me.json().quota).toBe(0);

    await app.close();
  });

  it("uses the saved image provider order for automatic generation fallback priority", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = Buffer.from("ordered-provider-png");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: imageBytes.toString("base64") }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "owner",
          password: "owner-test-password"
        }
      });
      const cookie = login.headers["set-cookie"];
      const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

      const newApiProvider = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "NewAPI Image",
          baseUrl: "https://newapi.example",
          apiKey: "newapi-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });
      const customProvider = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "Custom Preferred Image",
          baseUrl: "https://preferred.example",
          apiKey: "preferred-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });

      const reorder = await app.inject({
        method: "PATCH",
        url: "/api/admin/providers/order",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          providerIds: [customProvider.json().id, newApiProvider.json().id]
        }
      });
      expect(reorder.statusCode).toBe(200);

      const generation = await app.inject({
        method: "POST",
        url: "/api/generate",
        headers: { cookie: cookieHeader },
        payload: {
          prompt: "ordered provider prompt",
          params: {
            size: "1024x1024",
            quality: "low"
          }
        }
      });

      expect(generation.statusCode).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith("https://preferred.example/v1/images/generations", expect.objectContaining({
        method: "POST"
      }));
    } finally {
      await app.close();
    }
  });

  it("requests multi-image generations in one provider call when supported", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = [Buffer.from("multi-png-one"), Buffer.from("multi-png-two")];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { b64_json: imageBytes[0]!.toString("base64") },
        { b64_json: imageBytes[1]!.toString("base64") }
      ]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "NewAPI GPT Image 2",
        baseUrl: "https://newapi.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "four separate millennium China photos",
        params: {
          size: "1024x1024",
          quality: "low",
          n: 2
        }
      }
    });

    expect(generation.statusCode).toBe(200);
    const body = generation.json();
    expect(body.assets).toHaveLength(2);
    expect(body.assets.map((asset: { imageUrl: string }) => asset.imageUrl)).toEqual([
      expect.stringMatching(/^\/api\/assets\/.+\/original$/),
      expect.stringMatching(/^\/api\/assets\/.+\/original$/)
    ]);

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]![1].body))).toMatchObject({ n: 2 });

    const list = await app.inject({
      method: "GET",
      url: "/api/assets",
      headers: { cookie: cookieHeader }
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(2);

    await app.close();
  });

  it("falls back to per-image requests when a provider rejects batched n", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = [Buffer.from("fallback-png-one"), Buffer.from("fallback-png-two")];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "n must be 1 for this model" }
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: imageBytes[0]!.toString("base64") }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: imageBytes[1]!.toString("base64") }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Single Image Gateway",
        baseUrl: "https://single.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "two standalone icon variants",
        params: {
          size: "1024x1024",
          quality: "low",
          n: 2
        }
      }
    });

    expect(generation.statusCode).toBe(200);
    expect(generation.json().assets).toHaveLength(2);

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls).toHaveLength(3);
    expect(JSON.parse(String(calls[0]![1].body))).toMatchObject({ n: 2 });
    expect(JSON.parse(String(calls[1]![1].body))).toMatchObject({ n: 1 });
    expect(JSON.parse(String(calls[2]![1].body))).toMatchObject({ n: 1 });

    await app.close();
  });

  it("uses provider maxConcurrency for per-image fallback requests", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = [Buffer.from("concurrent-png-one"), Buffer.from("concurrent-png-two")];
    let activeSingleImageRequests = 0;
    let maxObservedSingleImageRequests = 0;
    let singleImageIndex = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { n?: number };
      if (body.n === 2) {
        return new Response(JSON.stringify({
          error: { message: "n must be 1 for this model" }
        }), { status: 400 });
      }

      activeSingleImageRequests += 1;
      maxObservedSingleImageRequests = Math.max(maxObservedSingleImageRequests, activeSingleImageRequests);
      const image = imageBytes[singleImageIndex++]!;
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeSingleImageRequests -= 1;
      return new Response(JSON.stringify({
        data: [{ b64_json: image.toString("base64") }]
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Concurrent Single Image Gateway",
        baseUrl: "https://single.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 2
      }
    });

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "two standalone concurrent icon variants",
        params: {
          size: "1024x1024",
          quality: "low",
          n: 2
        }
      }
    });

    expect(generation.statusCode).toBe(200);
    expect(generation.json().assets).toHaveLength(2);
    expect(maxObservedSingleImageRequests).toBe(2);

    await app.close();
  });

  it("stores image generation runtime metrics on the generation job", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = Buffer.from("metrics-png");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: imageBytes.toString("base64") }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Metrics Provider",
        baseUrl: "https://metrics.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "metrics image",
        params: {
          size: "1024x1024",
          quality: "low"
        }
      }
    });
    expect(generation.statusCode).toBe(200);
    const jobId = generation.json().jobId;
    await app.close();

    const database = new Database(path.join(dataDir, "paintopia.sqlite"), { readonly: true });
    try {
      const row = database.prepare("SELECT params_json AS paramsJson FROM generation_jobs WHERE id = ?")
        .get(jobId) as { paramsJson: string };
      const params = JSON.parse(row.paramsJson);
      expect(params.__paintopiaRuntime.imageGeneration).toMatchObject({
        requestedCount: 1,
        returnedCount: 1,
        attemptCount: 1
      });
      expect(params.__paintopiaRuntime.imageGeneration.providerRequestMs).toBeGreaterThanOrEqual(0);
      expect(params.__paintopiaRuntime.imageGeneration.persistMs).toBeGreaterThanOrEqual(0);
      expect(params.__paintopiaRuntime.imageGeneration.attempts[0]).toMatchObject({
        providerName: "Metrics Provider",
        mode: "single",
        status: "succeeded",
        returnedCount: 1
      });
    } finally {
      database.close();
    }
  });

  it("falls back to the backup image provider when the primary gateway times out", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = Buffer.from("backup-png-bytes");
    const cloudflare524 = "<html><head><title>newapi.example | 524: A timeout occurred</title></head><body><span class=\"code-label\">Error code 524</span><p>The origin web server timed out responding to this request.</p></body></html>";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(cloudflare524, {
        status: 524,
        headers: { "Content-Type": "text/html" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: imageBytes.toString("base64") }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    for (const provider of [
      {
        name: "ClipProxy GPT Image 2",
        baseUrl: "https://cpa.example/v1"
      },
      {
        name: "NewAPI GPT Image 2",
        baseUrl: "https://newapi.example"
      }
    ]) {
      await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: "test-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });
    }

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "minimal Paintopia icon",
        params: {
          size: "1024x1024",
          quality: "low"
        }
      }
    });

    expect(generation.statusCode).toBe(200);
    expect(generation.json()).toMatchObject({
      provider: {
        name: "ClipProxy GPT Image 2"
      },
      assets: [
        {
          imageUrl: expect.stringMatching(/^\/api\/assets\/.+\/original$/)
        }
      ]
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://newapi.example/v1/images/generations", expect.objectContaining({
      method: "POST"
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://cpa.example/v1/images/generations", expect.objectContaining({
      method: "POST"
    }));

    await app.close();
  });

  it("skips cooled down providers on the next automatic generation request", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const cloudflare524 = "<html><head><title>newapi.example | 524: A timeout occurred</title></head><body><span class=\"code-label\">Error code 524</span><p>The origin web server timed out responding to this request.</p></body></html>";
    const fetchImpl = vi.fn(async () => new Response(cloudflare524, {
      status: 524,
      headers: { "Content-Type": "text/html" }
    }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    for (const provider of [
      {
        name: "ClipProxy GPT Image 2",
        baseUrl: "https://cpa.example/v1"
      },
      {
        name: "NewAPI GPT Image 2",
        baseUrl: "https://newapi.example"
      }
    ]) {
      await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: "test-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });
    }

    const first = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "minimal Paintopia icon",
        params: {
          size: "1024x1024",
          quality: "low"
        }
      }
    });

    expect(first.statusCode).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const second = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "minimal Paintopia icon",
        params: {
          size: "1024x1024",
          quality: "low"
        }
      }
    });

    expect(second.statusCode).toBe(503);
    expect(second.json().error).toContain("冷却中");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("starts with the backup provider while the primary provider is cooling down", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = Buffer.from("backup-after-cooldown");
    const cloudflare524 = "<html><head><title>newapi.example | 524: A timeout occurred</title></head><body><span class=\"code-label\">Error code 524</span><p>The origin web server timed out responding to this request.</p></body></html>";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(cloudflare524, {
        status: 524,
        headers: { "Content-Type": "text/html" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: imageBytes.toString("base64") }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    for (const provider of [
      {
        name: "ClipProxy GPT Image 2",
        baseUrl: "https://cpa.example/v1"
      },
      {
        name: "NewAPI GPT Image 2",
        baseUrl: "https://newapi.example"
      }
    ]) {
      await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: "test-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });
    }

    const first = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "minimal Paintopia icon",
        providerId: "generated-provider-id-does-not-exist",
        params: {}
      }
    });
    expect(first.statusCode).toBe(503);

    const primaryFailure = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "minimal Paintopia icon",
        params: {
          size: "1024x1024",
          quality: "low"
        }
      }
    });

    expect(primaryFailure.statusCode).toBe(200);
    expect(primaryFailure.json()).toMatchObject({
      provider: {
        name: "ClipProxy GPT Image 2"
      }
    });
    expect(primaryFailure.json().skippedProviders).toEqual([]);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://newapi.example/v1/images/generations", expect.any(Object));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://cpa.example/v1/images/generations", expect.any(Object));

    const nextImageBytes = Buffer.from("backup-direct-next");
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ b64_json: nextImageBytes.toString("base64") }]
    }), { status: 200 }));

    const second = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "minimal Paintopia icon",
        params: {
          size: "1024x1024",
          quality: "low"
        }
      }
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      provider: {
        name: "ClipProxy GPT Image 2"
      },
      skippedProviders: [expect.stringContaining("NewAPI GPT Image 2 冷却中")]
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "https://cpa.example/v1/images/generations", expect.any(Object));

    await app.close();
  });

  it("does not cool down an image provider for upstream image quota exhaustion", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = Buffer.from("quota-recovered-image");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "no available image quota" }
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: imageBytes.toString("base64") }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Quota-limited GPT Image 2",
        baseUrl: "https://quota.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "4K poster",
        params: { resolution: "4K", quality: "high" }
      }
    });
    expect(first.statusCode).toBe(502);
    expect(first.json().error).toContain("no available image quota");

    const second = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "1K retry after quota failure",
        params: { resolution: "1K", quality: "high" }
      }
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().provider).toMatchObject({ name: "Quota-limited GPT Image 2" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("clears image provider cooldown when admin reorders providers", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const cloudflare524 = '<html><head><title>primary.example | 524: A timeout occurred</title></head><body><span class="code-label">Error code 524</span></body></html>';
    const backupImage = Buffer.from("backup-image-after-primary-failure");
    const primaryRetryImage = Buffer.from("primary-image-after-reorder");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(cloudflare524, {
        status: 524,
        headers: { "Content-Type": "text/html" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: backupImage.toString("base64") }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: primaryRetryImage.toString("base64") }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "owner", password: "owner-test-password" }
      });
      const cookie = login.headers["set-cookie"];
      const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

      const primaryProvider = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "Primary image",
          baseUrl: "https://primary.example/v1",
          apiKey: "primary-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });
      const backupProvider = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "Backup image",
          baseUrl: "https://backup.example/v1",
          apiKey: "backup-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });
      const providerIds = [primaryProvider.json().id, backupProvider.json().id];
      const reorder = await app.inject({
        method: "PATCH",
        url: "/api/admin/providers/order",
        headers: { cookie: cookieHeader },
        payload: { kind: "image", providerIds }
      });
      expect(reorder.statusCode).toBe(200);

      const first = await app.inject({
        method: "POST",
        url: "/api/generate",
        headers: { cookie: cookieHeader },
        payload: {
          prompt: "first ordered prompt",
          params: { model: "gpt-image-2", resolution: "1K", quality: "low" }
        }
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().provider).toMatchObject({ id: backupProvider.json().id, name: "Backup image" });
      expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://primary.example/v1/images/generations", expect.any(Object));
      expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://backup.example/v1/images/generations", expect.any(Object));

      const reorderAgain = await app.inject({
        method: "PATCH",
        url: "/api/admin/providers/order",
        headers: { cookie: cookieHeader },
        payload: { kind: "image", providerIds }
      });
      expect(reorderAgain.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/api/generate",
        headers: { cookie: cookieHeader },
        payload: {
          prompt: "second ordered prompt",
          params: { model: "gpt-image-2", resolution: "1K", quality: "low" }
        }
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().provider).toMatchObject({ id: primaryProvider.json().id, name: "Primary image" });
      expect(second.json().skippedProviders).toEqual([]);
      expect(fetchImpl).toHaveBeenNthCalledWith(3, "https://primary.example/v1/images/generations", expect.any(Object));
    } finally {
      await app.close();
    }
  });
  it("honors provider order for strict 4K generation", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(imageBytes);
    imageBytes.writeUInt32BE(3840, 16);
    imageBytes.writeUInt32BE(2160, 20);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: imageBytes.toString("base64") }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "owner", password: "owner-test-password" }
      });
      const cookie = login.headers["set-cookie"];
      const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

      const lowerProvider = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "Lower priority image",
          baseUrl: "https://lower.example/v1",
          apiKey: "lower-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });
      const topProvider = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "Top priority image",
          baseUrl: "https://top.example/v1",
          apiKey: "top-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });
      const reorder = await app.inject({
        method: "PATCH",
        url: "/api/admin/providers/order",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          providerIds: [topProvider.json().id, lowerProvider.json().id]
        }
      });
      expect(reorder.statusCode).toBe(200);

      const generation = await app.inject({
        method: "POST",
        url: "/api/generate",
        headers: { cookie: cookieHeader },
        payload: {
          prompt: "ordered 4K provider prompt",
          params: { model: "gpt-image-2", resolution: "4K", quality: "high" }
        }
      });

      expect(generation.statusCode).toBe(200);
      expect(generation.json().provider).toMatchObject({
        id: topProvider.json().id,
        name: "Top priority image"
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith("https://top.example/v1/images/generations", expect.objectContaining({
        method: "POST"
      }));
      const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
      const requestBody = JSON.parse(String(calls[0]![1].body));
      expect(requestBody).toMatchObject({
        model: "gpt-image-2",
        resolution: "4K",
        quality: "high"
      });
      expect(requestBody.size).toBe("2880x2880");
    } finally {
      await app.close();
    }
  });
  it("saves falsely labeled 4K results and warns when actual pixels are only 1K", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const normalizedCanvasImage = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(normalizedCanvasImage);
    normalizedCanvasImage.writeUInt32BE(1536, 16);
    normalizedCanvasImage.writeUInt32BE(1024, 20);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      quality: "4K",
      size: "1536x1024",
      data: [{ b64_json: normalizedCanvasImage.toString("base64") }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "owner", password: "owner-test-password" }
      });
      const cookie = login.headers["set-cookie"];
      const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

      await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "Tiered Gateway",
          baseUrl: "https://tiered.example/v1",
          apiKey: "test-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });

      const generation = await app.inject({
        method: "POST",
        url: "/api/generate",
        headers: { cookie: cookieHeader },
        payload: {
          prompt: "strict 4K tier poster",
          params: { model: "gpt-image-2", resolution: "4K", quality: "high" }
        }
      });

      expect(generation.statusCode).toBe(200);
      expect(generation.json().assets[0].params.resolutionWarning).toContain("实际 1536x1024（1K）");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
      const requestBody = JSON.parse(String(calls[0]![1].body));
      expect(requestBody).toMatchObject({
        model: "gpt-image-2",
        resolution: "4K",
        quality: "high"
      });
      expect(requestBody.size).toBe("2880x2880");

      const assets = await app.inject({
        method: "GET",
        url: "/api/assets",
        headers: { cookie: cookieHeader }
      });
      expect(assets.json()).toHaveLength(1);
      expect(assets.json()[0].params).toMatchObject({ resolution: "4K", actualResolution: "1K", resolutionWarning: expect.any(String) });
      const original = await app.inject({ url: generation.json().assets[0].imageUrl, headers: { cookie: cookieHeader } });
      expect(original.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it("saves low resolution results without retrying another paid provider", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const lowResolutionImage = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(lowResolutionImage);
    lowResolutionImage.writeUInt32BE(1448, 16);
    lowResolutionImage.writeUInt32BE(1086, 20);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: lowResolutionImage.toString("base64") }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "owner", password: "owner-test-password" }
      });
      const cookie = login.headers["set-cookie"];
      const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

      const imageProvider = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "Congee Pro",
          baseUrl: "https://congee.example/v1",
          apiKey: "test-key",
          model: "gpt-image-2",
          mode: "generations",
          maxConcurrency: 1
        }
      });
      const chatProvider = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "Fallback chat",
          baseUrl: "https://chat.example/v1",
          apiKey: "chat-key",
          model: "gpt-image-2",
          mode: "chat_completions",
          maxConcurrency: 1
        }
      });
      await app.inject({
        method: "PATCH",
        url: "/api/admin/providers/order",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          providerIds: [imageProvider.json().id, chatProvider.json().id]
        }
      });

      const generation = await app.inject({
        method: "POST",
        url: "/api/generate",
        headers: { cookie: cookieHeader },
        payload: {
          prompt: "strict 4K poster",
          params: { model: "gpt-image-2", resolution: "4K", quality: "high" }
        }
      });

      expect(generation.statusCode).toBe(200);
      expect(generation.json().assets[0].params.resolutionWarning).toContain("请求 4K，实际 1448x1086（1K）");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
      expect(calls[0]![0]).toBe("https://congee.example/v1/images/generations");
      const requestBody = JSON.parse(String(calls[0]![1].body));
      expect(requestBody).toMatchObject({
        model: "gpt-image-2",
        resolution: "4K",
        quality: "high"
      });
      expect(requestBody.size).toBe("2880x2880");

      const assets = await app.inject({
        method: "GET",
        url: "/api/assets",
        headers: { cookie: cookieHeader }
      });
      expect(assets.json()).toHaveLength(1);
      expect(assets.json()[0].params).toMatchObject({ resolution: "4K", actualResolution: "1K", resolutionWarning: expect.any(String) });
      const original = await app.inject({ url: generation.json().assets[0].imageUrl, headers: { cookie: cookieHeader } });
      expect(original.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it("exposes provider sources and forwards 4K parameters to chat fallback", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "edit provider unavailable" }
      }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "chat provider unavailable" } }), { status: 502 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "owner", password: "owner-test-password" }
      });
      const cookie = login.headers["set-cookie"];
      const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

      const editProvider = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "First edits",
          baseUrl: "https://edit-first.example",
          apiKey: "edit-key",
          model: "gpt-image-2",
          mode: "edits",
          maxConcurrency: 1
        }
      });
      const chatProvider = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          name: "Second chat",
          baseUrl: "https://chat-second.example",
          apiKey: "chat-key",
          model: "gpt-image-2",
          mode: "chat_completions",
          maxConcurrency: 1
        }
      });
      const reorder = await app.inject({
        method: "PATCH",
        url: "/api/admin/providers/order",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "image",
          providerIds: [editProvider.json().id, chatProvider.json().id]
        }
      });
      expect(reorder.statusCode).toBe(200);

      const capabilities = await app.inject({
        method: "GET",
        url: "/api/image-capabilities",
        headers: { cookie: cookieHeader }
      });
      expect(capabilities.statusCode).toBe(200);
      expect(capabilities.json()).toEqual({
        models: [
          { providerId: editProvider.json().id, providerName: "First edits", mode: "edits", model: "gpt-image-2", resolutions: ["1K"], imageCapabilities: {} },
          { providerId: chatProvider.json().id, providerName: "Second chat", mode: "chat_completions", model: "gpt-image-2", resolutions: ["1K"], imageCapabilities: {} }
        ]
      });

      const multipart = buildMultipartPayload([
        { name: "prompt", value: "preserve the knight and change the pose" },
        { name: "model", value: "gpt-image-2" },
        { name: "resolution", value: "4K" },
        { name: "quality", value: "high" },
        {
          name: "image",
          filename: "knight.png",
          contentType: "image/png",
          value: Buffer.from("route-reference")
        }
      ]);
      const generation = await app.inject({
        method: "POST",
        url: "/api/generate/edit",
        headers: { cookie: cookieHeader, ...multipart.headers },
        payload: multipart.payload
      });

      expect(generation.statusCode).toBe(502);
      expect(generation.json().error).toContain("First edits: edit provider unavailable");
      expect(generation.json().error).toContain("Second chat: chat provider unavailable");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const chatBody = JSON.parse(String((fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[1]![1].body));
      expect(chatBody).toMatchObject({ resolution: "4K", quality: "high" });
      expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://edit-first.example/v1/images/edits", expect.any(Object));
      const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
      const editForm = calls[0]![1].body as FormData;
      expect(editForm.get("resolution")).toBe("4K");
      expect(editForm.get("size")).toBe("2880x2880");
    } finally {
      await app.close();
    }
  });
  it("generates an edited image from an uploaded reference image", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const imageBytes = Buffer.from("edited-upload-result");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: imageBytes.toString("base64") }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Edit Provider",
        baseUrl: "https://newapi.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "edits",
        maxConcurrency: 1
      }
    });

    const multipart = buildMultipartPayload([
      { name: "prompt", value: "keep identity and change background" },
      { name: "size", value: "1024x1536" },
      { name: "quality", value: "medium" },
      { name: "n", value: "1" },
      {
        name: "image",
        filename: "reference.png",
        contentType: "image/png",
        value: Buffer.from("reference-upload")
      }
    ]);
    const generation = await app.inject({
      method: "POST",
      url: "/api/generate/edit",
      headers: { cookie: cookieHeader, ...multipart.headers },
      payload: multipart.payload
    });

    expect(generation.statusCode).toBe(200);
    expect(generation.json()).toMatchObject({
      provider: { name: "Edit Provider" },
      assets: [
        {
          imageUrl: expect.stringMatching(/^\/api\/assets\/.+\/original$/),
          prompt: "keep identity and change background"
        }
      ]
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://newapi.example/v1/images/edits", expect.objectContaining({
      method: "POST"
    }));
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const form = calls[0]![1].body as FormData;
    expect(form.get("prompt")).toBe("keep identity and change background");
    expect(form.get("size")).toBe("1024x1536");
    expect(form.get("quality")).toBe("medium");
    expect(form.get("n")).toBe("1");
    expect(form.get("image")).toBeInstanceOf(Blob);

    const asset = await app.inject({
      method: "GET",
      url: generation.json().assets[0].imageUrl,
      headers: { cookie: cookieHeader }
    });
    expect(asset.body).toBe("edited-upload-result");

    await app.close();
  });

  it("generates an edited image from an existing asset reference", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("source-asset").toString("base64") }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("edited-from-asset").toString("base64") }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);

    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Generation Provider",
        baseUrl: "https://gen.example",
        apiKey: "test-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });
    await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
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

    const source = await app.inject({
      method: "POST",
      url: "/api/generate",
      headers: { cookie: cookieHeader },
      payload: {
        prompt: "source portrait",
        params: {}
      }
    });
    const sourceAssetId = source.json().assets[0].id;
    const multipart = buildMultipartPayload([
      { name: "prompt", value: "reuse source asset as reference" },
      { name: "assetIds", value: sourceAssetId },
      { name: "size", value: "1024x1024" }
    ]);

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate/edit",
      headers: { cookie: cookieHeader, ...multipart.headers },
      payload: multipart.payload
    });

    expect(generation.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://edit.example/v1/images/edits", expect.any(Object));
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const form = calls[1]![1].body as FormData;
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(generation.json().assets[0].prompt).toBe("reuse source asset as reference");

    await app.close();
  });

  it("rejects image edit requests without reference images", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner",
        password: "owner-test-password"
      }
    });
    const cookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : String(cookie);
    const multipart = buildMultipartPayload([
      { name: "prompt", value: "edit without image" }
    ]);

    const generation = await app.inject({
      method: "POST",
      url: "/api/generate/edit",
      headers: { cookie: cookieHeader, ...multipart.headers },
      payload: multipart.payload
    });

    expect(generation.statusCode).toBe(400);
    expect(generation.json().error).toContain("参考图");

    await app.close();
  });
});

type MultipartPart = {
  name: string;
  value: string | Buffer;
  filename?: string;
  contentType?: string;
};

function buildMultipartPayload(parts: MultipartPart[]) {
  const boundary = `paintopia-test-${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const disposition = [
      `form-data; name="${part.name}"`,
      part.filename ? `filename="${part.filename}"` : ""
    ].filter(Boolean).join("; ");
    chunks.push(Buffer.from(`Content-Disposition: ${disposition}\r\n`));
    if (part.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    }
    chunks.push(Buffer.from("\r\n"));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    },
    payload: Buffer.concat(chunks)
  };
}
