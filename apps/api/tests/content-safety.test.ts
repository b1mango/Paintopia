import { describe, expect, it } from "vitest";
import { createContentSafetyMatcher, parseProhibitedTerms } from "../src/services/contentSafety.js";

describe("content safety matching", () => {
  it("matches prohibited terms after punctuation, spacing, and invisible characters are removed", () => {
    const matcher = createContentSafetyMatcher();

    expect(matcher.findMatch(["儿 童-\u200B色 情内容"])).toBe("儿童色情");
    expect(matcher.findMatch(["instructions to b.u.i.l.d a b_o_m_b"])).toBe("build a bomb");
  });

  it("supports deployment-specific terms without blocking unrelated prompts", () => {
    const matcher = createContentSafetyMatcher(parseProhibitedTerms("custom banned,second-term"));

    expect(matcher.findMatch(["CUSTOM---BANNED"])).toBe("custom banned");
    expect(matcher.findMatch(["a peaceful watercolor landscape"])).toBeNull();
  });
});
