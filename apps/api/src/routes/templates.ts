import { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import * as repo from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import { idParamSchema, templateSchema } from "./schemas.js";

export function registerTemplatesRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb } = ctx;
  app.get("/api/admin/templates", { preHandler: ctx.requireAdmin }, async () => {
    return repo.listTemplates(appDb);
  });

  app.post("/api/admin/templates", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const body = templateSchema.parse(request.body);
    const now = new Date();
    const id = nanoid();
    const template: repo.PromptTemplateRecord = {
      id,
      ...body,
      isDefault: false,
      createdAt: now,
      updatedAt: now
    };
    await repo.insertTemplate(appDb, template);

    return reply.code(201).send(template);
  });

  app.patch("/api/admin/templates/:id", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const body = templateSchema.parse(request.body);
    const existing = await repo.findTemplate(appDb, params.id);
    if (!existing) {
      return reply.code(404).send({ error: "提示词模板不存在" });
    }
    return repo.updateTemplate(appDb, params.id, body);
  });

  app.post("/api/admin/templates/:id/default", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const templates = await repo.setDefaultTemplate(appDb, id);
    if (!templates) return reply.code(404).send({ error: "提示词模板不存在" });
    return templates;
  });

  app.delete("/api/admin/templates/:id", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const result = await repo.deleteTemplate(appDb, id);
    if (result === "missing") return reply.code(404).send({ error: "提示词模板不存在" });
    if (result === "default") return reply.code(409).send({ error: "请先把其他模板设为默认，再删除这份" });
    return reply.code(204).send();
  });
}
