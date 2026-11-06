import { type FastifyReply, type FastifyRequest } from "fastify";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";
import {
  getUserBySession,
  type UserRecord
} from "../services/authService.js";

export type AuthedRequest = FastifyRequest & {
  user: UserRecord;
};


export function requireAuth(appDb: AppDatabase) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = readSessionCookie(request);
    if (!sessionId) {
      return reply.code(401).send({ error: "未登录" });
    }
    const user = await getUserBySession(appDb, sessionId);
    if (!user || user.status !== "active") {
      return reply.code(401).send({ error: "登录已失效" });
    }
    (request as AuthedRequest).user = user;
  };
}

export function requireAdmin(appDb: AppDatabase) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(appDb)(request, reply);
    const user = (request as AuthedRequest).user;
    if (!user) {
      return;
    }
    if (user.role !== "admin") {
      return reply.code(403).send({ error: "需要管理员权限" });
    }
  };
}

export async function allowUserAction(
  appDb: AppDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  rule: { limit: number; windowMs: number }
) {
  const user = (request as AuthedRequest).user;
  const allowed = await repo.consumeRateLimit(
    appDb,
    scope + ":user:" + user.id,
    rule.limit,
    rule.windowMs
  );
  if (allowed) return true;
  reply
    .header("Retry-After", String(Math.ceil(rule.windowMs / 1000)))
    .code(429)
    .send({ error: "操作过于频繁，请稍后再试" });
  return false;
}

export function readSessionCookie(request: FastifyRequest) {
  return request.cookies["__Host-paintopia_session"] ?? request.cookies.paintopia_session;
}

export function sessionCookieName(production?: boolean) {
  return production ? "__Host-paintopia_session" : "paintopia_session";
}
