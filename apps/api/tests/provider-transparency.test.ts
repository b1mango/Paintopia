import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-transparency-")); dirs.push(dataDir);
  const app = await createServer({ dataDir, bootstrapEmail: "admin", bootstrapPassword: "test-password", webOrigin: "http://localhost:5173", sessionSecret: "test-secret" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin", password: "test-password" } });
  const headers = { cookie: String(login.headers["set-cookie"]) };
  const create = async (name: string, model: string) => (await app.inject({ method: "POST", url: "/api/admin/providers", headers, payload: { kind: "image", name, baseUrl: "https://upstream.example", apiKey: "private-key", model, mode: "generations", maxConcurrency: 1 } })).json();
  return { app, headers, create, dataDir };
}

it("preserves exact source/model selection, snapshots history and excludes other users and disabled providers", async () => {
  const { app, headers, create, dataDir } = await setup();
  try {
    const first = await create("First", "gpt-image-2.5-flare-c,gpt-image-2.5-1k");
    const second = await create("Second", "gpt-image-2.5-flare-c");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("image").toString("base64") }] })));
    vi.stubGlobal("fetch", fetcher);
    const capabilities = (await app.inject({ url: "/api/image-capabilities", headers })).json().models;
    expect(capabilities).toHaveLength(3);
    expect(capabilities).toContainEqual(expect.objectContaining({ providerId: first.id, providerName: "First", model: "gpt-image-2.5-1k" }));
    const response = await app.inject({ method: "POST", url: "/api/generate", headers, payload: { providerId: second.id, prompt: "test", params: { model: "gpt-image-2.5-flare-c", quality: "low", resolution: "1K" } } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].body))).toMatchObject({ model: "gpt-image-2.5-flare-c", quality: "low", resolution: "1K" });
    const db = new Database(path.join(dataDir, "paintopia.sqlite"));
    db.prepare("UPDATE provider_configs SET name = 'Renamed', model = 'other', enabled = 0 WHERE id = ?").run(second.id);
    // A job owned by another user must never be returned by the history endpoint.
    const other = db.prepare("SELECT id FROM users WHERE email = 'admin'").get() as {id: string};
    db.prepare("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) SELECT 'other-user','other',password_hash,role,status,quota,created_at,updated_at FROM users WHERE id = ?").run(other.id);
    db.prepare("INSERT INTO generation_jobs(id,user_id,status,prompt,params_json,created_at,updated_at) VALUES ('private-job','other-user','failed','secret','{}',1,1)").run();
    db.close();
    const history = (await app.inject({ url: "/api/generation-history?user=admin", headers })).json().items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ providerId: second.id, providerName: "Second", model: "gpt-image-2.5-flare-c", status: "succeeded", attempts: [expect.objectContaining({ model: "gpt-image-2.5-flare-c", providerName: "Second", startedAt: expect.any(String) })] });
    expect(JSON.stringify(history)).not.toContain("private-key");
    const disabled = await app.inject({ method: "POST", url: "/api/generate", headers, payload: { providerId: second.id, prompt: "test", params: {} } });
    expect(disabled.statusCode).toBe(503);
    const absent = await app.inject({ method: "POST", url: "/api/generate", headers, payload: { providerId: first.id, prompt: "test", params: { model: "gpt-image-2.5" } } });
    expect(absent.statusCode).toBe(503);
    const mismatch = await app.inject({ method: "POST", url: "/api/generate", headers, payload: { providerId: first.id, prompt: "test", params: { model: "gpt-image-2.5-1k", resolution: "2K" } } });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toContain("请将分辨率设为 1K");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});

it("distinguishes token unlimited from account balance and never turns null counters into zero", async () => {
  const { app, headers, create } = await setup();
  try {
    await create("Quota", "gpt-image-2.5");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("usage/token") ? { data: { unlimited_quota: true, remaining: null } } : { total_available: 12.5, total_used: null }), { status: 200 })));
    let quota = (await app.inject({ url: "/api/admin/providers/quotas", headers })).json()[0];
    expect(quota).toMatchObject({ status: "available", remaining: 12.5, used: null, scope: "account", unit: "USD", tokenUnlimited: true });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("usage/token") ? { data: { unlimited_quota: true } } : {}), { status: url.includes("usage/token") ? 200 : 404 })));
    quota = (await app.inject({ url: "/api/admin/providers/quotas", headers })).json()[0];
    expect(quota).toMatchObject({ status: "unlimited", remaining: null, scope: "token", tokenUnlimited: true, unit: "quota" });
  } finally { await app.close(); }
});

