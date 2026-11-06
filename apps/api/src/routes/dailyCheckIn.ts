import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { consumeRateLimit } from "../db/repository.js";
import type { ServerContext } from "../server/context.js";

import { createDailyCheckInService } from "../services/dailyCheckIn.js";
export function registerDailyCheckInRoutes(app: FastifyInstance, { db, requireAuth }: Pick<ServerContext, "db" | "requireAuth">) {
  const service = createDailyCheckInService(db);
  type Authed = FastifyRequest & { user: { id: string } };
  app.get("/api/check-in", { preHandler: requireAuth }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return service.status((request as Authed).user.id);
  });
  app.post("/api/check-in", { preHandler: requireAuth }, async (request, reply) => {
    const userId = (request as Authed).user.id;
    if (!z.object({}).strict().safeParse(request.body ?? {}).success) {
      return reply.code(400).send({ error: "签到无需填写参数，请直接领取" });
    }
    if (!await consumeRateLimit(db, `daily-check-in:${userId}`, 12, 60000)) {
      return reply.code(429).send({ error: "签到请求过于频繁，请稍后重试" });
    }
    reply.header("Cache-Control", "private, no-store");
    return service.claim(userId);
  });
}
