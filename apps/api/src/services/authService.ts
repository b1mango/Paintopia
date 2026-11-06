import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import type { AppDatabase, DatabaseExecutor } from "../db/database.js";
import { writeAuditLog } from "../db/repository.js";

export type UserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  quota: number;
  createdAt: Date;
  updatedAt: Date;
};

type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  quota: number;
  createdAt: number | string;
  updatedAt: number | string;
};

const userColumns = `
  id,
  email,
  password_hash AS "passwordHash",
  role,
  status,
  quota,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export async function hashPasswordAsync(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  return bcrypt.compareSync(password, passwordHash);
}

export async function verifyPasswordAsync(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export async function getUserByEmail(
  db: DatabaseExecutor,
  email: string
): Promise<UserRecord | undefined> {
  const row = await db.queryOne<UserRow>(
    `SELECT ${userColumns} FROM users WHERE email = ?`,
    [email.toLowerCase()]
  );
  return row ? normalizeUser(row) : undefined;
}

export async function getUserById(
  db: DatabaseExecutor,
  userId: string
): Promise<UserRecord | undefined> {
  const row = await db.queryOne<UserRow>(
    `SELECT ${userColumns} FROM users WHERE id = ?`,
    [userId]
  );
  return row ? normalizeUser(row) : undefined;
}

export async function getUserBySession(
  db: DatabaseExecutor,
  sessionId: string
): Promise<UserRecord | undefined> {
  const row = await db.queryOne<UserRow>(
    `SELECT u.id, u.email, u.password_hash AS "passwordHash", u.role, u.status, u.quota,
      u.created_at AS "createdAt", u.updated_at AS "updatedAt"
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
    [sessionId, Date.now()]
  );
  return row ? normalizeUser(row) : undefined;
}

export async function bootstrapAdmin(
  db: AppDatabase,
  email: string,
  password: string
): Promise<void> {
  const row = await db.queryOne<{ count: number | string }>("SELECT COUNT(*) AS count FROM users");
  if (Number(row?.count ?? 0) > 0) {
    return;
  }

  const normalizedEmail = email.toLowerCase();
  const now = new Date();
  const userId = nanoid();
  await db.execute(
    `INSERT INTO users (
      id, email, password_hash, role, status, quota, created_at, updated_at
    ) VALUES (?, ?, ?, 'admin', 'active', 100, ?, ?)
    ON CONFLICT(email) DO NOTHING`,
    [userId, normalizedEmail, hashPassword(password), now, now]
  );
  const admin = await getUserByEmail(db, normalizedEmail);
  if (!admin) throw new Error("Failed to bootstrap admin");
  await db.execute(
    `INSERT INTO user_preferences (
      user_id, theme, language, reduce_motion, default_image_model, default_size, updated_at
    ) VALUES (?, 'dark', 'zh', 0, 'gpt-image-2', '1024x1024', ?)
    ON CONFLICT(user_id) DO NOTHING`,
    [admin.id, now]
  );
}

export async function createSession(db: DatabaseExecutor, userId: string): Promise<string> {
  const sessionId = nanoid(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14);
  await db.execute(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    [sessionId, userId, expiresAt, now]
  );
  return sessionId;
}

export async function createLoginSession(db: AppDatabase, user: UserRecord): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    // Lock the same row as password changes, and reject credentials verified before a change.
    const matched = await tx.execute(
      "UPDATE users SET updated_at = updated_at WHERE id = ? AND password_hash = ? AND status = 'active'",
      [user.id, user.passwordHash]
    );
    return matched === 1 ? createSession(tx, user.id) : undefined;
  });
}

export async function changeUserPassword(db: AppDatabase, user: UserRecord, currentPassword: string, newPassword: string) {
  if (!await verifyPasswordAsync(currentPassword, user.passwordHash)) return "incorrect_password" as const;
  if (await verifyPasswordAsync(newPassword, user.passwordHash)) return "same_password" as const;
  const nextHash = await hashPasswordAsync(newPassword);
  return db.transaction(async (tx) => {
    const changed = await tx.execute(
      "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash = ? AND status = 'active'",
      [nextHash, new Date(), user.id, user.passwordHash]
    );
    if (changed !== 1) return "conflict" as const;
    await tx.execute("DELETE FROM sessions WHERE user_id = ?", [user.id]);
    await writeAuditLog(tx, { actorUserId: user.id, action: "password_change", targetType: "user", targetId: user.id });
    return "changed" as const;
  });
}

export async function deleteSession(db: DatabaseExecutor, sessionId: string): Promise<void> {
  await db.execute("DELETE FROM sessions WHERE id = ?", [sessionId]);
}

export async function deleteExpiredSessions(db: DatabaseExecutor): Promise<number> {
  return db.execute("DELETE FROM sessions WHERE expires_at <= ?", [new Date()]);
}

function normalizeUser(row: UserRow): UserRecord {
  return {
    ...row,
    quota: Number(row.quota),
    createdAt: new Date(Number(row.createdAt)),
    updatedAt: new Date(Number(row.updatedAt))
  };
}
