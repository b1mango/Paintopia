import { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import * as repo from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import { personalAssetExpiry, personalAssetKey } from "../services/assetRetention.js";
import { deleteStoredAsset, detectUploadedImageMimeType, listAssets, listGalleryItems, readStoredAsset, serializeAsset } from "../services/assets.js";
import { decodedImageDimensions, invalidateImageCapabilities } from "../services/imageCapabilities.js";
import { stripImageResultMetadata } from "../services/imageGeneration.js";
import { assetDownloadFileName, sendAssetImage, sendAssetThumbnail, storeAssetThumbnail } from "./assetDelivery.js";
import { allowUserAction, AuthedRequest } from "./authHelpers.js";
import { MAX_EDIT_REFERENCE_IMAGE_BYTES } from "./imageEditInput.js";
import { ASSET_UPLOAD_RATE_LIMIT, assetUploadSchema, idParamSchema } from "./schemas.js";

export function registerAssetsRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb, storage: assetStorage, assetRetention, contentSafety } = ctx;
  app.get("/api/assets", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const parsedQuery = z.object({ scope: z.literal("mine").optional(), page: z.coerce.number().int().min(1).max(1000000).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() }).safeParse(request.query);
    if (!parsedQuery.success) return reply.code(400).send({ error: "无效资产分页参数" });
    const query = parsedQuery.data;
    const paginated = query.page !== undefined || query.pageSize !== undefined;
    const page = query.page ?? 1, pageSize = query.pageSize ?? 20;
    const items = await listAssets(appDb, user.id, paginated ? page : undefined, pageSize, user.role);
    return paginated ? { items, total: await repo.countOwnedAssets(appDb, user.id), page, pageSize } : items;
  });

  app.get("/api/gallery", { preHandler: ctx.requireAuth }, async (request) => {
    const user = (request as AuthedRequest).user;
    return listGalleryItems(appDb, user.id, user.role);
  });

  app.get("/api/assets/:id/original", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const asset = await repo.findAsset(appDb, id);

    if (!asset || (asset.userId !== user.id && user.role !== "admin")) {
      return reply.code(404).send({ error: "资产不存在" });
    }
    if (asset.status !== "ready") {
      return reply.code(409).send({ error: "资产尚未上传完成" });
    }
    return sendAssetImage(reply, appDb, assetStorage, asset);
  });

  app.get("/api/assets/:id/download", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const asset = await repo.findAsset(appDb, id);
    if (!asset || asset.status !== "ready" || (asset.userId !== user.id && user.role !== "admin")) {
      return reply.code(404).send({ error: "资产不存在" });
    }
    return sendAssetImage(
      reply,
      appDb,
      assetStorage,
      asset,
      assetDownloadFileName(asset.id, asset.mimeType)
    );
  });

  app.get("/api/assets/:id/thumbnail", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const asset = await repo.findAsset(appDb, id);
    if (!asset || (asset.userId !== user.id && user.role !== "admin")) {
      return reply.code(404).send({ error: "资产不存在" });
    }
    if (asset.status !== "ready") {
      return reply.code(409).send({ error: "资产尚未上传完成" });
    }
    return sendAssetThumbnail(reply, appDb, assetStorage, asset, (request.query as { size?: string }).size === "320");
  });

  app.delete("/api/assets/:id", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const asset = await repo.findAsset(appDb, id);

    if (!asset || (asset.userId !== user.id && user.role !== "admin")) {
      return reply.code(404).send({ error: "资产不存在" });
    }
    const galleryItem = await repo.findGalleryByAsset(appDb, id);
    if (galleryItem?.status === "approved") {
      return reply.code(409).send({ error: "请先从画廊移除该图片，再删除资产" });
    }
    await repo.deleteAsset(appDb, id, asset.userId);
    if (galleryItem?.objectKey) await assetStorage.delete(galleryItem.objectKey);
    await deleteStoredAsset(appDb, assetStorage, asset);
    return reply.code(204).send();
  });

  app.post("/api/assets/uploads", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!await allowUserAction(appDb, request, reply, "asset-upload", ASSET_UPLOAD_RATE_LIMIT)) return;
    const body = assetUploadSchema.parse(request.body);
    if (contentSafety.findMatch([body.prompt])) {
      return reply.code(422).send({ error: "内容包含不允许的词语，请修改后重试" });
    }
    const assetId = nanoid();
    const createdAt = new Date();
    const expiresAt = personalAssetExpiry(assetRetention, user.id, createdAt);
    const objectKey = personalAssetKey(assetRetention, user.id, assetId, body.mimeType);
    const asset: repo.AssetRecord = {
      id: assetId,
      userId: user.id,
      jobId: null,
      originalPath: objectKey,
      thumbPath: null,
      storageBackend: assetStorage.backend,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      status: "uploading",
      expiresAt,
      prompt: body.prompt,
      paramsJson: JSON.stringify({ ...stripImageResultMetadata(body.params), sourceFileName: body.fileName }),
      createdAt
    };
    await repo.insertAsset(appDb, asset);
    const uploadUrl = await assetStorage.createUploadUrl(objectKey, body.mimeType, 300)
      ?? `/api/assets/${assetId}/upload`;
    return reply.code(201).send({
      assetId,
      uploadUrl,
      method: "PUT",
      headers: { "Content-Type": body.mimeType },
      expiresAt: expiresAt?.toISOString() ?? null
    });
  });

  app.put("/api/assets/:id/upload", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const asset = await repo.findAsset(appDb, id);
    if (!asset || asset.userId !== user.id || asset.status !== "uploading") {
      return reply.code(404).send({ error: "待上传资产不存在" });
    }
    if (assetStorage.backend !== "local") {
      return reply.code(405).send({ error: "生产环境请直接上传到签名地址" });
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_EDIT_REFERENCE_IMAGE_BYTES) {
      return reply.code(400).send({ error: "上传图片为空或超过 20MB" });
    }
    await assetStorage.put(asset.originalPath, body, asset.mimeType);
    return reply.code(204).send();
  });

  app.post("/api/assets/:id/complete-upload", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const { id } = idParamSchema.parse(request.params);
    const asset = await repo.findAsset(appDb, id);
    if (!asset || asset.userId !== user.id || asset.status !== "uploading") {
      return reply.code(404).send({ error: "待上传资产不存在" });
    }
    const stored = await assetStorage.head(asset.originalPath);
    if (!stored || stored.sizeBytes <= 0 || stored.sizeBytes > MAX_EDIT_REFERENCE_IMAGE_BYTES) {
      return reply.code(400).send({ error: "未找到有效上传图片" });
    }
    const sourceBytes = await readStoredAsset(appDb, assetStorage, asset);
    const mimeType = detectUploadedImageMimeType(sourceBytes);
    if (!mimeType || mimeType !== asset.mimeType) {
      await repo.deleteAsset(appDb, asset.id, user.id);
      await assetStorage.delete(asset.originalPath);
      return reply.code(415).send({ error: "上传内容不是有效的 PNG、JPEG 或 WebP 图片" });
    }
    await repo.completeAssetUpload(appDb, asset.id, stored.sizeBytes, mimeType);
    const dimensions = await decodedImageDimensions(sourceBytes);
    const paramsJson = JSON.stringify({ ...JSON.parse(asset.paramsJson), ...(dimensions ? { actualWidth: dimensions.width, actualHeight: dimensions.height } : {}) });
    await appDb.execute("UPDATE assets SET params_json = ? WHERE id = ?", [paramsJson, asset.id]);
    invalidateImageCapabilities(appDb);
    const readyAsset = { ...asset, paramsJson, status: "ready" as const, sizeBytes: stored.sizeBytes, mimeType };
    const thumbPath = await storeAssetThumbnail(appDb, assetStorage, readyAsset, sourceBytes).catch(() => null);
    const curated = user.role === "admin" ? await appDb.queryOne<{ id: string }>("SELECT id FROM curated_prompts WHERE source_asset_id = ?", [asset.id]) : undefined;
    return serializeAsset(appDb, { ...readyAsset, thumbPath }, undefined, undefined, user.role === "admin" ? curated?.id ?? null : undefined);
  });
}
