import { type FastifyInstance } from "fastify";
import { z } from "zod";
import * as repo from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import { AuthedRequest } from "./authHelpers.js";

export function registerPreferencesRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb } = ctx;
  app.get("/api/preferences", { preHandler: ctx.requireAuth }, async (request) => {
    const user = (request as AuthedRequest).user;
    return repo.getPreference(appDb, user.id);
  });

  app.patch("/api/preferences", { preHandler: ctx.requireAuth }, async (request) => {
    const user = (request as AuthedRequest).user;
    const body = z.object({
      theme: z.enum(["dark", "light", "system"]).optional(),
      language: z.enum(["zh", "en"]).optional(),
      reduceMotion: z.boolean().optional(),
      defaultImageModel: z.string().optional(),
      defaultSize: z.string().optional()
    }).parse(request.body);

    return repo.updatePreference(appDb, user.id, body);
  });
}
