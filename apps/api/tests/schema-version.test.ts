import { EXTERNAL_PROMPT_SOURCES } from "../src/services/promptSources.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createAppDatabase, SCHEMA_VERSION, type AppDatabase } from "../src/db/database.js";
import { createServer } from "../src/createServer.js";
import * as migrations from "../src/db/migrate.js";
import { createSession, getUserBySession } from "../src/services/authService.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function options() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "schema-version-"));
  dirs.push(dataDir);
  return { dataDir, bootstrapEmail: "admin", bootstrapPassword: "test-password", webOrigin: "http://localhost", sessionSecret: "test", inviteCode: "first-invite" };
}

it("initializes fresh databases and skips every initialization query on matching server versions", async () => {
  const config = await options();
  const migrate = vi.spyOn(migrations, "migrate");
  const first = await createServer(config);
  const db = (first as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
  expect(migrate).toHaveBeenCalledTimes(1);
  expect(await db.queryOne("SELECT value FROM schema_meta WHERE key = 'schema_version'")).toEqual({ value: SCHEMA_VERSION });
  expect(await db.query("SELECT * FROM prompt_source_cache")).toHaveLength(EXTERNAL_PROMPT_SOURCES.length);
  expect((await db.query("SELECT * FROM prompt_templates")).length).toBeGreaterThan(0);
  const ownerId = db.startupMetadata.owner_user_id;
  await first.close();
  const prepare = vi.spyOn(Database.prototype, "prepare");
  const second = await createServer({ ...config, inviteCode: "new-invite" });
  try {
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls.map(call => call[0])).toEqual(["SELECT key, value FROM schema_meta"]);
    expect((second as unknown as { paintopiaDb: AppDatabase }).paintopiaDb.startupMetadata.owner_user_id).toBe(ownerId);
  } finally { await second.close(); }
});

it("upgrades unversioned and older databases, rerunning source tables and all server seeds", async () => {
  const config = await options();
  const first = await createAppDatabase(config);
  await first.execute("DROP TABLE schema_meta");
  await first.execute("DROP TABLE prompt_source_cache");
  await first.execute("DROP TABLE sourced_prompt_favorites");
  await first.close();
  const migrate = vi.spyOn(migrations, "migrate");
  const upgraded = await createServer(config);
  const db = (upgraded as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
  expect(await db.query("SELECT * FROM users")).toHaveLength(1);
  expect(await db.query("SELECT * FROM prompt_source_cache")).toHaveLength(EXTERNAL_PROMPT_SOURCES.length);
  expect(await db.query("SELECT * FROM invite_codes")).toHaveLength(1);
  await db.execute("UPDATE schema_meta SET value = 'old' WHERE key = 'schema_version'");
  await db.execute("DELETE FROM prompt_templates");
  await upgraded.close();
  const restarted = await createServer(config);
  try {
    expect(migrate).toHaveBeenCalledTimes(2);
    expect((await (restarted as unknown as { paintopiaDb: AppDatabase }).paintopiaDb.query("SELECT * FROM prompt_templates")).length).toBeGreaterThan(0);
  } finally { await restarted.close(); }
});

it("writes the version only after successful initialization and retries failed seeds", async () => {
  const config = await options();
  const initialize = vi.fn().mockRejectedValueOnce(new Error("seed failed")).mockResolvedValue({ owner_user_id: "owner" });
  await expect(createAppDatabase({ ...config, initialize })).rejects.toThrow("seed failed");
  const raw = new Database(path.join(config.dataDir, "paintopia.sqlite"));
  expect(raw.prepare("SELECT * FROM schema_meta WHERE key = 'schema_version'").get()).toBeUndefined();
  raw.close();
  const db = await createAppDatabase({ ...config, initialize });
  try {
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(db.startupMetadata).toMatchObject({ schema_version: SCHEMA_VERSION, owner_user_id: "owner" });
  } finally { await db.close(); }
});

it("resolves only unexpired sessions with a single join query", async () => {
  const db = await createAppDatabase(await options());
  try {
    const user = (await db.query<{ id: string }>("SELECT id FROM users"))[0];
    const id = await createSession(db, user.id);
    const query = vi.spyOn(db, "queryOne");
    const execute = vi.spyOn(db, "execute");
    expect((await getUserBySession(db, id))?.id).toBe(user.id);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("JOIN users");
    await db.execute("UPDATE sessions SET expires_at = 1 WHERE id = ?", [id]);
    execute.mockClear(); query.mockClear();
    expect(await getUserBySession(db, id)).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  } finally { await db.close(); }
});
