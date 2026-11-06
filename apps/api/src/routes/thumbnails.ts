import { type FastifyInstance } from "fastify";
import { z } from "zod";
import * as repo from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import { createImageThumbnail } from "../services/imageThumbnail.js";
import { storeAssetThumbnail } from "./assetDelivery.js";
import { allowUserAction } from "./authHelpers.js";

export function registerThumbnailsRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb, storage: assetStorage } = ctx;
  app.post("/api/admin/thumbnails/backfill", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    if (!await allowUserAction(appDb, request, reply, "thumbnail-backfill", { limit: 30, windowMs: 60_000 })) return;
    const { after } = z.object({ after: z.string().max(80).default("") }).parse(request.body ?? {});
    const rows = await appDb.query<{ id: string }>("SELECT id FROM assets WHERE status='ready' AND id > ? ORDER BY id LIMIT 5", [after]);
    const results = [];
    for (const row of rows) { try { const asset = await repo.findAsset(appDb, row.id); if (asset) { const key = asset.thumbPath; if (!key || !await assetStorage.head(key)) await storeAssetThumbnail(appDb, assetStorage, asset); else { const small = `thumbnails/${asset.id}-320.webp`; if (!await assetStorage.head(small)) await assetStorage.put(small, await createImageThumbnail(await assetStorage.read(key), 320), "image/webp"); } } results.push({ id: row.id, ok: true }); } catch { results.push({ id: row.id, ok: false }); } }
    return { results, next: rows.length === 5 ? rows.at(-1)!.id : null };
  });
}
