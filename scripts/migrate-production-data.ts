import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAppDatabase, type AppDatabase, type DatabaseExecutor, type DatabaseValue } from "../apps/api/src/db/database";
import { loadConfig } from "../apps/api/src/config/env";
import { createAssetStorage } from "../apps/api/src/services/assetStorage";
import { createProviderSecretCodec } from "../apps/api/src/services/providerSecrets";
import { personalAssetExpiry, personalAssetKey, resolveAssetRetentionPolicy } from "../apps/api/src/services/assetRetention";

type Row = Record<string, DatabaseValue>;

const config = loadConfig();
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
if (!config.r2) throw new Error("PAINTOPIA_R2_ACCOUNT_ID, access keys, and bucket are required");
if (!config.providerEncryptionKey) throw new Error("PAINTOPIA_PROVIDER_ENCRYPTION_KEY is required");

const source = await createAppDatabase({
  dataDir: config.dataDir,
  bootstrapEmail: config.bootstrapEmail,
  bootstrapPassword: config.bootstrapPassword,
  skipBootstrap: true
});
const target = await createAppDatabase({
  dataDir: config.dataDir,
  databaseUrl: config.databaseUrl,
  bootstrapEmail: config.bootstrapEmail,
  bootstrapPassword: config.bootstrapPassword,
  skipBootstrap: true
});
const sourceStorage = createAssetStorage(config.dataDir);
const targetStorage = createAssetStorage(config.dataDir, config.r2);
const providerSecrets = createProviderSecretCodec(config.providerEncryptionKey);

try {
  await migrateRows(source, target, "users", [
    "id", "email", "password_hash", "role", "status", "quota", "created_at", "updated_at"
  ], ["id"]);
  await migrateRows(source, target, "user_preferences", [
    "user_id", "theme", "language", "reduce_motion", "default_image_model", "default_size", "updated_at"
  ], ["user_id"]);
  await migrateRows(source, target, "invite_codes", [
    "id", "code", "status", "created_by", "used_by", "created_at", "used_at", "destroyed_at"
  ], ["id"]);
  await migrateRows(source, target, "provider_configs", [
    "id", "kind", "name", "base_url", "api_key", "model", "mode", "max_concurrency",
    "enabled", "sort_order", "created_at", "updated_at"
  ], ["id"], (row) => ({
    ...row,
    api_key: providerSecrets.encrypt(String(row.api_key ?? ""))
  }));
  await migrateRows(source, target, "prompt_templates", [
    "id", "name", "type", "target_model", "content", "created_at", "updated_at"
  ], ["id"]);
  await migrateRows(source, target, "generation_jobs", [
    "id", "user_id", "provider_id", "status", "prompt", "params_json", "error", "created_at", "updated_at"
  ], ["id"]);
  await migrateRows(source, target, "text_tool_runs", [
    "id", "user_id", "provider_id", "type", "status", "prompt_tokens", "completion_tokens",
    "total_tokens", "duration_ms", "error", "created_at"
  ], ["id"]);
  await migrateRows(source, target, "prompts", [
    "id", "user_id", "zh", "en", "category", "created_at", "updated_at"
  ], ["id"]);
  await migrateRows(source, target, "prompt_tags", ["id", "name"], ["id"]);
  await migrateRows(source, target, "prompt_prompt_tags", ["prompt_id", "tag_id"], ["prompt_id", "tag_id"]);
  await migrateRows(source, target, "prompt_favorites", [
    "user_id", "prompt_id", "created_at"
  ], ["user_id", "prompt_id"]);
  await migrateRows(source, target, "usage_ledger", [
    "id", "user_id", "action", "amount", "note", "created_at"
  ], ["id"]);
  await migrateRows(source, target, "quota_pricing_rules", [
    "key", "label", "amount", "updated_at"
  ], ["key"]);

  const galleryRows = await source.query<Row>("SELECT * FROM gallery_items");
  const galleryTagRows = await source.query<{ gallery_item_id: string; tag_id: string }>("SELECT gallery_item_id, tag_id FROM gallery_item_tags");
  const galleryTagIds = new Map<string, string[]>();
  for (const row of galleryTagRows) {
    const tags = galleryTagIds.get(row.gallery_item_id) ?? [];
    tags.push(row.tag_id);
    galleryTagIds.set(row.gallery_item_id, tags);
  }
  const galleryByAsset = new Map(galleryRows.map((row) => [String(row.asset_id), row]));
  const galleryObjectKeys = new Map<string, string>();
  const assetRows = await source.query<Row>("SELECT * FROM assets ORDER BY created_at, id");
  const retention = await resolveAssetRetentionPolicy(source, config.ownerEmail, config.assetRetentionDays);
  let uploadedAssets = 0;

  for (const sourceAsset of assetRows) {
    const bytes = await readSourceAsset(source, sourceStorage, sourceAsset);
    const mimeType = detectMimeType(bytes, String(sourceAsset.mime_type ?? ""));
    const extension = extensionForMime(mimeType);
    const assetId = String(sourceAsset.id);
    const userId = String(sourceAsset.user_id);
    const gallery = galleryByAsset.get(assetId);
    const approved = gallery?.status === "approved" || gallery?.status === "published";
    const pending = gallery?.status === "pending" || gallery?.status === "draft";
    const objectKey = approved
      ? `gallery/${String(gallery.id)}.${extension}`
      : personalAssetKey(retention, userId, assetId, mimeType);
    if (approved) galleryObjectKeys.set(assetId, objectKey);
    if (pending) {
      const pendingKey = `pending/${userId}/${String(gallery.id)}.${extension}`;
      await targetStorage.put(pendingKey, bytes, mimeType);
      galleryObjectKeys.set(assetId, pendingKey);
    }
    await targetStorage.put(objectKey, bytes, mimeType);

    const expiresAt = approved ? null : personalAssetExpiry(retention, userId, new Date())?.getTime() ?? null;
    await upsert(target, "assets", [
      "id", "user_id", "job_id", "original_path", "thumb_path", "storage_backend",
      "mime_type", "size_bytes", "status", "expires_at", "prompt", "params_json", "created_at"
    ], ["id"], {
      ...sourceAsset,
      original_path: objectKey,
      thumb_path: null,
      storage_backend: "r2",
      mime_type: mimeType,
      size_bytes: bytes.length,
      status: "ready",
      expires_at: expiresAt
    });
    uploadedAssets += 1;
  }

  for (const gallery of galleryRows) {
    const objectKey = galleryObjectKeys.get(String(gallery.asset_id)) ?? null;
    const status = gallery.status === "approved" || gallery.status === "published" ? "approved"
      : gallery.status === "pending" || gallery.status === "draft" ? "pending" : "rejected";
    await target.transaction(async (tx) => {
      await upsert(tx, "gallery_items", [
        "id", "asset_id", "user_id", "title", "prompt", "status", "object_key",
        "reviewed_by", "reviewed_at", "rejection_reason", "created_at"
      ], ["id"], {
        ...gallery,
        status,
        object_key: objectKey,
        reviewed_by: gallery.reviewed_by ?? null,
        reviewed_at: gallery.reviewed_at ?? null,
        rejection_reason: gallery.rejection_reason ?? null
      });
      await tx.execute("DELETE FROM gallery_item_tags WHERE gallery_item_id = ?", [gallery.id]);
      for (const tagId of galleryTagIds.get(String(gallery.id)) ?? []) {
        await tx.execute("INSERT INTO gallery_item_tags (gallery_item_id, tag_id) VALUES (?, ?)", [gallery.id, tagId]);
      }
    });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    users: Number((await target.queryOne<{ count: number | string }>("SELECT COUNT(*) AS count FROM users"))?.count ?? 0),
    assets: uploadedAssets,
    gallery: galleryRows.length,
    galleryTags: galleryTagRows.length,
    sessionsMigrated: 0
  }, null, 2) + "\n");
} finally {
  await source.close();
  await target.close();
}

