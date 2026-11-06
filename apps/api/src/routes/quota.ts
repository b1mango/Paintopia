import { type FastifyInstance } from "fastify";
import * as repo from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import { defaultQuotaPricingRules, ensureQuotaPricingRules, listQuotaPricingRules } from "../services/quota.js";
import { quotaPricingPatchSchema } from "./schemas.js";

export function registerQuotaRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb } = ctx;
  app.get("/api/quota-pricing", { preHandler: ctx.requireAuth }, async () => {
    await ensureQuotaPricingRules(appDb);
    return listQuotaPricingRules(appDb);
  });

  app.get("/api/admin/quota-pricing", { preHandler: ctx.requireAdmin }, async () => {
    await ensureQuotaPricingRules(appDb);
    return listQuotaPricingRules(appDb);
  });

  app.patch("/api/admin/quota-pricing", { preHandler: ctx.requireAdmin }, async (request) => {
    await ensureQuotaPricingRules(appDb);
    const body = quotaPricingPatchSchema.parse(request.body);
    const editableKeys = new Set(defaultQuotaPricingRules.map((rule) => rule.key));
    for (const rule of body.rules) {
      if (!editableKeys.has(rule.key)) {
        continue;
      }
      await repo.updateQuotaRule(appDb, rule.key, rule.amount);
    }
    return listQuotaPricingRules(appDb);
  });
}