it("paginates newest history with five filters, admin visibility and actual local ledger costs", async () => {
  const { app, headers, dataDir } = await setup();
  try {
    const db = new Database(path.join(dataDir, "paintopia.sqlite"));
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin'").get() as { id: string };
    db.prepare("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) SELECT 'member','member@example.com',password_hash,'user',status,quota,created_at,updated_at FROM users WHERE id = ?").run(admin.id);
    const insert = db.prepare("INSERT INTO generation_jobs(id,user_id,provider_id,status,prompt,params_json,created_at,updated_at) VALUES (?, ?, NULL, ?, 'test', ?, ?, ?)");
    const base = Date.parse("2026-10-01T00:00:00Z");
    for (let index = 0; index < 25; index++) {
      insert.run(`job-${String(index).padStart(2, "0")}`, index % 2 ? "member" : admin.id,
        index % 3 ? "succeeded" : "failed", JSON.stringify({ model: index % 2 ? "flare-c" : "sunburst", providerName: index % 2 ? "Source One" : "Source Two" }), base + index * 1000, base + index * 1000 + 100);
    }
    // Only ledger debits count: price settings and request params must not be used as cost estimates.
    db.prepare("INSERT INTO usage_ledger(id,user_id,action,amount,note,created_at) VALUES ('charged',?,'image_generation',-7,?,?)").run(admin.id, JSON.stringify({ jobId: "job-22" }), base);
    db.prepare("INSERT INTO usage_ledger(id,user_id,action,amount,note,created_at) VALUES ('unrelated',?,'other_action',-999,?,?)").run(admin.id, JSON.stringify({ jobId: "job-22" }), base);
    db.close();
    const get = async (query = "", auth = headers, url = "/api/admin/generation-history") => app.inject({ url: `${url}${query}`, headers: auth });
    const mine = (query = "", auth = headers) => get(query, auth, "/api/generation-history");
    const first = (await get()).json();
    expect(first).toMatchObject({ total: 25, page: 1, pageSize: 20 });
    expect(first.items[0].id).toBe("job-24");
    expect(first.items.find((item: {id: string}) => item.id === "job-22").quotaCost).toBe(7);
    expect(first.items[0].quotaCost).toBe(0);
    const second = (await get("?page=2&pageSize=20")).json();
    expect(second.items).toHaveLength(5);
    expect(second.items[0].id).toBe("job-04");
    const filtered = (await get("?user=MEMBER%40example&model=FLARE&provider=source%20one&status=succeeded&from=2026-10-01T00%3A00%3A05Z&to=2026-10-01T00%3A00%3A11Z")).json();
    expect(filtered.items.map((item: {id: string}) => item.id)).toEqual(["job-11", "job-07", "job-05"]);
    expect(filtered.total).toBe(3);
    expect(filtered.summary).toMatchObject({total:3,succeeded:3,failed:0,successRate:1});
    expect(first.summary.total).toBe(25);
    expect(first.options.models).toEqual(expect.arrayContaining(["flare-c","sunburst"]));
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "member@example.com", password: "test-password" } });
    const memberHeaders = { cookie: String(login.headers["set-cookie"]) };
    const own = (await mine("", memberHeaders)).json();
    expect(own.total).toBe(12);
    expect(own.items.every((item: {userId: string}) => item.userId === "member")).toBe(true);
    expect((await mine("?user=admin", memberHeaders)).json().total).toBe(0);
    expect((await get("", memberHeaders)).statusCode).toBe(403);
    // 管理员的使用日志同样只含本人记录；全站记录只在后台统计接口里。
    const adminOwn = (await mine()).json();
    expect(adminOwn.total).toBe(13);
    expect(adminOwn.items.every((item: {userId: string}) => item.userId === admin.id)).toBe(true);
    expect((await mine("?user=member")).json().total).toBe(0);
    expect((await get("?pageSize=101")).statusCode).toBe(400);
    expect((await get("?from=2026-10-02T00%3A00%3A00Z&to=2026-10-01T00%3A00%3A00Z")).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/generation-history" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/admin/generation-history" })).statusCode).toBe(401);
  } finally { await app.close(); }
});

it('filters actual attempts, treats SQL wildcard text literally and tolerates legacy invalid JSON', async () => {
  const { app, headers, dataDir } = await setup();
  try {
    const db = new Database(path.join(dataDir, 'paintopia.sqlite'));
    const user = db.prepare("SELECT id FROM users WHERE email = 'admin'").get() as {id:string};
    const insert = db.prepare("INSERT INTO generation_jobs(id,user_id,provider_id,status,prompt,params_json,created_at,updated_at) VALUES (?,?,'winner','succeeded','test',?,1,101)");
    insert.run('actual', user.id, JSON.stringify({model:'requested', providerName:'requested', __paintopiaRuntime:{imageGeneration:{attempts:[{providerId:'winner',model:'real_%',providerName:'Actual'}, {providerId:'other',model:'other'}]}}}));
    insert.run('bad-json', user.id, 'invalid');
    db.prepare("INSERT INTO usage_ledger(id,user_id,action,amount,note,created_at) VALUES ('bad-ledger',?,'image_generation',-999,'invalid',1)").run(user.id);
    db.close();
    const filtered = await app.inject({url:'/api/generation-history?model=%25&provider=actual',headers});
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({total:1,summary:{averageDurationMs:100},items:[{id:'actual',model:'real_%',quotaCost:0}]});
    const page = await app.inject({url:'/api/generation-history?page=10&pageSize=1',headers});
    expect(page.json()).toMatchObject({total:2,items:[],summary:{total:2}});
    expect((await app.inject({url:'/api/internal/refresh-prompt-sources'})).statusCode).toBe(401);
  } finally { await app.close(); }
});
