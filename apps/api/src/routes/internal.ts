import { type FastifyInstance } from "fastify";
import * as repo from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import { preservePermanentAsset } from "../services/assetRetention.js";
import { addDays, deleteStoredAsset } from "../services/assets.js";
import {
  deleteExpiredSessions
} from "../services/authService.js";

export function registerInternalRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb, storage: assetStorage, config: options, assetRetention } = ctx;
  app.get("/api/internal/cleanup", async (request, reply) => {
    if (!options.cronSecret || request.headers.authorization !== `Bearer ${options.cronSecret}`) {
      return reply.code(401).send({ error: "未授权的清理请求" });
    }
    const now = new Date();
    const staleBefore = addDays(now, -(options.pendingGalleryRetentionDays ?? 30));
    const staleGallery = await repo.listStalePendingGallery(appDb, staleBefore);
    for (const item of staleGallery) {
      await repo.expireGallery(appDb, item.id);
      if (item.objectKey) await assetStorage.delete(item.objectKey);
    }

    const expiredAssets = await repo.listExpiredAssets(appDb, now);
    let deletedAssets = 0;
    let failedPermanentAssets = 0;
    for (const asset of expiredAssets) {
      const galleryItem = await repo.findGalleryByAsset(appDb, asset.id);
      if (galleryItem?.status === "approved" || asset.userId === assetRetention.ownerUserId) {
        try {
          await preservePermanentAsset(appDb, assetStorage, asset, galleryItem);
        } catch {
          // Keep its database record for recovery; one missing legacy image must not block all cleanup.
          failedPermanentAssets += 1;
        }
        continue;
      }
      await repo.deleteAsset(appDb, asset.id, asset.userId);
      if (galleryItem?.objectKey) await assetStorage.delete(galleryItem.objectKey);
      await deleteStoredAsset(appDb, assetStorage, asset);
      deletedAssets += 1;
    }
    const deletedSessions = await deleteExpiredSessions(appDb);
    const deletedRateLimits = await repo.deleteExpiredRateLimits(appDb, now);
    return {
      ok: true,
      expiredGallery: staleGallery.length,
      deletedAssets,
      failedPermanentAssets,
      deletedSessions,
      deletedRateLimits
    };
  });
}