async function migrateRows(
  sourceDb: AppDatabase,
  targetDb: AppDatabase,
  table: string,
  columns: string[],
  conflictColumns: string[],
  transform: (row: Row) => Row = (row) => row
) {
  const rows = await sourceDb.query<Row>(`SELECT ${columns.join(", ")} FROM ${table}`);
  for (const row of rows) {
    await upsert(targetDb, table, columns, conflictColumns, transform(row));
  }
}

async function upsert(
  database: DatabaseExecutor,
  table: string,
  columns: string[],
  conflictColumns: string[],
  row: Row
) {
  const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
  const conflictAction = updateColumns.length
    ? `DO UPDATE SET ${updateColumns.map((column) => `${column} = excluded.${column}`).join(", ")}`
    : "DO NOTHING";
  await database.execute(`
    INSERT INTO ${table} (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
    ON CONFLICT(${conflictColumns.join(", ")}) ${conflictAction}
  `, columns.map((column) => row[column] ?? null));
}

async function readSourceAsset(
  sourceDb: AppDatabase,
  sourceStorage: ReturnType<typeof createAssetStorage>,
  row: Row
) {
  const sourcePath = String(row.original_path);
  if (path.isAbsolute(sourcePath)) {
    const resolvedDataDir = path.resolve(sourceDb.dataDir);
    const resolvedPath = path.resolve(sourcePath);
    const relativePath = path.relative(resolvedDataDir, resolvedPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Asset path escapes data directory: ${sourcePath}`);
    }
    return readFile(resolvedPath);
  }
  return sourceStorage.read(sourcePath);
}

function detectMimeType(bytes: Buffer, storedMimeType: string) {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (storedMimeType.startsWith("image/")) return storedMimeType;
  return "image/png";
}

function extensionForMime(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}
