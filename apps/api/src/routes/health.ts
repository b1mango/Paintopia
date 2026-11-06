import { type FastifyInstance } from "fastify";
import type { ServerContext } from "../server/context.js";

export function registerHealthRoutes(app: FastifyInstance, _ctx: ServerContext) {

  app.get("/api/health", async () => ({ ok: true }));
}
