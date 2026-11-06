import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppDatabase, DatabaseExecutor } from "../db/database.js";
import type { AssetRecord, GalleryItemRecord } from "../db/repository.js";
import type { AssetStorage } from "./assetStorage.js";

export type AssetRetentionPolicy = { ownerUserId: string | null; days: number };

export async function resolveAssetRetentionPolicy(
  db: DatabaseExecutor, ownerEmail: string, days = 7
): Promise<AssetRetentionPolicy> {
  // A dedicated identity is intentional: additional administrators retain the normal limit.
  const owner = await db.queryOne<{ id: string }>("SELECT id FROM users WHERE email = ?", [ownerEmail.trim().toLowerCase()]);
  return { ownerUserId: owner?.id ?? null, days };
}

export function personalAssetExpiry(policy: AssetRetentionPolicy, userId: string, createdAt: Date): Date | null {
  return userId === policy.ownerUserId ? null : new Date(createdAt.getTime() + policy.days * 86_400_000);
}

export function personalAssetKey(policy: AssetRetentionPolicy, userId: string, assetId: string, mimeType: string): string {
  const prefix = userId === policy.ownerUserId ? "permanent" : "temporary";
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  return `${prefix}/${userId}/${assetId}.${extension}`;
}

/** Copy and verify before switching references. Never delete the source during preservation. */
export async function preservePermanentAsset(
  db: AppDatabase, storage: AssetStorage, asset: AssetRecord, gallery?: GalleryItemRecord
): Promise<void> {
  const approved = gallery?.status === "approved";
  const extension = asset.mimeType === "image/jpeg" ? "jpg" : asset.mimeType === "image/webp" ? "webp" : "png";
  const target = approved ? `gallery/${gallery.id}.${extension}` : `permanent/${asset.userId}/${asset.id}.${extension}`;
  const source = approved && gallery.objectKey ? gallery.objectKey : asset.originalPath;
  let bytes: Buffer;
  if (asset.storageBackend === "local" && path.isAbsolute(source)) {
    const relative = path.relative(path.resolve(db.dataDir), path.resolve(source));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Asset path escapes data directory");
    bytes = await readFile(source);
  } else {
    bytes = await storage.read(source);
  }
  const existing = await storage.head(target);
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  if (!existing) await storage.put(target, bytes, asset.mimeType);
  if (digest(await storage.read(target)) !== digest(bytes)) throw new Error(`Permanent asset verification failed: ${asset.id}`);
  await db.transaction(async (tx) => {
    const changed = await tx.execute(
      "UPDATE assets SET original_path = ?, storage_backend = ?, expires_at = NULL WHERE id = ? AND original_path = ?",
      [target, storage.backend, asset.id, asset.originalPath]
    );
    if (!changed) throw new Error(`Asset changed during preservation: ${asset.id}`);
    if (approved) {
      const galleryChanged = await tx.execute(
        "UPDATE gallery_items SET object_key = ? WHERE id = ? AND status = 'approved'",
        [target, gallery.id]
      );
      if (!galleryChanged) throw new Error(`Gallery changed during preservation: ${gallery.id}`);
    }
  });
}
