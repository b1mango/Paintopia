import { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import * as repo from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import { createInviteCodeValue, listAdminUsers, listInviteCodes, serializeAdminUser, serializeInviteCode } from "../services/users.js";
import { AuthedRequest } from "./authHelpers.js";
import { idParamSchema, inviteQuerySchema, userPatchSchema } from "./schemas.js";

export function registerAdminUsersRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb } = ctx;
  app.get("/api/admin/users", { preHandler: ctx.requireAdmin }, async (request) => {
    const query = z.object({ q: z.string().optional() }).parse(request.query);
    return listAdminUsers(appDb, query.q);
  });

  app.patch("/api/admin/users/:id", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const body = userPatchSchema.parse(request.body);
    const existing = await repo.findUserById(appDb, params.id);
    if (!existing) {
      return reply.code(404).send({ error: "用户不存在" });
    }

    const updated = await repo.updateUser(appDb, params.id, body);
    await repo.writeAuditLog(appDb, {
      actorUserId: (request as AuthedRequest).user.id,
      action: "user.update",
      targetType: "user",
      targetId: params.id,
      detail: {
        quota: body.quota,
        status: body.status
      }
    });
    return serializeAdminUser(updated);
  });

  app.get("/api/admin/invite-codes", { preHandler: ctx.requireAdmin }, async (request) => {
    const query = inviteQuerySchema.parse(request.query);
    return listInviteCodes(appDb, query);
  });

  app.post("/api/admin/invite-codes", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const now = new Date();
    const invite = {
      id: nanoid(),
      code: createInviteCodeValue(),
      status: "active" as const,
      createdBy: user.id,
      usedBy: null,
      createdAt: now,
      usedAt: null,
      destroyedAt: null
    };
    await repo.insertInvite(appDb, invite);

    return reply.code(201).send(await serializeInviteCode(appDb, invite));
  });

  app.delete("/api/admin/invite-codes/:id", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const invite = await repo.findInvite(appDb, params.id);
    if (!invite) {
      return reply.code(404).send({ error: "邀请码不存在" });
    }
    if (invite.status !== "active") {
      return serializeInviteCode(appDb, invite);
    }

    await repo.destroyInvite(appDb, params.id);
    await repo.writeAuditLog(appDb, {
      actorUserId: (request as AuthedRequest).user.id,
      action: "invite.destroy",
      targetType: "invite",
      targetId: params.id
    });
    return serializeInviteCode(appDb, await repo.findInvite(appDb, params.id));
  });
}
