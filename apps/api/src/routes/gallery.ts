import {
  GALLERY_TAGS
} from "@paintopia/shared";
import { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import * as repo from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import { personalAssetExpiry, personalAssetKey } from "../services/assetRetention.js";
import { approvedGalleryKey, copyAssetObject, pendingGalleryKey, serializeGalleryItem } from "../services/assets.js";
import { createImageThumbnail } from "../services/imageThumbnail.js";
import { assetDownloadFileName, getAssetThumbnailKey, sendAssetImage, sendStorageObject } from "./assetDelivery.js";
import { allowUserAction, AuthedRequest } from "./authHelpers.js";
import { validateGalleryTagIds } from "./galleryValidation.js";
import { CONTENT_MUTATION_RATE_LIMIT, galleryReviewSchema, galleryTagIdsSchema, idParamSchema } from "./schemas.js";

export function registerGalleryRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb, storage: assetStorage, assetRetention } = ctx;
  app.post("/api/assets/:id/gallery", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!await allowUserAction(appDb, request, reply, "gallery-mutation", CONTENT_MUTATION_RATE_LIMIT)) return;
    const { id } = idParamSchema.parse(request.params);
    const asset = await repo.findAsset(appDb, id);

    if (!asset || asset.status !== "ready" || (asset.userId !== user.id && user.role !== "admin")) {
      return reply.code(404).send({ error: "资产不存在" });
    }

    const existing = await repo.findGalleryByAsset(appDb, asset.id);
    if (existing) {
      return serializeGalleryItem(appDb, existing, user.email);
    }

    const now = new Date();
    const title = asset.prompt.trim().slice(0, 25) || "Untitled";
    const galleryItemId = nanoid();
    const pendingKey = pendingGalleryKey(asset.userId, galleryItemId, asset.mimeType);
    await copyAssetObject(appDb, assetStorage, asset, pendingKey);
    const galleryItem: repo.GalleryItemRecord = {
      id: galleryItemId,
      assetId: asset.id,
      userId: asset.userId,
      title,
      prompt: asset.prompt,
      status: "pending",
      objectKey: pendingKey,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: now
    };
    if (!await repo.insertGallery(appDb, galleryItem)) {
      await assetStorage.delete(pendingKey);
      const concurrentItem = await repo.findGalleryByAsset(appDb, asset.id);
      if (!concurrentItem) return reply.code(409).send({ error: "画廊状态已变化，请重试" });
      return serializeGalleryItem(appDb, concurrentItem);
    }

    return reply.code(201).send(await serializeGalleryItem(appDb, galleryItem));
  });

  app.delete("/api/assets/:id/gallery", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const asset = await repo.findAsset(appDb, id);

    if (!asset || (asset.userId !== user.id && user.role !== "admin")) {
      return reply.code(404).send({ error: "资产不存在" });
    }

    const galleryItem = await repo.findGalleryByAsset(appDb, asset.id);
    if (galleryItem?.status === "approved" && galleryItem.objectKey) {
      const personalKey = personalAssetKey(assetRetention, asset.userId, asset.id, asset.mimeType);
      await assetStorage.copy(galleryItem.objectKey, personalKey, asset.mimeType);
      await repo.updateAssetStorage(appDb, asset.id, {
        originalPath: personalKey,
        storageBackend: assetStorage.backend,
        expiresAt: personalAssetExpiry(assetRetention, asset.userId, new Date())
      });
    }
    await repo.deleteGalleryByAsset(appDb, asset.id);
    if (galleryItem?.objectKey) {
      await assetStorage.delete(galleryItem.objectKey);
    }

    return { expiresAt: (await repo.findAsset(appDb, asset.id))?.expiresAt?.toISOString() ?? null };
  });

  app.get("/api/gallery/:id/image", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const item = await repo.findGallery(appDb, id);
    if (!item || (item.status !== "approved" && item.userId !== user.id && user.role !== "admin")) {
      return reply.code(404).send({ error: "画廊图片不存在" });
    }
    if (!item.objectKey) {
      const asset = await repo.findAsset(appDb, item.assetId);
      if (!asset) return reply.code(404).send({ error: "画廊图片不存在" });
      return sendAssetImage(reply, appDb, assetStorage, asset);
    }
    return sendStorageObject(reply, assetStorage, item.objectKey, "image/png");
  });

  app.get("/api/gallery/:id/download", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const item = await repo.findGallery(appDb, id);
    if (!item || (item.status !== "approved" && item.userId !== user.id && user.role !== "admin")) {
      return reply.code(404).send({ error: "画廊图片不存在" });
    }
    const asset = await repo.findAsset(appDb, item.assetId);
    if (!asset) {
      return reply.code(404).send({ error: "画廊资产不存在" });
    }
    const fileName = assetDownloadFileName(asset.id, asset.mimeType);
    if (!item.objectKey) {
      return sendAssetImage(reply, appDb, assetStorage, asset, fileName);
    }
    return sendStorageObject(reply, assetStorage, item.objectKey, asset.mimeType, "private, max-age=3600", fileName);
  });

  app.get("/api/gallery/:id/thumbnail", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const item = await repo.findGallery(appDb, id);
    if (!item || (item.status !== "approved" && item.userId !== user.id && user.role !== "admin")) {
      return reply.code(404).send({ error: "画廊图片不存在" });
    }
    const small = (request.query as { size?: string }).size === "320";
    const asset = await repo.findAsset(appDb, item.assetId);
    if (asset) {
      try {
        const key = await getAssetThumbnailKey(appDb, assetStorage, asset, small);
        // Signed redirects cannot report a missing object back to this route.
        if (await assetStorage.head(key)) {
          return await sendStorageObject(reply, assetStorage, key, "image/webp", "private, max-age=300");
        }
      } catch {
        // The gallery copy survives missing or unreadable source assets.
      }
    }
    try {
      const key = `thumbnails/gallery-${item.id}${small ? "-320" : ""}.webp`;
      if (!await assetStorage.head(key)) {
        if (!item.objectKey) return reply.code(404).send({ error: "画廊图片不存在" });
        const thumbnail = await createImageThumbnail(await assetStorage.read(item.objectKey), small ? 320 : 640);
        await assetStorage.put(key, thumbnail, "image/webp");
      }
      return await sendStorageObject(reply, assetStorage, key, "image/webp", "private, max-age=300");
    } catch {
      return reply.code(503).header("Retry-After", "15").send({ error: "缩略图暂不可用，请重试" });
    }
  });

  app.get("/api/gallery-tags", { preHandler: ctx.requireAuth }, async () => ({
    tags: await repo.listAllGalleryTags(appDb)
  }));

  app.get("/api/gallery-tags/in-use", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const rows = await appDb.query<{ tagId: string; count: number | string }>(
      `SELECT t.tag_id AS "tagId", COUNT(*) AS count FROM gallery_item_tags t
       JOIN gallery_items g ON g.id = t.gallery_item_id
       WHERE g.status = 'approved' OR g.user_id = ? OR ? = 'admin'
       GROUP BY t.tag_id`,
      [user.id, user.role]
    );
    reply.header("Cache-Control", "private, no-store");
    return { counts: Object.fromEntries(rows.map(row => [row.tagId, Number(row.count)])) };
  });

  app.post("/api/admin/gallery-tags", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const admin = (request as AuthedRequest).user;
    const body = z.object({
      label: z.string().trim().min(1, "标签名称不能为空").max(20, "标签名称不能超过 20 个字符"),
      group: z.enum(["subject", "scene", "style"])
    }).parse(request.body);
    const label = body.label.toLowerCase();
    const existing = GALLERY_TAGS.find((tag) =>
      [tag.id, tag.label, ...tag.aliases].some((value) => value.toLowerCase() === label)
    ) ?? (await repo.listCustomGalleryTags(appDb)).find((tag) => tag.label.toLowerCase() === label);
    if (existing) return existing;
    const result = await appDb.transaction(async (tx) => {
      const result = await repo.createCustomGalleryTag(tx, { ...body, createdBy: admin.id });
      if (result.created) {
        await repo.writeAuditLog(tx, {
          actorUserId: admin.id, action: "gallery.tag.create", targetType: "gallery_tag",
          targetId: result.tag.id, detail: { label: result.tag.label, group: result.tag.group }
        });
      }
      return result;
    });
    return reply.code(result.created ? 201 : 200).send(result.tag);
  });

  app.get("/api/admin/gallery-review", { preHandler: ctx.requireAdmin }, async (request) => {
    const query = z.object({ status: z.enum(["all", "pending", "approved", "rejected"]).optional() }).parse(request.query);
    const status = query.status ?? "pending";
    const items = (await repo.listGalleryWithAuthor(appDb))
      .filter((item) => status === "all" || item.status === status);
    const tags = await repo.listGalleryTags(appDb, items.map((item) => item.id));
    return Promise.all(items.map((item) => serializeGalleryItem(appDb, item, item.authorEmail, tags.get(item.id))));
  });

  app.patch("/api/admin/gallery-review/:id", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const admin = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const body = galleryReviewSchema.parse(request.body);
    if (body.decision === "approve") await validateGalleryTagIds(appDb, body.tagIds);
    const item = await repo.findGallery(appDb, id);
    if (!item || item.status !== "pending") {
      return reply.code(404).send({ error: "待审核画廊项目不存在" });
    }
    if (body.decision === "approve" && !item.objectKey) {
      return reply.code(409).send({ error: "待审图片文件不存在" });
    }
    // Each approval owns its copy: a losing request must never delete the winner's object.
    const permanentKey = body.decision === "approve" ? approvedGalleryKey(`${item.id}-${nanoid()}`, item.objectKey!) : null;
    let committed = false;
    try {
      if (permanentKey) await assetStorage.copy(item.objectKey!, permanentKey);
      const changed = await appDb.transaction(async (tx) => {
        const changed = await repo.reviewGallery(tx, item.id, {
          status: body.decision === "approve" ? "approved" : "rejected",
          objectKey: permanentKey,
          reviewedBy: admin.id,
          rejectionReason: body.decision === "reject" ? body.reason ?? null : null
        });
        if (!changed) return false;
        if (body.decision === "approve") {
          await repo.replaceGalleryTags(tx, item.id, body.tagIds);
          await repo.updateAssetStorage(tx, item.assetId, {
            originalPath: permanentKey!,
            storageBackend: assetStorage.backend,
            expiresAt: null
          });
        }
        await repo.writeAuditLog(tx, {
          actorUserId: admin.id,
          action: `gallery.${body.decision}`,
          targetType: "gallery",
          targetId: item.id,
          detail: body.decision === "approve" ? { tagIds: body.tagIds } : { reason: body.reason }
        });
        return true;
      });
      if (!changed) return reply.code(409).send({ error: "该作品已被审核或撤回，请刷新列表" });
      committed = true;
    } finally {
      // A failed copy/transaction leaves the pending record and source intact.
      if (!committed && permanentKey) {
        await assetStorage.delete(permanentKey).catch((error) => request.log.warn({ err: error }, "Could not remove unused gallery copy"));
      }
    }
    // Retain personal originals for in-flight readers/withdrawal; R2's temporary lifecycle can reclaim its copies.
    // Do not delete/rebuild thumbnails while moving an original into permanent gallery storage.
    if (item.objectKey) await assetStorage.delete(item.objectKey)
      .catch((error) => request.log.warn({ err: error }, "Could not remove reviewed pending object"));
    const reviewed = await repo.findGallery(appDb, item.id);
    if (!reviewed) return reply.code(409).send({ error: "作品已被撤回，请刷新列表" });
    return serializeGalleryItem(appDb, reviewed);
  });

  app.patch("/api/admin/gallery-review/:id/tags", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const admin = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const { tagIds } = z.object({ tagIds: galleryTagIdsSchema }).parse(request.body);
    await validateGalleryTagIds(appDb, tagIds);
    const changed = await appDb.transaction(async (tx) => {
      // Lock the published row before replacing tags; concurrent withdrawal must not leave orphan tags.
      const exists = await tx.execute("UPDATE gallery_items SET reviewed_at = reviewed_at WHERE id = ? AND status = 'approved'", [id]);
      if (!exists) return false;
      await repo.replaceGalleryTags(tx, id, tagIds);
      await repo.writeAuditLog(tx, { actorUserId: admin.id, action: "gallery.tags.update", targetType: "gallery", targetId: id, detail: { tagIds } });
      return true;
    });
    if (!changed) return reply.code(404).send({ error: "已发布画廊作品不存在" });
    const updated = await repo.findGallery(appDb, id);
    if (!updated) return reply.code(409).send({ error: "作品已被撤回，请刷新列表" });
    return serializeGalleryItem(appDb, updated);
  });
}
