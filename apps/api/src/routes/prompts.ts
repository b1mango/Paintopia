import { BUILT_IN_PROMPT_TEMPLATES, renderPromptTemplate } from "@paintopia/shared";
import { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import * as repo from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import { listPrompts } from "../services/prompts.js";
import { containsCjk, formatOptimizedPrompt, runTextTool } from "../services/textTools.js";
import { allowUserAction, AuthedRequest } from "./authHelpers.js";
import { CONTENT_MUTATION_RATE_LIMIT, optimizePromptSchema, promptSchema, TEXT_TOOL_RATE_LIMIT } from "./schemas.js";

export function registerPromptsRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb, secrets: providerSecrets, contentSafety } = ctx;
  app.get("/api/prompts", { preHandler: ctx.requireAuth }, async () => {
    return listPrompts(appDb);
  });

  app.post("/api/prompts", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!await allowUserAction(appDb, request, reply, "prompt-create", CONTENT_MUTATION_RATE_LIMIT)) return;
    const body = promptSchema.parse(request.body);
    if (contentSafety.findMatch([body.zh, body.en, body.category, ...body.tags])) {
      return reply.code(422).send({ error: "内容包含不允许的词语，请修改后重试" });
    }
    const now = new Date();
    const id = nanoid();
    await repo.insertPrompt(appDb, {
      id,
      userId: user.id,
      zh: body.zh,
      en: body.en,
      category: body.category,
      createdAt: now,
      updatedAt: now
    }, body.tags);
    return reply.code(201).send((await listPrompts(appDb)).find((prompt) => prompt.id === id));
  });

  app.get("/api/prompt-tools/templates", { preHandler: ctx.requireAuth }, async () => {
    return (await repo.listTemplates(appDb)).map(({ id, name, isDefault }) => ({ id, name, isDefault }));
  });

  app.post("/api/prompt-tools/optimize", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!await allowUserAction(appDb, request, reply, "prompt-tool", TEXT_TOOL_RATE_LIMIT)) return;
    const body = optimizePromptSchema.parse(request.body);
    if (contentSafety.findMatch([body.inputPrompt])) {
      return reply.code(422).send({ error: "内容包含不允许的词语，请修改后重试" });
    }
    const outputLanguage = body.outputLanguage ?? "auto";
    const languageInstruction = {
      zh: "Return exactly one ready-to-use image prompt in Chinese natural language, with no headings, explanation, alternatives or markdown.",
      en: "Return exactly one ready-to-use image prompt in English natural language, with no headings, explanation, alternatives or markdown. No Chinese, Japanese, or Korean characters may remain in the output.",
      auto: "Return exactly one ready-to-use image prompt in the user's language, with no headings, explanation, alternatives or markdown."
    }[outputLanguage];
    // 用户选了模板就用它；没选或已被删除时回退默认模板
    const chosenTemplate = body.templateId ? await repo.findTemplate(appDb, body.templateId) : undefined;
    const templateContent = (chosenTemplate ?? await repo.findDefaultTemplate(appDb))?.content
      ?? BUILT_IN_PROMPT_TEMPLATES.find(template => template.id === "optimize")!.content;
    const systemPrompt = [
      renderPromptTemplate(templateContent, {
        input_prompt: body.inputPrompt,
        input_language: "auto",
        target_image_model: body.targetModel,
        output_format: body.outputFormat,
        weight_rules: body.weightRules,
        style_constraints: body.styleConstraints,
        negative_prompt_rules: body.negativePromptRules
      }),
      languageInstruction,
      "只输出一条可直接使用的图像提示词，不要标题、解释、多个版本、Markdown、权重或正负向分组。"
    ].join("\n");
    const result = await runTextTool(appDb, providerSecrets, user, "optimize", {
      systemPrompt,
      userPrompt: body.inputPrompt,
      fallbackText: `Optimized ${body.targetModel} prompt will appear here after a text Provider is configured.`
    });
    const optimizedText = formatOptimizedPrompt(result.text);
    if (outputLanguage === "en" && result.providerConfigured && containsCjk(optimizedText)) {
      const repairResult = await runTextTool(appDb, providerSecrets, user, "optimize", {
        systemPrompt: [
          "Repair the optimized image-generation prompt by translating every remaining Chinese, Japanese, or Korean fragment into English.",
          "Preserve the meaning, visual details, constraints and correct English wording.",
          "Return exactly one English natural-language image prompt. Preserve complete sentences, not comma-separated prompt fragments.",
          "Do not add headings, explanation, alternatives, markdown, weights or separate positive/negative prompts.",
          "Do not leave any Chinese, Japanese, or Korean characters."
        ].join("\n"),
        userPrompt: optimizedText,
        fallbackText: optimizedText
      });
      return {
        ...result,
        text: formatOptimizedPrompt(repairResult.text),
        systemPrompt: `${result.systemPrompt}\n\n--- Optimization repair ---\n${repairResult.systemPrompt}`
      };
    }
    return {
      ...result,
      text: optimizedText
    };
  });
}
