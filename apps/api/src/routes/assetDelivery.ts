import { type FastifyReply } from "fastify";
import path from "node:path";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";
import { assetThumbnailKey, readStoredAsset, storageExtension } from "../services/assets.js";
import { type AssetStorage } from "../services/assetStorage.js";
import { createImageThumbnail } from "../services/imageThumbnail.js";
import { createMediaEdgeUrl } from "../services/mediaEdge.js";

export async function sendAssetImage(
  reply: FastifyReply,
  appDb: AppDatabase,
  storage: AssetStorage,
  asset: repo.AssetRecord,
  downloadFileName?: string
) {
  if (asset.storageBackend === storage.backend && !path.isAbsolute(asset.originalPath)) {
    return sendStorageObject(reply, storage, asset.originalPath, asset.mimeType, "private, max-age=3600", downloadFileName);
  }
  const bytes = await readStoredAsset(appDb, storage, asset);
  if (downloadFileName) {
    reply.header("Content-Disposition", 'attachment; filename="' + downloadFileName + '"');
  }
  return reply
    .header("Content-Type", asset.mimeType)
    .header("Cache-Control", "private, max-age=3600")
    .send(bytes);
}

export async function storeAssetThumbnail(
  appDb: AppDatabase,
  storage: AssetStorage,
  asset: repo.AssetRecord,
  sourceBytes?: Buffer
) {
  const thumbnail = await createImageThumbnail(sourceBytes ?? await readStoredAsset(appDb, storage, asset));
  const key = assetThumbnailKey(asset.id);
  await storage.put(key, thumbnail, "image/webp");
  await storage.put(`thumbnails/${asset.id}-320.webp`, await createImageThumbnail(thumbnail, 320), "image/webp");
  if (asset.thumbPath !== key) {
    await repo.updateAssetThumbnail(appDb, asset.id, key);
  }
  return key;
}

export async function getAssetThumbnailKey(
  appDb: AppDatabase,
  storage: AssetStorage,
  asset: repo.AssetRecord,
  small: boolean
) {
  const key = asset.thumbPath ?? await storeAssetThumbnail(appDb, storage, asset);
  if (!small) return key;
  const smallKey = `thumbnails/${asset.id}-320.webp`;
  if (!await storage.head(smallKey)) {
    await storage.put(smallKey, await createImageThumbnail(await storage.read(key), 320), "image/webp");
  }
  return smallKey;
}

export async function sendAssetThumbnail(
  reply: FastifyReply,
  appDb: AppDatabase,
  storage: AssetStorage,
  asset: repo.AssetRecord,
  small = false
) {
  try {
    const key = await getAssetThumbnailKey(appDb, storage, asset, small);
    return await sendStorageObject(reply, storage, key, "image/webp", "private, max-age=300");
  } catch (error) {
    console.warn("Paintopia thumbnail fallback", error instanceof Error ? error.message : error);
    return reply.code(503).header("Retry-After", "15").send({ error: "缩略图暂不可用，请重试" });
  }
}

export async function sendStorageObject(
  reply: FastifyReply,
  storage: AssetStorage,
  key: string,
  mimeType: string,
  cacheControl = "private, max-age=3600",
  downloadFileName?: string
) {
  const edgeUrl = storage.backend === "r2" ? createMediaEdgeUrl(key, Date.now(), downloadFileName) : null;
  if (edgeUrl) return reply.header("Cache-Control", "private, max-age=60").redirect(edgeUrl);
  const signedUrl = await storage.createDownloadUrl(key, 300, downloadFileName);
  if (signedUrl) {
    return reply.header("Cache-Control", "private, max-age=120").redirect(signedUrl);
  }
  if (downloadFileName) {
    reply.header("Content-Disposition", 'attachment; filename="' + downloadFileName + '"');
  }
  return reply
    .header("Content-Type", mimeType)
    .header("Cache-Control", cacheControl)
    .send(await storage.read(key));
}

export function assetDownloadFileName(assetId: string, mimeType: string) {
  return "paintopia-" + assetId.replace(/[^A-Za-z0-9_-]/g, "_") + "." + storageExtension(mimeType);
}
