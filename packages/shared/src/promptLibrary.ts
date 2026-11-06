export type PromptLibraryItem = {
  id: string;
  zh: string;
  en: string;
  category: string;
  tags: string[];
  favorite: boolean;
};

export type PromptSource = {
  id: string; name: string; homepage: string; feedUrl: string;
  license: string; licenseUrl: string; aggregatorUrl: string; aggregatorLicenseUrl: string;
  model: string; compatibilityNote: string;
};

export type SourcedPrompt = {
  id: string; sourceId: string; title: string; text: string; description: string;
  tags: string[]; author: string; sourceUrl: string; coverUrl?: string;
  model: string; favorite: boolean;
  imageUrl?: string; width?: number; height?: number;
};

export type PromptSourceError = { sourceId: string; message: string };

export type PromptLibraryResponse = {
  items: SourcedPrompt[]; sources: (PromptSource & { count: number })[]; fetchedAt: string | null;
  total: number; offset: number; limit: number;
  tags: { tag: string; count: number }[];
  sourceErrors: PromptSourceError[];
  /** A usable snapshot is due for revalidation; this is not a source failure. */
  refreshNeeded: boolean;
};

export type PromptFilter = {
  query?: string;
  category?: string;
  tags?: string[];
  favoritesOnly?: boolean;
};

export function filterPrompts<TPrompt extends PromptLibraryItem>(
  prompts: TPrompt[],
  filter: PromptFilter
): TPrompt[] {
  const query = normalize(filter.query);
  const requiredTags = filter.tags?.map(normalize).filter(Boolean) ?? [];

  return prompts.filter((prompt) => {
    if (filter.favoritesOnly && !prompt.favorite) {
      return false;
    }

    if (filter.category && prompt.category !== filter.category) {
      return false;
    }

    const promptTags = prompt.tags.map(normalize);
    if (requiredTags.some((tag) => !promptTags.includes(tag))) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      prompt.zh,
      prompt.en,
      prompt.category,
      ...prompt.tags
    ]
      .map(normalize)
      .join(" ");

    return haystack.includes(query);
  });
}

function normalize(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}
