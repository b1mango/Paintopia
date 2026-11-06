import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/createServer.js";
import type { AppDatabase } from "../src/db/database.js";
import * as repo from "../src/db/repository.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("public deployment safeguards", () => {
  it("blocks obfuscated prohibited terms before a provider is called", async () => {
    const { app, cookie } = await createAuthenticatedApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/generate",
        headers: { cookie },
        payload: {
          prompt: "儿 童---色 情内容",
          params: {}
        }
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toContain("不允许");
      const appDb = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
      expect(await appDb.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM generation_jobs"))
        .toMatchObject({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it("enforces the combined 16-image edit limit", async () => {
    const { app, cookie } = await createAuthenticatedApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/generate/edit",
        headers: { cookie },
        payload: {
          prompt: "combine references",
          params: {},
          assetIds: Array.from({ length: 8 }, (_value, index) => "asset-" + index),
          transientAssetIds: Array.from({ length: 9 }, (_value, index) => "upload-" + index)
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("参考图最多 16 张");

      const boundaryResponse = await app.inject({
        method: "POST",
        url: "/api/generate/edit",
        headers: { cookie },
        payload: {
          prompt: "combine references",
          params: {},
          assetIds: Array.from({ length: 16 }, (_value, index) => "missing-" + index),
          transientAssetIds: []
        }
      });
      expect(boundaryResponse.statusCode).toBe(404);
      expect(boundaryResponse.json().error).toBe("参考资产不存在");
    } finally {
      await app.close();
    }
  });

  it("uses an atomic persisted rate-limit counter", async () => {
    const { app } = await createAuthenticatedApp();
    try {
      const appDb = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
      expect(await repo.consumeRateLimit(appDb, "test:user", 2, 60_000)).toBe(true);
      expect(await repo.consumeRateLimit(appDb, "test:user", 2, 60_000)).toBe(true);
      expect(await repo.consumeRateLimit(appDb, "test:user", 2, 60_000)).toBe(false);
    } finally {
      await app.close();
    }
  });
});

async function createAuthenticatedApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-security-"));
  tempDirs.push(dataDir);
  const app = await createServer({
    dataDir,
    bootstrapEmail: "admin@paintopia.local",
    bootstrapPassword: "paintopia123",
    webOrigin: "http://localhost:5173",
    sessionSecret: "test-secret"
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
