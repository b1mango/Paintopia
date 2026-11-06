import {
  type GalleryTag
} from "@paintopia/shared";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";
import { HttpRequestError } from "./requestError.js";

import { type AssetStorage } from "../services/assetStorage.js";
import { createMediaEdgeUrl, mediaEdgeClientExpiry } from "../services/mediaEdge.js";
import { getUserEmailById } from "./users.js";

export async function listAssets(appDb: AppDatabase, userId: string, page?: number, pageSize = 20, role = "user") {
  const assets = await repo.listAssetsWithOwner(appDb, userId, page, pageSize);
  const gallery = assets.length ? await appDb.query<{ asset_id: string; id: string; status: repo.GalleryItemRecord["status"] }>(`SELECT asset_id,id,status FROM gallery_items WHERE asset_id IN (${assets.map(() => "?").join(",")})`, assets.map(a => a.id)) : [];
  const byAsset = new Map(gallery.map(g => [g.asset_id, g]));
  const curated = role === "admin" && assets.length ? await appDb.query<{ source_asset_id: string; id: string }>(
    "SELECT source_asset_id,id FROM curated_prompts WHERE source_asset_id IN (" + assets.map(() => "?").join(",") + ")", assets.map(asset => asset.id)
  ) : [];
  const byCuratedAsset = new Map(curated.map(item => [item.source_asset_id, item.id]));
  const now = Date.now();
  // 320 is written alongside every thumbnail; legacy gaps fall back to the API thumbnail on the client.
  return Promise.all(assets.map(async asset => ({
    ...await serializeAsset(appDb, asset, asset.ownerEmail, byAsset.get(asset.id) ?? null, role === "admin" ? byCuratedAsset.get(asset.id) ?? null : undefined),
    thumbnailEdgeUrl: asset.thumbPath ? createMediaEdgeUrl(`thumbnails/${asset.id}-320.webp`, now) : null,
    thumbnailEdgeExpiresAt: mediaEdgeClientExpiry(now)
  })));
}

export async function serializeAsset(appDb: AppDatabase, asset: repo.AssetRecord, ownerEmail?: string, knownGallery?: { id: string; status: repo.GalleryItemRecord["status"] } | null, curatedPromptId?: string | null) {
  const galleryItem = knownGallery === undefined ? await repo.findGalleryByAsset(appDb, asset.id) : knownGallery;
  const email = ownerEmail ?? await getUserEmailById(appDb, asset.userId) ?? "";
  return {
    id: asset.id,
    imageUrl: `/api/assets/${asset.id}/original`,
    thumbnailUrl: `/api/assets/${asset.id}/thumbnail`,
    sizeBytes: asset.sizeBytes ?? null,
    ownerName: displayAuthorName(email),
    ownerEmail: email || null,
    prompt: asset.prompt,
    params: safeJsonParse(asset.paramsJson),
    createdAt: asset.createdAt.toISOString(),
    ...(curatedPromptId !== undefined ? { curatedPromptId } : {}),
    gallerySynced: Boolean(galleryItem),
    galleryItemId: galleryItem?.id ?? null,
    galleryStatus: galleryItem?.status ?? null,
    expiresAt: asset.expiresAt?.toISOString() ?? null
  };
}

export async function listGalleryItems(appDb: AppDatabase, userId: string, role: string) {
  const items = (await repo.listGalleryWithAuthor(appDb))
    .filter((item) => item.status === "approved" || role === "admin" || item.userId === userId);
  const tags = await repo.listGalleryTags(appDb, items.map((item) => item.id));
  const assets = items.length ? await appDb.query<{ id: string; thumbPath: string | null }>(
    `SELECT id, thumb_path AS "thumbPath" FROM assets WHERE status = 'ready' AND id IN (${items.map(() => "?").join(",")})`, items.map(item => item.assetId)
  ) : [];
  const byId = new Map(assets.map(asset => [asset.id, asset.thumbPath]));
  return Promise.all(items.map(async item => {
    const serialized = await serializeGalleryItem(appDb, item, item.authorEmail, tags.get(item.id));
    const key = byId.get(item.assetId);
    const now = Date.now();
    return { ...serialized, thumbnailEdgeUrl: key ? createMediaEdgeUrl(key, now) : null, thumbnailEdgeExpiresAt: mediaEdgeClientExpiry(now) };
  }));
}

