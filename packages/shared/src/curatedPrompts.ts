/** Legacy type retained; verified public sources replace synthetic startup seeds. */
export type CuratedPromptSeed = {
  id: string;
  zh: string;
  en: string;
  category: string;
  tags: string[];
};

/** Existing database rows are preserved; no new synthetic seeds are inserted. */
export const CURATED_PROMPT_LIBRARY: CuratedPromptSeed[] = [];

export type CuratedPrompt = {
  id: string; title: string; text: string; description: string | null; tags: string[];
  sortOrder: number; sourceAssetId: string | null;
  coverUrl: string; imageUrl: string; width: number; height: number;
  createdAt: string; updatedAt: string;
};

export type CreateCuratedPromptRequest = {
  assetId: string; title?: string; text?: string; description?: string | null; tags?: string[];
};
export type UpdateCuratedPromptRequest = Partial<Pick<CuratedPrompt, "title" | "text" | "description" | "tags" | "sortOrder">>;
