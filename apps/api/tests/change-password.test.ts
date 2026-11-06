import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";
import type { AppDatabase } from "../src/db/database.js";
import { changeUserPassword, createLoginSession, createSession, getUserByEmail, verifyPasswordAsync } from "../src/services/authService.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-password-"));
  directories.push(dataDir);
  const app = await createServer({ dataDir, bootstrapEmail: "admin", bootstrapPassword: "current-password", inviteCode: "password-test", webOrigin: "http://localhost:5173", sessionSecret: "test-secret" });
  const db = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
  const user = (await getUserByEmail(db, "admin"))!;
  const cookie = `paintopia_session=${await createSession(db, user.id)}`;
  return { app, db, user, headers: { cookie } };
}
const valid = { currentPassword: "current-password", newPassword: "next-password" };

it("requires an active, unexpired authenticated session", async () => {
  const { app, db, user, headers } = await fixture();
  try {
    expect((await app.inject({ method: "POST", url: "/api/auth/change-password", payload: valid })).statusCode).toBe(401);
    await db.execute("UPDATE sessions SET expires_at = 1 WHERE user_id = ?", [user.id]);
    expect((await app.inject({ method: "POST", url: "/api/auth/change-password", headers, payload: valid })).statusCode).toBe(401);
    const fresh = { cookie: `paintopia_session=${await createSession(db, user.id)}` };
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    expect((await app.inject({ method: "POST", url: "/api/auth/change-password", headers: fresh, payload: valid })).statusCode).toBe(401);
    expect((await getUserByEmail(db, "admin"))?.passwordHash).toBe(user.passwordHash);
  } finally { await app.close(); }
});

it("rejects a wrong current password, invalid new passwords, reused passwords and forged targets", async () => {
  const { app, db, user, headers } = await fixture();
  try {
    const cases = [
      { ...valid, currentPassword: "wrong-password" },
      { ...valid, newPassword: "12345" },
      { ...valid, newPassword: "a".repeat(129) },
      { ...valid, newPassword: valid.currentPassword },
      { ...valid, userId: "another-user" }
    ];
    for (const payload of cases) {
      const response = await app.inject({ method: "POST", url: "/api/auth/change-password", headers, payload });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(user.passwordHash);
      expect(response.body).not.toContain("current-password");
    }
    expect((await getUserByEmail(db, "admin"))?.passwordHash).toBe(user.passwordHash);
    expect((await app.inject({ url: "/api/auth/me", headers })).statusCode).toBe(200);
    expect(await db.query("SELECT * FROM audit_logs WHERE action = 'password_change'")).toHaveLength(0);
  } finally { await app.close(); }
});

it("changes only the signed-in user, revokes all their sessions and permits only the new password", async () => {
  const { app, db, headers: adminHeaders } = await fixture();
  try {
    const signup = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "artist", password: "current-password", inviteCode: "password-test" } });
    const id = signup.json().id as string;
    const headers = { cookie: String(signup.headers["set-cookie"]).split(";")[0] };
    const otherDevice = { cookie: `paintopia_session=${await createSession(db, id)}` };
    const response = await app.inject({ method: "POST", url: "/api/auth/change-password", headers, payload: valid });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers["cache-control"]).toBe("no-store");
    const cookies = [response.headers["set-cookie"]].flat().join("\n");
    expect(cookies).toContain("paintopia_session=;");
    expect(cookies).toContain("__Host-paintopia_session=;");
    expect(cookies).toContain("Secure");
    for (const stale of [headers, otherDevice]) expect((await app.inject({ url: "/api/auth/me", headers: stale })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/auth/me", headers: adminHeaders })).statusCode).toBe(200);
    const user = (await getUserByEmail(db, "artist"))!;
    expect(user.quota).toBe(66);
    expect(user.passwordHash).not.toBe(valid.newPassword);
    expect(await verifyPasswordAsync(valid.newPassword, user.passwordHash)).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "artist", password: valid.currentPassword } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "artist", password: valid.newPassword } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).not.toHaveProperty("passwordHash");
    expect(await db.query("SELECT actor_user_id, action, target_id, detail_json FROM audit_logs WHERE action = 'password_change'"))
      .toEqual([{ actor_user_id: id, action: "password_change", target_id: id, detail_json: "{}" }]);
  } finally { await app.close(); }
});

it("limits password attempts per user before repeated bcrypt checks", async () => {
  const { app, db, user, headers } = await fixture();
  try {
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "POST", url: "/api/auth/change-password", headers, payload: { ...valid, currentPassword: "wrong" } })).statusCode).toBe(400);
    }
    const response = await app.inject({ method: "POST", url: "/api/auth/change-password", headers, payload: valid });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("900");
    expect((await getUserByEmail(db, "admin"))?.passwordHash).toBe(user.passwordHash);
  } finally { await app.close(); }
});

it("allows only one competing change and rejects login credentials verified before the change", async () => {
  const { app, db, user } = await fixture();
  try {
    const outcomes = await Promise.all(["next-password-a", "next-password-b"].map(password => changeUserPassword(db, user, valid.currentPassword, password)));
    expect(outcomes.filter(result => result === "changed")).toHaveLength(1);
    expect(outcomes.filter(result => result === "conflict")).toHaveLength(1);
    expect(await createLoginSession(db, user)).toBeUndefined();
    expect(await db.query("SELECT * FROM sessions WHERE user_id = ?", [user.id])).toHaveLength(0);
    expect(await db.query("SELECT * FROM audit_logs WHERE action = 'password_change'")).toHaveLength(1);
  } finally { await app.close(); }
});

it("revokes a concurrent login created just before the password change", async () => {
  const { app, db, user } = await fixture();
  try {
    const session = await createLoginSession(db, user);
    expect(session).toBeTruthy();
    expect(await changeUserPassword(db, user, valid.currentPassword, valid.newPassword)).toBe("changed");
    expect(await db.query("SELECT * FROM sessions WHERE user_id = ?", [user.id])).toHaveLength(0);
  } finally { await app.close(); }
});

it("rolls back the password and sessions if the audit write fails", async () => {
  const { app, db, user, headers } = await fixture();
  try {
    const original = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation(work => original(tx => work({ ...tx, execute: async (sql, params) => {
      if (sql.includes("INSERT INTO audit_logs")) throw new Error("controlled audit failure");
      return tx.execute(sql, params);
    } })));
    await expect(changeUserPassword(db, user, valid.currentPassword, valid.newPassword)).rejects.toThrow("controlled audit failure");
    const response = await app.inject({ method: "POST", url: "/api/auth/change-password", headers, payload: valid });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "密码未修改，请稍后重试" });
    expect((await getUserByEmail(db, "admin"))?.passwordHash).toBe(user.passwordHash);
    expect((await app.inject({ url: "/api/auth/me", headers })).statusCode).toBe(200);
    expect(await db.query("SELECT * FROM audit_logs WHERE action = 'password_change'")).toHaveLength(0);
  } finally { await app.close(); }
});
