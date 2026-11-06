import { describe, expect, it } from "vitest";
import { renderPromptTemplate } from "../src/template";

describe("renderPromptTemplate", () => {
  it("replaces known template variables and removes unknown variables", () => {
    const rendered = renderPromptTemplate(
      "Write for {{target_image_model}}: {{input_prompt}} {{missing_value}}",
      {
        target_image_model: "GPT Image 2",
        input_prompt: "一座雾中的山谷"
      }
    );

    expect(rendered).toBe("Write for GPT Image 2: 一座雾中的山谷");
  });

  it("normalizes extra whitespace left by template replacement", () => {
    const rendered = renderPromptTemplate(
      "  {{input_prompt}}\n\n{{style_constraints}}   ",
      {
        input_prompt: "cinematic landscape",
        style_constraints: "warm dusk light"
      }
    );

    expect(rendered).toBe("cinematic landscape\nwarm dusk light");
  });
});
