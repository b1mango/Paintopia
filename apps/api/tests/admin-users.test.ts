import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";
import type { AppDatabase } from "../src/db/database";
import * as dbSchema from "../src/db/schema";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  vi.unstubAllGlobals();
});

describe("admin user routes", () => {
  it("returns generation stats for the current user and admins", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });
    const appDb = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;

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
    const now = new Date("2026-06-15T12:00:00.000Z");

    appDb.sqlite!.db.insert(dbSchema.generationJobs).values([
      {
        id: "job-success-1",
        userId,
        providerId: "provider-1",
        status: "succeeded",
        prompt: "success one",
        paramsJson: "{}",
        error: null,
        createdAt: new Date(now.getTime() - 1000),
        updatedAt: now
      },
      {
        id: "job-success-2",
        userId,
        providerId: "provider-1",
        status: "succeeded",
        prompt: "success two",
        paramsJson: "{}",
        error: null,
        createdAt: new Date(now.getTime() - 5000),
        updatedAt: now
      },
      {
        id: "job-failed",
        userId,
        providerId: "provider-1",
        status: "failed",
        prompt: "failed",
        paramsJson: "{}",
        error: "failed",
        createdAt: new Date(now.getTime() - 9000),
        updatedAt: now
      },
      {
        id: "job-running",
        userId,
        providerId: "provider-1",
        status: "running",
        prompt: "running",
        paramsJson: "{}",
        error: null,
        createdAt: now,
        updatedAt: now
      }
    ]).run();

    appDb.sqlite!.db.insert(dbSchema.providerConfigs).values({
      id: "text-provider-1",
      kind: "text",
      name: "Translation Provider",
      baseUrl: "https://text.example",
      apiKey: "test-key",
      model: "qwen",
      mode: "chat_completions",
      maxConcurrency: 1,
      enabled: true,
      createdAt: now,
      updatedAt: now
    }).run();

    appDb.sqlite!.db.insert(dbSchema.textToolRuns).values([
      {
        id: "text-success-translate",
        userId,
        providerId: "text-provider-1",
        type: "translate",
        status: "succeeded",
        promptTokens: 120,
        completionTokens: 40,
        totalTokens: 160,
        durationMs: 800,
        error: null,
        createdAt: now
      },
      {
        id: "text-success-optimize",
        userId,
        providerId: "text-provider-1",
        type: "optimize",
        status: "succeeded",
        promptTokens: 200,
        completionTokens: 90,
        totalTokens: 290,
        durationMs: 1000,
        error: null,
        createdAt: now
      },
      {
        id: "text-failed-translate",
        userId,
        providerId: null,
        type: "translate",
        status: "failed",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        durationMs: 0,
        error: "No provider",
        createdAt: now
      }
    ]).run();

    const ownStats = await app.inject({
      method: "GET",
      url: "/api/generation-stats",
      headers: { cookie: cookieHeader }
    });

    expect(ownStats.statusCode).toBe(200);
    expect(ownStats.json()).toMatchObject({
      total: 4,
      completed: 3,
      succeeded: 2,
      failed: 1,
      successRate: 66.7,
      averageDurationMs: 3000
    });

    const adminStats = await app.inject({
      method: "GET",
      url: "/api/admin/generation-stats",
      headers: { cookie: cookieHeader }
    });

    expect(adminStats.statusCode).toBe(200);
    expect(adminStats.json()).toMatchObject({
      total: 4,
      completed: 3,
      succeeded: 2,
      failed: 1,
      successRate: 66.7,
      averageDurationMs: 3000,
      textStats: {
        totalRuns: 3,
        succeeded: 2,
        failed: 1,
        successRate: 66.7,
        totalTokens: 450,
        promptTokens: 320,
        completionTokens: 130,
        byProvider: [
          expect.objectContaining({
            providerId: "text-provider-1",
            providerName: "Translation Provider",
            totalRuns: 2,
            totalTokens: 450,
            successRate: 100
          }),
          expect.objectContaining({
            providerId: null,
            providerName: "未配置接口",
            totalRuns: 1,
            failed: 1,
            successRate: 0
          })
        ]
      },
      userStats: {
        total: 1,
        active: 1,
        disabled: 0,
        admins: 1,
        regularUsers: 0
      }
    });

    await app.close();
  });

  it("lists users and updates quota for admins", async () => {
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

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/users?q=ow",
      headers: { cookie: cookieHeader }
    });

    expect(list.statusCode).toBe(200);
    const users = list.json();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      email: "owner",
      role: "admin",
      quota: 100
    });

    const update = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${users[0].id}`,
      headers: { cookie: cookieHeader },
      payload: { quota: 360 }
    });

    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      email: "owner",
      quota: 360
    });

    await app.close();
  });

  it("creates, filters, and destroys invite codes for admins", async () => {
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

    const create = await app.inject({
      method: "POST",
      url: "/api/admin/invite-codes",
      headers: { cookie: cookieHeader }
    });

    expect(create.statusCode).toBe(201);
    const invite = create.json();
    expect(invite.code).toMatch(/^PT-[A-Za-z0-9_-]{32}$/);
    expect(invite.status).toBe("active");
    expect(invite.createdByEmail).toBe("owner");

    const list = await app.inject({
      method: "GET",
      url: `/api/admin/invite-codes?q=${invite.code.slice(0, 4)}&status=active`,
      headers: { cookie: cookieHeader }
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ id: invite.id, code: invite.code, status: "active" })]);

    const destroy = await app.inject({
      method: "DELETE",
      url: `/api/admin/invite-codes/${invite.id}`,
      headers: { cookie: cookieHeader }
    });

    expect(destroy.statusCode).toBe(200);
    expect(destroy.json()).toMatchObject({ id: invite.id, status: "destroyed" });

    await app.close();
  });

  it("updates provider configuration, tests image connectivity, and edits quota pricing", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "gpt-image-2" },
            { id: "custom-image-model" }
          ]
        }), { status: 200 });
      }
      if (url.endsWith("/api/usage/token")) {
        return new Response(JSON.stringify({
          data: {
            total_granted: 1_000_000,
            total_used: 12_345,
            total_available: 987_655,
            unlimited_quota: false
          }
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
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

    const createProvider = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Old Image",
        baseUrl: "https://image.example",
        apiKey: "old-key",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 1
      }
    });
    const providerId = createProvider.json().id;

    const createProviderWithoutKey = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "text",
        name: "Draft Text Provider",
        baseUrl: "https://text.example",
        model: "draft-model",
        mode: "chat_completions"
      }
    });
    expect(createProviderWithoutKey.statusCode).toBe(201);
    expect(createProviderWithoutKey.json()).toMatchObject({
      name: "Draft Text Provider",
      apiKey: ""
    });

    const updateProvider = await app.inject({
      method: "PATCH",
      url: `/api/admin/providers/${providerId}`,
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Primary Image",
        baseUrl: "https://image.example",
        apiKey: "",
        model: "gpt-image-2",
        mode: "generations",
        maxConcurrency: 2,
        enabled: true
      }
    });

    expect(updateProvider.statusCode).toBe(200);
    expect(updateProvider.json()).toMatchObject({
      id: providerId,
      name: "Primary Image",
      apiKey: "********",
      maxConcurrency: 2
    });

    const providerQuotas = await app.inject({
      method: "GET",
      url: "/api/admin/providers/quotas",
      headers: { cookie: cookieHeader }
    });
    expect(providerQuotas.statusCode).toBe(200);
    expect(providerQuotas.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId,
        status: "available",
        remaining: 987_655,
        source: "newapi"
      })
    ]));

    const upsertDefaultTextProvider = await app.inject({
      method: "PATCH",
      url: "/api/admin/providers/gpt-5-nano",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "text",
        name: "Saved GPT-5 Nano",
        baseUrl: "https://text.example",
        apiKey: "stored-text-key",
        model: "gpt-5-nano",
        mode: "chat_completions"
      }
    });
    expect(upsertDefaultTextProvider.statusCode).toBe(201);
    expect(upsertDefaultTextProvider.json()).toMatchObject({
      id: "gpt-5-nano",
      name: "Saved GPT-5 Nano",
      apiKey: "********"
    });

    const testProvider = await app.inject({
      method: "POST",
      url: "/api/admin/providers/test",
      headers: { cookie: cookieHeader },
      payload: {
        kind: "image",
        name: "Primary Image",
        baseUrl: "https://image.example",
        apiKey: "key",
        model: "gpt-image-2",
        mode: "generations"
      }
    });

    expect(testProvider.statusCode).toBe(200);
    expect(testProvider.json()).toMatchObject({ ok: true, status: "connected" });

    const testStoredTextProvider = await app.inject({
      method: "POST",
      url: "/api/admin/providers/test",
      headers: { cookie: cookieHeader },
      payload: {
        providerId: "gpt-5-nano",
        kind: "text",
        name: "Saved GPT-5 Nano",
        baseUrl: "https://text.example",
        apiKey: "",
        model: "gpt-5-nano",
        mode: "chat_completions",
        prompt: "OK"
      }
    });
    expect(testStoredTextProvider.statusCode).toBe(200);
    expect(testStoredTextProvider.json()).toMatchObject({ ok: true, status: "connected" });

    const models = await app.inject({
      method: "POST",
      url: "/api/admin/providers/models",
      headers: { cookie: cookieHeader },
      payload: {
        baseUrl: "https://image.example",
        apiKey: "key"
      }
    });

    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({ models: ["custom-image-model", "gpt-image-2"] });
    expect(fetchImpl).toHaveBeenCalledWith("https://image.example/v1/models", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({
        Authorization: "Bearer key"
      })
    }));

    const storedTextModels = await app.inject({
      method: "POST",
      url: "/api/admin/providers/models",
      headers: { cookie: cookieHeader },
      payload: {
        providerId: "gpt-5-nano",
        baseUrl: "https://text.example/v1/chat/completions",
        apiKey: ""
      }
    });

    expect(storedTextModels.statusCode).toBe(200);
    expect(storedTextModels.json()).toEqual({ models: ["custom-image-model", "gpt-image-2"] });
    expect(fetchImpl).toHaveBeenCalledWith("https://text.example/v1/models", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({
        Authorization: "Bearer stored-text-key"
      })
    }));

    const createTemplate = await app.inject({
      method: "POST",
      url: "/api/admin/templates",
      headers: { cookie: cookieHeader },
      payload: {
        name: "Delete Me",
        type: "optimize",
        targetModel: "gpt-image-2",
        content: "Translate only."
      }
    });
    expect(createTemplate.statusCode).toBe(201);
    const templateId = createTemplate.json().id;

    const deleteTemplate = await app.inject({
      method: "DELETE",
      url: `/api/admin/templates/${templateId}`,
      headers: { cookie: cookieHeader }
    });
    expect(deleteTemplate.statusCode).toBe(204);

    const deleteProvider = await app.inject({
      method: "DELETE",
      url: `/api/admin/providers/${providerId}`,
      headers: { cookie: cookieHeader }
    });
    expect(deleteProvider.statusCode).toBe(204);

    const publicPricing = await app.inject({
      method: "GET",
      url: "/api/quota-pricing",
      headers: { cookie: cookieHeader }
    });
    expect(publicPricing.statusCode).toBe(200);
    expect(publicPricing.json()).toEqual([
      expect.objectContaining({ key: "resolution.1k.quality.low", label: "1K / low", amount: 1 }),
      expect.objectContaining({ key: "resolution.1k.quality.medium", label: "1K / medium", amount: 2 }),
      expect.objectContaining({ key: "resolution.1k.quality.high", label: "1K / high", amount: 3 }),
      expect.objectContaining({ key: "resolution.2k.quality.low", label: "2K / low", amount: 2 }),
      expect.objectContaining({ key: "resolution.2k.quality.medium", label: "2K / medium", amount: 4 }),
      expect.objectContaining({ key: "resolution.2k.quality.high", label: "2K / high", amount: 6 }),
      expect.objectContaining({ key: "resolution.4k.quality.low", label: "4K / low", amount: 4 }),
      expect.objectContaining({ key: "resolution.4k.quality.medium", label: "4K / medium", amount: 8 }),
      expect.objectContaining({ key: "resolution.4k.quality.high", label: "4K / high", amount: 12 })
    ]);
    expect(publicPricing.json().map((rule: { key: string }) => rule.key)).not.toContain("text.high.1024");

    const pricing = await app.inject({
      method: "GET",
      url: "/api/admin/quota-pricing",
      headers: { cookie: cookieHeader }
    });
    expect(pricing.statusCode).toBe(200);
    expect(pricing.json()).toHaveLength(9);

    const updatePricing = await app.inject({
      method: "PATCH",
      url: "/api/admin/quota-pricing",
      headers: { cookie: cookieHeader },
      payload: {
        rules: [{ key: "resolution.4k.quality.high", amount: 10 }]
      }
    });

    expect(updatePricing.statusCode).toBe(200);
    expect(updatePricing.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "resolution.4k.quality.high", amount: 10 })
    ]));

    await app.close();
  });

  it("persists provider order for admin provider lists", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);

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

      const first = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "text",
          name: "First Text",
          baseUrl: "https://first.example",
          apiKey: "first-key",
          model: "first-model",
          mode: "chat_completions"
        }
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "text",
          name: "Second Text",
          baseUrl: "https://second.example",
          apiKey: "second-key",
          model: "second-model",
          mode: "chat_completions"
        }
      });

      const reorder = await app.inject({
        method: "PATCH",
        url: "/api/admin/providers/order",
        headers: { cookie: cookieHeader },
        payload: {
          kind: "text",
          providerIds: [second.json().id, first.json().id]
        }
      });

      expect(reorder.statusCode).toBe(200);
      expect(reorder.json().map((provider: { id: string }) => provider.id)).toEqual([
        second.json().id,
        first.json().id
      ]);

      const list = await app.inject({
        method: "GET",
        url: "/api/admin/providers",
        headers: { cookie: cookieHeader }
      });

      expect(list.statusCode).toBe(200);
      expect(list.json().filter((provider: { kind: string }) => provider.kind === "text").map((provider: { id: string }) => provider.id)).toEqual([
        second.json().id,
        first.json().id
      ]);
    } finally {
      await app.close();
    }
  });

});
