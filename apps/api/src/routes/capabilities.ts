import { type FastifyInstance } from "fastify";
import type { ServerContext } from "../server/context.js";
import { cachedImageCapabilities } from "../services/imageCapabilities.js";

export function registerCapabilitiesRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb } = ctx;
  app.get("/api/image-capabilities", { preHandler: ctx.requireAuth }, async () => ({
    models: await cachedImageCapabilities(appDb)
  }));
}
