import { z } from "zod";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";

export async function validateGalleryTagIds(db: AppDatabase, tagIds: string[]): Promise<void> {
  const tags = await repo.listAllGalleryTags(db);
  z.object({
    tagIds: z.array(z.string().refine(
      (id) => tags.some((tag) => tag.id === id), "无效画廊标签"
    ))
  }).parse({ tagIds });
}
