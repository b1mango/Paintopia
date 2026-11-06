import type { GalleryTag } from "@paintopia/shared";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { AppDatabase, DatabaseValue } from "../db/database.js";
import { listAllGalleryTags, listGalleryTags } from "../db/repository.js";
import { createMediaEdgeUrl, mediaEdgeClientExpiry } from "../services/mediaEdge.js";

type MediaFeedRow = {
  id: string; user_id: string; prompt: string; created_at: number | string; email: string;
  params_json: string | null; thumb_path: string | null; size_bytes: number;
  gallery_id: string | null; gallery_status: string | null; expires_at: number | string | null;
  asset_id: string; title: string; status: string; rejection_reason: string | null;
  reviewed_at: number | string | null;
};

export function registerMediaFeed(app: FastifyInstance, db: AppDatabase, guard: preHandlerAsyncHookHandler) {
  app.get("/api/media-feed/:kind", { preHandler: guard }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { kind } = z.object({ kind: z.enum(["assets", "gallery"]) }).parse(request.params);
    const query = z.object({
      cursor: z.string().max(300).optional(), search: z.string().max(300).default(""),
      category: z.string().default("all"), limit: z.coerce.number().int().min(1).max(40).default(20)
    }).parse(request.query);
    // Custom tags live in the database; only look them up when a filter or gallery search needs them.
    const allTags = query.category !== "all" || (kind === "gallery" && query.search.trim()) ? await listAllGalleryTags(db) : [];
    z.object({
      category: z.string().refine(
        (value) => value === "all" || allTags.some((tag) => tag.id === value), "无效画廊标签"
      )
    }).parse(query);
    const user = (request as unknown as { user: { id: string; role: string } }).user;
    const table = kind === "assets" ? "assets" : "gallery_items";
    const conditions: string[] = [];
    const values: DatabaseValue[] = [];
    if (kind === "assets") {
      conditions.push("m.user_id = ? AND m.status = 'ready'");
      values.push(user.id);
    } else {
      conditions.push("(m.status = 'approved' OR m.user_id = ? OR ? = 'admin')");
      values.push(user.id, user.role);
    }
    const search = query.search.trim().toLowerCase();
    if (search) {
      const haystack = kind === "assets" ? "LOWER(m.prompt)" : "LOWER(m.title || ' ' || m.prompt)";
      values.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
      const textMatch = `${haystack} LIKE ? ESCAPE '\\'`;
      const matchingTags = kind === "gallery" ? allTags.filter((tag) =>
        [tag.id, tag.label, ...tag.aliases].some((label) => label.toLowerCase().includes(search))
      ).map((tag) => tag.id) : [];
      if (matchingTags.length) {
        conditions.push(`(${textMatch} OR EXISTS (SELECT 1 FROM gallery_item_tags t WHERE t.gallery_item_id = m.id AND t.tag_id IN (${matchingTags.map(() => "?").join(",")})))`);
        values.push(...matchingTags);
      } else conditions.push(textMatch);
    }
    if (query.category !== "all") {
      // Filter before cursor/limit, using reviewed tags only; prompts are not classification evidence.
      const relation = kind === "gallery" ? "t.gallery_item_id = m.id" : "t.gallery_item_id = g.id";
      conditions.push(`EXISTS (SELECT 1 FROM gallery_item_tags t WHERE ${relation} AND t.tag_id = ?)`);
      values.push(query.category);
    }
    if (query.cursor) {
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString()); }
      catch { throw Object.assign(new Error("无效分页游标"), { statusCode: 400 }); }
      const parsed = z.object({ time: z.number().int().nonnegative(), id: z.string().max(80) }).parse(cursor);
      conditions.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
      values.push(parsed.time, parsed.time, parsed.id);
    }
    values.push(query.limit + 1);
    const joins = kind === "assets" ? "LEFT JOIN gallery_items g ON g.asset_id = m.id" : "LEFT JOIN assets a ON a.id = m.asset_id";
    const fields = kind === "assets"
      ? "m.size_bytes,m.params_json,m.expires_at,m.thumb_path,g.id AS gallery_id,g.status AS gallery_status"
      : "m.asset_id,m.title,m.status,m.rejection_reason,m.reviewed_at,a.params_json,a.thumb_path";
    const rows = await db.query<MediaFeedRow>(`SELECT m.id,m.user_id,m.prompt,m.created_at,u.email,${fields}
      FROM ${table} m JOIN users u ON u.id = m.user_id ${joins}
      WHERE ${conditions.join(" AND ")} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`, values);
    const page = rows.slice(0, query.limit);
    const tags = kind === "gallery" ? await listGalleryTags(db, page.map((row) => row.id)) : new Map<string, GalleryTag[]>();
    const curated = kind === "assets" && user.role === "admin" && page.length
      ? await db.query<{ id: string; source_asset_id: string }>("SELECT id,source_asset_id FROM curated_prompts WHERE source_asset_id IN (" + page.map(() => "?").join(",") + ")", page.map(row => row.id)) : [];
    const curatedByAsset = new Map(curated.map(row => [row.source_asset_id, row.id]));
    const now = Date.now();
    const items = page.map((row) => {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(row.params_json ?? "{}"); } catch { /* Legacy metadata may be empty. */ }
      const common = {
        id: row.id, prompt: row.prompt, createdAt: new Date(Number(row.created_at)).toISOString(),
        width: Number(params.actualWidth) || null, height: Number(params.actualHeight) || null,
        thumbnailUrl: `/api/${kind}/${row.id}/thumbnail`,
        thumbnailEdgeUrl: row.thumb_path ? createMediaEdgeUrl(row.thumb_path, now) : null,
        thumbnailEdgeExpiresAt: mediaEdgeClientExpiry(now),
        imageUrl: `/api/${kind}/${row.id}/${kind === "assets" ? "original" : "image"}`
      };
      return kind === "assets" ? {
        ...common, ...(user.role === "admin" ? { curatedPromptId: curatedByAsset.get(row.id) ?? null } : {}), sizeBytes: row.size_bytes, ownerName: row.email.split("@")[0], ownerEmail: row.email,
        params: { actualWidth: common.width, actualHeight: common.height },
        gallerySynced: Boolean(row.gallery_id), galleryItemId: row.gallery_id, galleryStatus: row.gallery_status,
        expiresAt: row.expires_at ? new Date(Number(row.expires_at)).toISOString() : null
      } : {
        ...common, assetId: row.asset_id, userId: row.user_id, title: row.title, status: row.status,
        authorName: row.email.split("@")[0], rejectionReason: row.rejection_reason,
        reviewedAt: row.reviewed_at ? new Date(Number(row.reviewed_at)).toISOString() : null,
        tags: tags.get(row.id) ?? []
      };
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor: rows.length > query.limit && last
        ? Buffer.from(JSON.stringify({ time: Number(last.created_at), id: last.id })).toString("base64url") : null
    };
  });
}
