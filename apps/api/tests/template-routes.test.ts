import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/db/database.js";
import { createSession } from "../src/services/authService.js";
import { createServer } from "../src/createServer.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("admin template routes", () => {
  it("stores and lists prompt templates", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
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
    const cookie = login.headers["set-cookie"];

    const create = await app.inject({
      method: "POST",
      url: "/api/admin/templates",
      headers: {
        cookie: Array.isArray(cookie) ? cookie[0] : String(cookie)
      },
      payload: {
        name: "GPT Image optimizer",
        type: "optimize",
        targetModel: "gpt-image-2",
        content: "Optimize {{input_prompt}} for {{target_image_model}}"
      }
    });

    expect(create.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/templates",
      headers: {
        cookie: Array.isArray(cookie) ? cookie[0] : String(cookie)
      }
    });

    expect(list.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "GPT Image optimizer",
        type: "optimize",
        targetModel: "gpt-image-2"
      })
    ]));
    expect(list.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "optimize", name: "通用优化" })
    ]));

    const update = await app.inject({
      method: "PATCH",
      url: "/api/admin/templates/optimize",
      headers: {
        cookie: Array.isArray(cookie) ? cookie[0] : String(cookie)
      },
      payload: {
        name: "Updated optimizer",
        type: "optimize",
        targetModel: "gpt-image-2",
        content: "Updated content"
      }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ id: "optimize", name: "Updated optimizer", content: "Updated content" });
    const headers = { cookie: Array.isArray(cookie) ? cookie[0] : String(cookie) };
    const templates = list.json();
    expect(templates[0]).toMatchObject({ id: "optimize", isDefault: true });
    expect(templates.every((item: { type: string; isDefault: unknown }) => item.type === "optimize" && typeof item.isDefault === "boolean")).toBe(true);
    const blocked = await app.inject({ method: "DELETE", url: "/api/admin/templates/optimize", headers });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "请先把其他模板设为默认，再删除这份" });
    const created = await app.inject({ method: "POST", url: "/api/admin/templates", headers, payload: { name: "Minimal", content: "Custom" } });
    expect(created.json()).toMatchObject({ type: "optimize", targetModel: "general", isDefault: false });
    const id = created.json().id;
    const switched = await app.inject({ method: "POST", url: `/api/admin/templates/${id}/default`, headers });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()[0]).toMatchObject({ id, isDefault: true });
    expect(switched.json().filter((item: { isDefault: boolean }) => item.isDefault)).toHaveLength(1);
    expect((await app.inject({ url: "/api/admin/templates", headers })).json()).toEqual(switched.json());
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/templates/${id}`, headers, payload: { name: "Changed", content: "Changed" } });
    expect(patched.json()).toMatchObject({ type: "optimize", targetModel: "general", isDefault: true });
    for (const method of ["POST", "PATCH"] as const) {
      expect((await app.inject({ method, url: `/api/admin/templates${method === "PATCH" ? `/${id}` : ""}`, headers,
        payload: { name: "Invalid", content: "Unused", type: "translate" } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/api/admin/templates/missing/default", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/admin/templates/optimize", headers })).statusCode).toBe(204);
    const concurrent = await Promise.all([id, "optimize-portrait"].map(target => app.inject({ method: "POST", url: `/api/admin/templates/${target}/default`, headers })));
    expect(concurrent.map(response => response.statusCode)).toEqual([200, 200]);
    const db = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
    expect(await db.query("SELECT id FROM prompt_templates WHERE is_default = 1")).toHaveLength(1);
    await db.execute("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) VALUES ('reader','reader','unused','user','active',100,1,1)");
    const userHeaders = { cookie: `paintopia_session=${await createSession(db, "reader")}` };
    expect((await app.inject({ method: "POST", url: `/api/admin/templates/${id}/default`, headers: userHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/admin/templates", headers: userHeaders })).statusCode).toBe(403);
    await app.close();
  });
});
