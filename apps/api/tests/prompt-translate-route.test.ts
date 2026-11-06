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

async function createLoggedInApp(fetchText: string | string[]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
  tempDirs.push(dataDir);

  const responses = Array.isArray(fetchText) ? [...fetchText] : [fetchText];
  const fetchMock = vi.fn(async () => {
    const content = responses.shift() ?? responses[responses.length - 1] ?? "";
    return new Response(JSON.stringify({
    choices: [
      {
        message: {
          content
        }
      }
    ]
  }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const app = await createServer({
    dataDir,
    bootstrapEmail: "admin@paintopia.local",
    bootstrapPassword: "paintopia123",
    webOrigin: "http://localhost:5173",
    sessionSecret: "test-secret",
    defaultTextProvider: {
      name: "Translation",
      baseUrl: "https://new-api.example",
      apiKey: "test-key",
      model: "Translation",
      mode: "chat_completions"
    }
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "admin@paintopia.local",
      password: "paintopia123"
    }
  });

  return {
    app,
    cookie: Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : String(login.headers["set-cookie"]),
    fetchMock
  };
}

describe("prompt translation route", () => {
  it("returns 404 for the removed translation route", async () => {
    const { app, cookie, fetchMock } = await createLoggedInApp("Unused");
    try {
      const response = await app.inject({ method: "POST", url: "/api/prompt-tools/translate", headers: { cookie }, payload: { inputPrompt: "测试" } });
      expect(response.statusCode).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("falls back to the next enabled text provider when the preferred provider fails", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "preferred unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "fallback provider result" } }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "admin@paintopia.local",
      bootstrapPassword: "paintopia123",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret",
      defaultTextProvider: {
        name: "GPT-5 Nano",
        baseUrl: "https://text-gateway.example",
        apiKey: "test-key",
        model: "gpt-5-nano",
        mode: "chat_completions"
      }
    });
    const appDb = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
    const now = new Date();
    appDb.sqlite!.db.insert(dbSchema.providerConfigs).values({
      id: "linuxdo-text-provider",
      kind: "text",
      name: "LinuxDo Translation",
      baseUrl: "https://api.xn-vrvr26c72pz7b.cyou/v1/chat/completions",
      apiKey: "test-key",
      model: "Translation",
      mode: "chat_completions",
      maxConcurrency: 1,
      enabled: true,
      createdAt: now,
      updatedAt: now
    }).run();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "admin@paintopia.local",
        password: "paintopia123"
      }
    });
    const cookie = Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : String(login.headers["set-cookie"]);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/prompt-tools/optimize",
        headers: { cookie },
        payload: {
          inputPrompt: "fallback test",
          targetModel: "general"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().text).toBe("fallback provider result");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(1, "https://text-gateway.example/v1/chat/completions", expect.any(Object));
      expect(fetchMock).toHaveBeenNthCalledWith(2, "https://api.xn-vrvr26c72pz7b.cyou/v1/chat/completions", expect.any(Object));
    } finally {
      await app.close();
    }
  });
});
