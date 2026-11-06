import { describe, expect, it } from "vitest";
import { filterPrompts } from "../src/promptLibrary";
import { CURATED_PROMPT_LIBRARY } from "../src/curatedPrompts";

const prompts = [
  {
    id: "p1",
    zh: "雾中山谷",
    en: "misty valley",
    category: "landscape",
    tags: ["cinematic", "warm"],
    favorite: true
  },
  {
    id: "p2",
    zh: "赛博城市",
    en: "cyber city",
    category: "city",
    tags: ["neon", "night"],
    favorite: false
  }
];

describe("filterPrompts", () => {
  it("filters by keyword across Chinese, English, category, and tags", () => {
    expect(filterPrompts(prompts, { query: "雾" }).map((prompt) => prompt.id)).toEqual(["p1"]);
    expect(filterPrompts(prompts, { query: "cyber" }).map((prompt) => prompt.id)).toEqual(["p2"]);
    expect(filterPrompts(prompts, { query: "neon" }).map((prompt) => prompt.id)).toEqual(["p2"]);
  });

  it("combines category, tag, and favorite filters", () => {
    const result = filterPrompts(prompts, {
      category: "landscape",
      tags: ["warm"],
      favoritesOnly: true
    });

    expect(result.map((prompt) => prompt.id)).toEqual(["p1"]);
  });
});

describe("curated prompt library", () => {
  it("ships no synthetic runtime seeds after source-backed library integration", () => {
    expect(CURATED_PROMPT_LIBRARY).toEqual([]);
  });
});
