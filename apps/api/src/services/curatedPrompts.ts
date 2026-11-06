import type { SourcedPrompt } from "@paintopia/shared";
import type { AppDatabase } from "../db/database.js";
import { createMediaEdgeUrl } from "./mediaEdge.js";

export type CuratedPromptRecord = {
  id: string; title: string; text: string; description: string | null; tags: string;
  object_key: string; thumb_key: string; mime_type: string; width: number; height: number;
  sort_order: number; source_asset_id: string | null; created_by: string | null;
  created_at: number | string; updated_at: number | string;
};
export function serializeCuratedPrompt(row: CuratedPromptRecord, now = Date.now()): SourcedPrompt {
  const base = "/api/curated-prompts/" + row.id;
  return {
    id: "paintopia-curated:" + row.id, sourceId: "paintopia-curated", title: row.title, text: row.text,
    description: row.description ?? "", tags: JSON.parse(row.tags) as string[], author: "绘境", sourceUrl: "",
    coverUrl: createMediaEdgeUrl(row.thumb_key, now) ?? base + "/thumbnail",
    imageUrl: createMediaEdgeUrl(row.object_key, now) ?? base + "/image",
    width: row.width, height: row.height, model: "gpt-image-2", favorite: false
  };
}
export async function listCuratedPrompts(db: AppDatabase): Promise<SourcedPrompt[]> {
  const rows = await db.query<CuratedPromptRecord>("SELECT * FROM curated_prompts ORDER BY sort_order DESC, created_at DESC, id DESC");
  const now = Date.now();
  return rows.map(row => serializeCuratedPrompt(row, now));
}
export async function findCuratedPrompt(db: AppDatabase, id: string): Promise<SourcedPrompt | undefined> {
  const row = await db.queryOne<CuratedPromptRecord>("SELECT * FROM curated_prompts WHERE id = ?", [id]);
  return row && serializeCuratedPrompt(row);
}
