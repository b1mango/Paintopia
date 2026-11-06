import { INITIAL_USER_QUOTA } from "@paintopia/shared";
import { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import * as repo from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import {
  changeUserPassword,
  createLoginSession,
  deleteSession,
  getUserByEmail,
  hashPasswordAsync,
  verifyPasswordAsync
} from "../services/authService.js";
import { serializeUser } from "../services/users.js";
import { allowUserAction, AuthedRequest, readSessionCookie, sessionCookieName } from "./authHelpers.js";
import { loginSchema, registerSchema } from "./schemas.js";

export function registerAuthRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb, config: options } = ctx;
  app.post("/api/auth/login", async (request, reply) => {
    if (!await repo.consumeRateLimit(appDb, `login:${request.ip}`, 10, 15 * 60 * 1000)) {
      return reply.code(429).send({ error: "登录尝试过于频繁，请稍后再试" });
    }
    const body = loginSchema.parse(request.body);
    const user = await getUserByEmail(appDb, body.email);
    if (!user || user.status !== "active" || !await verifyPasswordAsync(body.password, user.passwordHash)) {
      return reply.code(401).send({ error: "账号或密码不正确" });
    }

    const sessionId = await createLoginSession(appDb, user);
    if (!sessionId) return reply.code(401).send({ error: "账号或密码不正确" });
    reply.setCookie(sessionCookieName(options.production), sessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: Boolean(options.production),
      maxAge: 60 * 60 * 24 * 14
    });
    return serializeUser(user);
  });

  app.post("/api/auth/register", async (request, reply) => {
    if (!await repo.consumeRateLimit(appDb, `register:${request.ip}`, 5, 60 * 60 * 1000)) {
      return reply.code(429).send({ error: "注册尝试过于频繁，请稍后再试" });
    }
    const body = registerSchema.parse(request.body);
    const normalizedEmail = body.email.toLowerCase();
    const userId = nanoid();
    const passwordHash = await hashPasswordAsync(body.password);
    const result = await repo.createInvitedUser(appDb, {
      id: userId,
      email: normalizedEmail,
      passwordHash,
      inviteCode: body.inviteCode,
      quota: INITIAL_USER_QUOTA
    });
    if (result.status === "invite_invalid") {
      return reply.code(403).send({ error: "邀请码不正确" });
    }
    if (result.status === "email_exists") {
      return reply.code(409).send({ error: "账号已存在" });
    }
    reply.setCookie(sessionCookieName(options.production), result.sessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: Boolean(options.production),
      maxAge: 60 * 60 * 24 * 14
    });
    return serializeUser(result.user);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = readSessionCookie(request);
    if (sessionId) {
      await deleteSession(appDb, sessionId);
    }
    reply.clearCookie("paintopia_session", { path: "/" });
    reply.clearCookie("__Host-paintopia_session", { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: ctx.requireAuth }, async (request) => {
    return serializeUser((request as AuthedRequest).user);
  });

  app.post("/api/auth/change-password", { preHandler: ctx.requireAuth, bodyLimit: 4096 }, async (request, reply) => {
    if (!await allowUserAction(appDb, request, reply, "change-password", { limit: 5, windowMs: 15 * 60 * 1000 })) return;
    const parsed = z.object({
      currentPassword: z.string().min(1, "请输入当前密码").max(128, "当前密码不能超过 128 位"),
      newPassword: z.string().min(6, "新密码至少 6 位").max(128, "新密码不能超过 128 位")
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "请求参数无效" });
    let result: Awaited<ReturnType<typeof changeUserPassword>>;
    try {
      result = await changeUserPassword(appDb, (request as AuthedRequest).user, parsed.data.currentPassword, parsed.data.newPassword);
    } catch {
      return reply.code(500).send({ error: "密码未修改，请稍后重试" });
    }
    if (result === "incorrect_password") return reply.code(400).send({ error: "当前密码不正确，请重新输入" });
    if (result === "same_password") return reply.code(400).send({ error: "新密码不能与当前密码相同" });
    if (result === "conflict") return reply.code(409).send({ error: "账户状态已变化，请重新登录后再试" });
    reply.clearCookie("paintopia_session", { path: "/" });
    reply.clearCookie("__Host-paintopia_session", { path: "/", secure: true, httpOnly: true, sameSite: "lax" });
    return { ok: true };
  });
}