export async function serializeGalleryItem(
  appDb: AppDatabase,
  item: repo.GalleryItemRecord,
  authorEmail?: string,
  knownTags?: GalleryTag[]
) {
  const email = authorEmail ?? await getUserEmailById(appDb, item.userId) ?? "";
  const tags = knownTags ?? (await repo.listGalleryTags(appDb, [item.id])).get(item.id) ?? [];
  return {
    id: item.id,
    assetId: item.assetId,
    userId: item.userId,
    imageUrl: `/api/gallery/${item.id}/image`,
    thumbnailUrl: `/api/gallery/${item.id}/thumbnail`,
    authorName: displayAuthorName(email),
    title: item.title,
    prompt: item.prompt,
    tags,
    status: item.status,
    rejectionReason: item.rejectionReason,
    reviewedAt: item.reviewedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString()
  };
}

export function safeJsonParse(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function displayAuthorName(email: string) {
  const normalized = email.trim();
  if (!normalized) return "未知作者";
  return normalized.includes("@") ? normalized.split("@")[0]! : normalized;
}

export function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

export function storageExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

export function assetThumbnailKey(assetId: string) {
  return `thumbnails/${assetId}.webp`;
}

export function pendingGalleryKey(userId: string, galleryItemId: string, mimeType: string) {
  return `pending/${userId}/${galleryItemId}.${storageExtension(mimeType)}`;
}

export function approvedGalleryKey(galleryItemId: string, sourceKey: string) {
  const extension = path.extname(sourceKey).replace(/[^.a-z0-9]/gi, "") || ".png";
  return `gallery/${galleryItemId}${extension}`;
}

export function imageMimeType(bytes: Buffer) {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  return "image/png";
}

export function detectUploadedImageMimeType(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function readStoredAsset(appDb: AppDatabase, storage: AssetStorage, asset: repo.AssetRecord) {
  return readStoredObject(appDb, storage, asset);
}

async function readStoredObject(
  appDb: AppDatabase,
  storage: AssetStorage,
  object: { originalPath: string; storageBackend: "local" | "r2" }
) {
  if (object.storageBackend === "local" && path.isAbsolute(object.originalPath)) {
    const resolvedDataDir = path.resolve(appDb.dataDir);
    const resolvedAssetPath = path.resolve(object.originalPath);
    const relativeAssetPath = path.relative(resolvedDataDir, resolvedAssetPath);
    if (relativeAssetPath.startsWith("..") || path.isAbsolute(relativeAssetPath)) {
      throw new HttpRequestError(403, "资产路径无效");
    }
    return readFile(resolvedAssetPath);
  }
  return storage.read(object.originalPath);
}

export async function deleteStoredAsset(appDb: AppDatabase, storage: AssetStorage, asset: repo.AssetRecord) {
  if (asset.storageBackend === "local" && path.isAbsolute(asset.originalPath)) {
    const resolvedDataDir = path.resolve(appDb.dataDir);
    const resolvedAssetPath = path.resolve(asset.originalPath);
    const relativeAssetPath = path.relative(resolvedDataDir, resolvedAssetPath);
    if (!relativeAssetPath.startsWith("..") && !path.isAbsolute(relativeAssetPath)) {
      await unlink(resolvedAssetPath).catch(() => undefined);
    }
  } else {
    await storage.delete(asset.originalPath);
  }
  if (asset.thumbPath) {
    await storage.delete(asset.thumbPath);
  }
  await storage.delete(`thumbnails/${asset.id}-320.webp`);
}

export async function cleanupTransientReferenceAssets(
  appDb: AppDatabase,
  storage: AssetStorage,
  userId: string,
  assetIds: string[]
) {
  if (assetIds.length === 0) return;
  const removed = await repo.deleteAssets(appDb, Array.from(new Set(assetIds)), userId);
  await Promise.allSettled(removed.map((asset) => deleteStoredAsset(appDb, storage, asset)));
}

export async function copyAssetObject(
  appDb: AppDatabase,
  storage: AssetStorage,
  asset: repo.AssetRecord,
  targetKey: string
) {
  if (asset.storageBackend === storage.backend && !path.isAbsolute(asset.originalPath)) {
    await storage.copy(asset.originalPath, targetKey, asset.mimeType);
    return;
  }
  await storage.put(targetKey, await readStoredAsset(appDb, storage, asset), asset.mimeType);
}
