const DEFAULT_PROHIBITED_TERMS = [
  "child pornography",
  "child porn",
  "csam",
  "sexualize a minor",
  "nude child",
  "儿童色情",
  "兒童色情",
  "未成年色情",
  "未成年裸照",
  "幼童裸照",
  "幼女裸照",
  "rape pornography",
  "迷奸",
  "强奸色情",
  "強奸色情",
  "bestiality",
  "兽交",
  "獸交",
  "bomb making instructions",
  "build a bomb",
  "制作炸弹",
  "炸弹制作教程",
  "自制炸药",
  "meth synthesis",
  "制作毒品",
  "合成冰毒",
  "forge identity document",
  "fake passport",
  "伪造身份证",
  "偽造身份證"
] as const;

export type ContentSafetyMatcher = {
  findMatch: (values: string[]) => string | null;
};

export function createContentSafetyMatcher(extraTerms: string[] = []): ContentSafetyMatcher {
  const terms = Array.from(new Set([...DEFAULT_PROHIBITED_TERMS, ...extraTerms]
    .map((term) => term.trim())
    .filter(Boolean)))
    .map((term) => ({ raw: term, normalized: normalizeForMatching(term) }))
    .filter((term) => term.normalized.length > 0);

  return {
    findMatch(values) {
      for (const value of values) {
        const normalizedValue = normalizeForMatching(value);
        const match = terms.find((term) => normalizedValue.includes(term.normalized));
        if (match) return match.raw;
      }
      return null;
    }
  };
}

export function parseProhibitedTerms(value: string | undefined): string[] {
  return String(value ?? "")
    .split(/[\n,]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function normalizeForMatching(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{Cf}\p{P}\p{S}\p{Z}\s_]+/gu, "");
}
