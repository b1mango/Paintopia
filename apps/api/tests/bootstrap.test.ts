import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppDatabase } from "../src/db/database";
import { getUserByEmail, verifyPassword } from "../src/services/authService";
import { createServer } from "../src/createServer.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("bootstrap admin", () => {
  it("creates one active admin from bootstrap credentials", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);

    const appDb = await createAppDatabase({
      dataDir,
      bootstrapEmail: "admin@paintopia.local",
      bootstrapPassword: "paintopia123"
    });

    const admin = await getUserByEmail(appDb, "admin@paintopia.local");
    expect(admin?.role).toBe("admin");
    expect(admin?.status).toBe("active");
    expect(admin && verifyPassword("paintopia123", admin.passwordHash)).toBe(true);

    await appDb.bootstrap();
    const allUsers = appDb.sqlite!.db.select().from(appDb.schema.users).all();
    expect(allUsers).toHaveLength(1);
    await appDb.close();
  });

  it("does not recreate a removed legacy bootstrap account when users already exist", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);

    const appDb = await createAppDatabase({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password"
    });
    await appDb.close();

    const reopened = await createAppDatabase({
      dataDir,
      bootstrapEmail: "admin@paintopia.local",
      bootstrapPassword: "paintopia123"
    });

    expect((await getUserByEmail(reopened, "owner"))?.role).toBe("admin");
    expect(await getUserByEmail(reopened, "admin@paintopia.local")).toBeUndefined();
    await reopened.close();
  });

  it("accepts username-style accounts during login", async () => {
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

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      email: "owner",
      role: "admin"
    });
    await app.close();
  });

  it("registers local users only with a valid invite code", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
    tempDirs.push(dataDir);

    const app = await createServer({
      dataDir,
      bootstrapEmail: "owner",
      bootstrapPassword: "owner-test-password",
      inviteCode: "invite-ok",
      webOrigin: "http://localhost:5173",
      sessionSecret: "test-secret"
    });

    const denied = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "new-user",
        password: "123456",
        inviteCode: "wrong"
      }
    });

    expect(denied.statusCode).toBe(403);

    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "new-user",
        password: "123456",
        inviteCode: "invite-ok"
      }
    });

    expect(registered.statusCode).toBe(200);
    expect(registered.headers["set-cookie"]).toBeTruthy();
    expect(registered.json()).toMatchObject({
      email: "new-user",
      role: "user",
      quota: 66
    });

    await app.close();
  });
});
