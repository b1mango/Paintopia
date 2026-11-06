import { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { generationHistory } from "../db/generationHistory.js";
import type { ServerContext } from "../server/context.js";
import { summarizeGenerationStats } from "../services/users.js";
import { AuthedRequest } from "./authHelpers.js";

export function registerHistoryRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb } = ctx;
  app.get("/api/generation-stats", { preHandler: ctx.requireAuth }, async (request) => {
    const user = (request as AuthedRequest).user;
    return summarizeGenerationStats(appDb, user.id);
  });

  const historyQuery = (scopeUserId: string | undefined) => async (request: FastifyRequest, reply: FastifyReply) => {
    const parsedFilters = z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
      user: z.string().trim().max(200).optional(),
      model: z.string().trim().max(200).optional(),
      provider: z.string().trim().max(200).optional(),
      status: z.enum(["running", "succeeded", "failed"]).optional()
    }).safeParse(request.query);
    if (!parsedFilters.success) return reply.code(400).send({ error: "调用记录筛选参数无效" });
    const filters = parsedFilters.data;
    if (filters.from && filters.to && new Date(filters.from) > new Date(filters.to)) {
      return reply.code(400).send({ error: "开始时间不能晚于结束时间" });
    }
    return generationHistory(appDb, {
      ...filters,
      userId: scopeUserId,
      from: filters.from ? new Date(filters.from) : undefined,
      to: filters.to ? new Date(filters.to) : undefined
    });
  };

  app.get("/api/generation-history", { preHandler: ctx.requireAuth }, (request, reply) =>
    historyQuery((request as AuthedRequest).user.id)(request, reply));

  app.get("/api/admin/generation-history", { preHandler: ctx.requireAdmin }, historyQuery(undefined));
}
