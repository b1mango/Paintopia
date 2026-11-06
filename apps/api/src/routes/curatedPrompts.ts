import type { CuratedPrompt } from "@paintopia/shared";
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { z } from "zod";
import type { AppDatabase, DatabaseValue } from "../db/database.js";
import { findAsset, writeAuditLog, type AssetRecord } from "../db/repository.js";
import type { AssetStorage } from "../services/assetStorage.js";
import { createImageThumbnail } from "../services/imageThumbnail.js";

import { serializeCuratedPrompt, type CuratedPromptRecord } from "../services/curatedPrompts.js";
const contentSchema = z.object({
  title: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(20000),
  description: z.string().max(500).nullable(), tags: z.array(z.string().trim().min(1).max(20)).max(12)
});
const createSchema = contentSchema.partial().extend({ assetId: z.string().min(1).max(160) }).strict();
const patchSchema = contentSchema.partial().extend({ sortOrder: z.number().int().min(-2147483648).max(2147483647).optional() }).strict();
const idSchema = z.object({ id: z.string().min(1).max(160).regex(/^[\w-]+$/) });
type AdminRequest = FastifyRequest & { user: { id: string } };

function serializeAdmin(row: CuratedPromptRecord): CuratedPrompt {
  const { coverUrl, imageUrl } = serializeCuratedPrompt(row);
  return {
    id: row.id, title: row.title, text: row.text, description: row.description,
    tags: JSON.parse(row.tags) as string[], sortOrder: row.sort_order, sourceAssetId: row.source_asset_id,
    coverUrl: coverUrl!, imageUrl: imageUrl!, width: row.width, height: row.height,
    createdAt: new Date(Number(row.created_at)).toISOString(), updatedAt: new Date(Number(row.updated_at)).toISOString()
  };
}

