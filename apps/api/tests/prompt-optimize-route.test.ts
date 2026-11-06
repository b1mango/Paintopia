import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_PROMPT_TEMPLATES } from "@paintopia/shared";
import type { AppDatabase } from "../src/db/database.js";
import { createServer } from "../src/createServer.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  vi.unstubAllGlobals();
});

async function createLoggedInApp(fetchText: string | string[], providerConfigured = true) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-api-"));
  tempDirs.push(dataDir);

  const responses = Array.isArray(fetchText) ? [...fetchText] : [fetchText];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    choices: [
      {
        message: {
          content: responses.shift()
        }
      }
    ]
  }), { status: 200 })));

  const app = await createServer({
    dataDir,
    bootstrapEmail: "admin@paintopia.local",
    bootstrapPassword: "paintopia123",
    webOrigin: "http://localhost:5173",
    sessionSecret: "test-secret",
    defaultTextProvider: providerConfigured ? {
      name: "Translation",
      baseUrl: "https://new-api.example",
      apiKey: "test-key",
      model: "Translation",
      mode: "chat_completions"
    } : undefined
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "admin@paintopia.local",
      password: "paintopia123"
    }
  });

  return {
    app,
    cookie: Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : String(login.headers["set-cookie"])
  };
}

describe("prompt optimization route", () => {
  it.each([
    ["zh", "in Chinese natural language"],
    ["en", "in English natural language"],
    [undefined, "in the user's language"]
  ])("renders the default template then appends fixed rules for %s", async (outputLanguage, instruction) => {
    const { app, cookie } = await createLoggedInApp(["A lake.", "A lake."]);
    const headers = { cookie };
    try {
      const created = await app.inject({ method: "POST", url: "/api/admin/templates", headers, payload: {
        name: "Custom", targetModel: "another-model", content: "Custom {{target_image_model}} / {{style_constraints}} / {{input_prompt}}"
      } });
      expect(created.statusCode).toBe(201);
      const payload = { inputPrompt: "湖面", targetModel: "test-model", styleConstraints: "watercolor", outputLanguage };
      const before = await app.inject({ method: "POST", url: "/api/prompt-tools/optimize", headers, payload });
      expect(before.json().systemPrompt).toContain("专业图像提示词优化器");
      expect(before.json().systemPrompt).not.toContain("Custom");
      expect((await app.inject({ method: "POST", url: `/api/admin/templates/${created.json().id}/default`, headers })).statusCode).toBe(200);
      const after = await app.inject({ method: "POST", url: "/api/prompt-tools/optimize", headers, payload });
      expect(after.statusCode).toBe(200);
      expect(after.json().systemPrompt).toMatch(/^Custom test-model \/ watercolor \/ 湖面\n/);
      expect(after.json().systemPrompt).toContain(instruction);
      expect(after.json().systemPrompt).toMatch(/只输出一条可直接使用的图像提示词，不要标题、解释、多个版本、Markdown、权重或正负向分组。$/);
      const upstream = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
      expect(upstream.messages[0].content).toBe(after.json().systemPrompt);
    } finally { await app.close(); }
  });

  it("lists template names for signed-in users and optimizes with the chosen template", async () => {
    const { app, cookie } = await createLoggedInApp(["A lake.", "A lake."]);
    const headers = { cookie };
    try {
      const created = await app.inject({ method: "POST", url: "/api/admin/templates", headers, payload: { name: "Chosen", content: "Chosen rules for {{input_prompt}}" } });
      const list = await app.inject({ method: "GET", url: "/api/prompt-tools/templates", headers });
      expect(list.statusCode).toBe(200);
      expect(list.json()[0]).toEqual({ id: "optimize", name: "通用优化", isDefault: true });
      expect(list.json()).toContainEqual({ id: created.json().id, name: "Chosen", isDefault: false });
      expect(JSON.stringify(list.json())).not.toContain("rules");
      const chosen = await app.inject({ method: "POST", url: "/api/prompt-tools/optimize", headers, payload: { inputPrompt: "湖面", outputLanguage: "zh", templateId: created.json().id } });
      expect(chosen.json().systemPrompt).toMatch(/^Chosen rules for 湖面\n/);
      const missing = await app.inject({ method: "POST", url: "/api/prompt-tools/optimize", headers, payload: { inputPrompt: "湖面", outputLanguage: "zh", templateId: "gone" } });
      expect(missing.json().systemPrompt).toContain("专业图像提示词优化器");
    } finally { await app.close(); }
  });

  it("uses the built-in optimizer when no templates exist", async () => {
    const { app, cookie } = await createLoggedInApp("A lake.");
    try {
      const db = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
      await db.execute("DELETE FROM prompt_templates");
      const response = await app.inject({ method: "POST", url: "/api/prompt-tools/optimize", headers: { cookie }, payload: { inputPrompt: "湖面", outputLanguage: "en" } });
      expect(response.statusCode).toBe(200);
      expect(response.json().systemPrompt).toContain(BUILT_IN_PROMPT_TEMPLATES[0].content.split("\n")[1]);
      expect(response.json().systemPrompt).toContain("in English natural language");
    } finally { await app.close(); }
  });

  it("returns a single natural-language prompt without inventing negative prompts", async () => {
    const modelOutput = [
      "好的，我们来优化这个水墨山水画的图像提示。",
      "",
      "**核心要素分析:**",
      "1. **水墨山水画:** 这是风格和媒介，权重最高。",
      "2. **飞鸟:** 点景元素，增加生机。",
      "",
      "**优化后的提示:**",
      "",
      "```",
      "Ink wash landscape painting, Chinese style, focusing on artistic conception and mood. Features a vast water surface, distant rolling mountains, a few flying birds, minimalist composition, traditional Chinese artistic brushwork, monochrome, atmospheric, serene, high detail.",
      "```",
      "",
      "**元素权重解释:**",
      "这些是风格细节和输出要求。",
      "",
      "**关键点:**",
      "你可以根据需要调整这些提示。"
    ].join("\n");
    const { app, cookie } = await createLoggedInApp(modelOutput);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/prompt-tools/optimize",
        headers: { cookie },
        payload: {
          inputPrompt: "一副水墨山水画，国风，注重意境，有飞鸟，广阔的水面，远处连绵的群山等元素",
          targetModel: "Stable Diffusion",
          negativePromptRules: "low quality, blurry, watermark, text"
        }
      });

      expect(response.statusCode).toBe(200);
      const text = response.json().text as string;
      const nonEmptyLines = text.split("\n").filter(Boolean);
      expect(nonEmptyLines).toHaveLength(1);
      expect(text).not.toContain("正向提示词");
      expect(text).not.toContain("负向提示词");
      expect(text).toContain("Ink wash landscape painting");
      expect(text).toContain("vast water surface");
      expect(text).toContain("distant rolling mountains");
      expect(text).toContain("flying birds");
      expect(text).not.toContain("low quality");
      const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
      expect(request.messages[0].content).toContain("使用自然语言明确视觉描述");
      expect(request.messages[0].content).toContain("in the user's language");
      expect(request.messages[0].content).toContain("不使用权重，不拆分正向与负向提示词");
      expect(text).not.toContain("好的");
      expect(text).not.toContain("核心要素分析");
      expect(text).not.toContain("元素权重解释");
      expect(text).not.toContain("关键点");
      expect(text).not.toContain("版本一");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    { outputLanguage: "zh", inputPrompt: "A bird over a lake.", text: "一只飞鸟掠过平静的湖面，远山笼罩在柔和的晨光中。", instruction: "in Chinese natural language" },
    { outputLanguage: "en", inputPrompt: "飞鸟掠过湖面。", text: "A bird flies over a tranquil lake with distant mountains in soft morning light.", instruction: "in English natural language" }
  ])("requests $outputLanguage output while preserving a single natural-language prompt", async ({ outputLanguage, inputPrompt, text, instruction }) => {
    const { app, cookie } = await createLoggedInApp(text);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/prompt-tools/optimize",
        headers: { cookie },
        payload: { inputPrompt, outputLanguage }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().text).toBe(text);
      expect(fetch).toHaveBeenCalledTimes(1);
      const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
      expect(request.messages[0].content).toContain(instruction);
      expect(request.messages[0].content).toContain("exactly one");
      expect(request.messages[0].content).toContain("no headings, explanation, alternatives or markdown");
      expect(request.messages[0].content).toContain("不使用权重，不拆分正向与负向提示词");
      expect(request.messages[0].content).not.toContain("in the user's language");
      expect(request.messages[1].content).toBe(inputPrompt);
      expect(response.json().systemPrompt).toBe(request.messages[0].content);
      if (outputLanguage === "en") {
        expect(request.messages[0].content).toContain("No Chinese, Japanese, or Korean characters may remain");
      }
    } finally {
      await app.close();
    }
  });

  it("repairs English output with residual CJK while preserving complete sentences", async () => {
    const mixedText = "A bird flies over a 湖面 with distant mountains in soft morning light.";
    const repairedText = "A bird flies over a tranquil lake with distant mountains in soft morning light.";
    const { app, cookie } = await createLoggedInApp([mixedText, repairedText]);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/prompt-tools/optimize",
        headers: { cookie },
        payload: { inputPrompt: "飞鸟掠过湖面。", outputLanguage: "en" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().text).toBe(repairedText);
      expect(fetch).toHaveBeenCalledTimes(2);
      const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
      const repair = JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body));
      expect(repair.messages[1].content).toBe(mixedText);
      expect(repair.messages[0].content).toContain("Preserve complete sentences, not comma-separated prompt fragments");
      expect(repair.messages[0].content).toContain("Do not leave any Chinese, Japanese, or Korean characters");
      expect(response.json().systemPrompt).toBe(`${request.messages[0].content}\n\n--- Optimization repair ---\n${repair.messages[0].content}`);
    } finally {
      await app.close();
    }
  });

  it("attempts English repair only once even if CJK remains", async () => {
    const { app, cookie } = await createLoggedInApp(["A bird over 湖面.", "A bird over a 湖面."]);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/prompt-tools/optimize",
        headers: { cookie },
        payload: { inputPrompt: "飞鸟掠过湖面。", outputLanguage: "en" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().text).toBe("A bird over a 湖面.");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("keeps the input language without repair when outputLanguage is omitted", async () => {
    const text = "一只飞鸟掠过平静的湖面。";
    const { app, cookie } = await createLoggedInApp(text);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/prompt-tools/optimize",
        headers: { cookie },
        payload: { inputPrompt: "飞鸟掠过湖面。" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().text).toBe(text);
      expect(response.json().systemPrompt).toContain("in the user's language");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it.each(["fr", "auto", null])("rejects invalid outputLanguage %s before calling the provider", async (outputLanguage) => {
    const { app, cookie } = await createLoggedInApp("Unused output.");

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/prompt-tools/optimize",
        headers: { cookie },
        payload: { inputPrompt: "飞鸟掠过湖面。", outputLanguage }
      });

      expect(response.statusCode).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([undefined, "zh", "en"])("preserves the unconfigured-provider fallback for outputLanguage %s", async (outputLanguage) => {
    const { app, cookie } = await createLoggedInApp("Unused output.", false);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/prompt-tools/optimize",
        headers: { cookie },
        payload: { inputPrompt: "飞鸟掠过湖面。", targetModel: "中文模型", outputLanguage }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        providerConfigured: false,
        text: "Optimized 中文模型 prompt will appear here after a text Provider is configured."
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
