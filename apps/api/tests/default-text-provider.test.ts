import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/createServer.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("default text provider bootstrap", () => {
  it("creates a text provider from startup config", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "admin@paintopia.local",
      bootstrapPassword: "paintopia123",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret",
      defaultTextProvider: {
        name: "Test Text Provider",
        baseUrl: "https://translate-api.example/v1",
        apiKey: "test-key",
        model: "test-model",
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
    const cookie = login.headers["set-cookie"];

    const providers = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      headers: {
        cookie: Array.isArray(cookie) ? cookie[0] : String(cookie)
      }
    });

    expect(providers.json()).toMatchObject([
      {
        kind: "text",
        name: "Test Text Provider",
        baseUrl: "https://translate-api.example/v1",
        model: "test-model",
        mode: "chat_completions",
        apiKey: "********"
      }
    ]);
    await app.close();
  });
});
