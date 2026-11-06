import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";

export async function listPrompts(appDb: AppDatabase) {
  return (await repo.listPrompts(appDb)).map((prompt) => ({
    id: prompt.id,
    zh: prompt.zh,
    en: prompt.en,
    category: prompt.category,
    tags: prompt.tags,
    favorite: false,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt
  }));
}