export function registerCuratedPromptRoutes(app: FastifyInstance, options: {
  db: AppDatabase; storage: AssetStorage; requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler;
  copyAsset: (asset: AssetRecord, key: string) => Promise<void>;
}) {
  const { db, storage, requireAuth, requireAdmin, copyAsset } = options;
  const admin = { preHandler: requireAdmin };
  app.post("/api/admin/curated-prompts", admin, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const asset = await findAsset(db, body.assetId);
    if (!asset) return reply.code(404).send({ error: "资产不存在" });
    if (asset.status !== "ready") return reply.code(409).send({ error: "资产尚未上传完成" });
    if (await db.queryOne("SELECT id FROM curated_prompts WHERE source_asset_id = ?", [asset.id])) {
      return reply.code(409).send({ error: "该作品已在站主推荐中" });
    }
    const text = body.text ?? asset.prompt;
    const content = contentSchema.parse({ title: body.title ?? Array.from(text).slice(0, 24).join(""), text, description: body.description ?? null, tags: body.tags ?? [] });
    const id = nanoid();
    const extension = asset.mimeType === "image/jpeg" ? "jpg" : asset.mimeType === "image/webp" ? "webp" : "png";
    // Separate permanent originals and thumbnails survive personal-asset expiration/deletion.
    const objectKey = "permanent/curated/" + id + "." + extension;
    const thumbKey = "permanent/curated/" + id + "-thumb.webp";
    let committed = false;
    try {
      await copyAsset(asset, objectKey);
      const bytes = await storage.read(objectKey);
      const metadata = await sharp(bytes).metadata();
      const thumbnail = await createImageThumbnail(bytes);
      await storage.put(thumbKey, thumbnail, "image/webp");
      const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
      const now = Date.now();
      const row: CuratedPromptRecord = {
        id, ...content, description: content.description ?? null, tags: JSON.stringify([...new Set(content.tags)]), object_key: objectKey, thumb_key: thumbKey,
        mime_type: asset.mimeType, width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height,
        sort_order: 0, source_asset_id: asset.id, created_by: (request as AdminRequest).user.id, created_at: now, updated_at: now
      };
      const changed = await db.transaction(async tx => {
        const ready = await tx.execute("UPDATE assets SET status = status WHERE id = ? AND status = 'ready'", [asset.id]);
        if (!ready) return false;
        const inserted = await tx.execute("INSERT INTO curated_prompts (id,title,text,description,tags,object_key,thumb_key,mime_type,width,height,sort_order,source_asset_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_asset_id) DO NOTHING",
          [id, row.title, row.text, row.description, row.tags, objectKey, thumbKey, row.mime_type, row.width, row.height, 0, asset.id, row.created_by, now, now]);
        if (!inserted) return false;
        await writeAuditLog(tx, { actorUserId: row.created_by, action: "curated_prompt.create", targetType: "curated_prompt", targetId: id, detail: { assetId: asset.id } });
        return true;
      });
      if (!changed) return reply.code(409).send({ error: "该作品已在站主推荐中或已删除，请刷新列表" });
      committed = true;
      return reply.code(201).send(serializeAdmin(row));
    } finally {
      if (!committed) await Promise.all([storage.delete(objectKey), storage.delete(thumbKey)]);
    }
  });
  app.patch("/api/admin/curated-prompts/:id", admin, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const body = patchSchema.parse(request.body);
    const fields: string[] = [], values: DatabaseValue[] = [];
    for (const key of ["title", "text", "description", "tags", "sortOrder"] as const) {
      if (body[key] === undefined) continue;
      fields.push((key === "sortOrder" ? "sort_order" : key) + " = ?");
      values.push(key === "tags" ? JSON.stringify([...new Set(body.tags!)]) : body[key] as DatabaseValue);
    }
    fields.push("updated_at = ?"); values.push(Date.now(), id);
    const row = await db.transaction(async tx => {
      const updated = await tx.queryOne<CuratedPromptRecord>("UPDATE curated_prompts SET " + fields.join(", ") + " WHERE id = ? RETURNING *", values);
      if (updated) await writeAuditLog(tx, { actorUserId: (request as AdminRequest).user.id, action: "curated_prompt.update", targetType: "curated_prompt", targetId: id, detail: { fields: Object.keys(body) } });
      return updated;
    });
    if (!row) return reply.code(404).send({ error: "推荐提示词不存在" });
    return serializeAdmin(row);
  });
  app.delete("/api/admin/curated-prompts/:id", admin, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const deleted = await db.transaction(async tx => {
      const row = await tx.queryOne<CuratedPromptRecord>("DELETE FROM curated_prompts WHERE id = ? RETURNING *", [id]);
      if (!row) return false;
      // Keep the record retryable when object deletion fails; a retry may delete an already-missing object.
      await Promise.all([storage.delete(row.object_key), storage.delete(row.thumb_key)]);
      await tx.execute("DELETE FROM sourced_prompt_favorites WHERE prompt_id = ?", ["paintopia-curated:" + id]);
      await writeAuditLog(tx, { actorUserId: (request as AdminRequest).user.id, action: "curated_prompt.delete", targetType: "curated_prompt", targetId: id });
      return true;
    });
    return deleted ? reply.code(204).send() : reply.code(404).send({ error: "推荐提示词不存在" });
  });
  for (const kind of ["image", "thumbnail"] as const) {
    app.get("/api/curated-prompts/:id/" + kind, { preHandler: requireAuth }, async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const row = await db.queryOne<CuratedPromptRecord>("SELECT * FROM curated_prompts WHERE id = ?", [id]);
      if (!row) return reply.code(404).send({ error: "推荐提示词不存在" });
      const key = kind === "image" ? row.object_key : row.thumb_key;
      // Origin fallback intentionally avoids redirecting back to the edge that may have failed.
      const url = await storage.createDownloadUrl(key, 300);
      if (url) return reply.header("Cache-Control", "private, no-store").redirect(url);
      return reply.header("Cache-Control", "private, max-age=60").type(kind === "image" ? row.mime_type : "image/webp").send(await storage.read(key));
    });
  }
}
