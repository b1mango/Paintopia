import { nanoid } from "nanoid";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";
import { callTextProvider } from "../providers/textProvider.js";
import {
  type UserRecord
} from "../services/authService.js";
import { type ProviderSecretCodec } from "../services/providerSecrets.js";
import { getTextProviders } from "./providerConfig.js";

export async function runTextTool(
  appDb: AppDatabase,
  providerSecrets: ProviderSecretCodec,
  user: UserRecord,
  type: "translate" | "optimize",
  input: {
    systemPrompt: string;
    userPrompt: string;
    fallbackText: string;
  }
) {
  const providers = await getTextProviders(appDb, providerSecrets);
  if (providers.length === 0) {
    await recordTextToolRun(appDb, {
      userId: user.id,
      providerId: null,
      type,
      status: "failed",
      durationMs: 0,
      error: "No enabled text provider is configured.",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    });
    return {
      providerConfigured: false,
      text: input.fallbackText,
      systemPrompt: input.systemPrompt
    };
  }

  let lastError: unknown;
  for (const provider of providers) {
    const startedAt = Date.now();
    try {
      const result = await callTextProvider(provider, {
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt
      });
      await recordTextToolRun(appDb, {
        userId: user.id,
        providerId: provider.id,
        type,
        status: "succeeded",
        durationMs: Date.now() - startedAt,
        error: null,
        usage: result.usage
      });
      return {
        providerConfigured: true,
        text: result.text,
        systemPrompt: input.systemPrompt
      };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : "Text provider request failed";
      await recordTextToolRun(appDb, {
        userId: user.id,
        providerId: provider.id,
        type,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: message,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      });
    }
  }

  throw lastError;
}

async function recordTextToolRun(
  appDb: AppDatabase,
  input: {
    userId: string;
    providerId: string | null;
    type: "translate" | "optimize";
    status: "succeeded" | "failed";
    durationMs: number;
    error: string | null;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  }
) {
  await repo.insertTextToolRun(appDb, {
    id: nanoid(),
    userId: input.userId,
    providerId: input.providerId,
    type: input.type,
    status: input.status,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    totalTokens: input.usage.totalTokens,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    error: input.error,
    createdAt: new Date()
  });
}

export function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

export function formatOptimizedPrompt(value: string): string {
  const cleaned = stripMarkdownNoise(value);
  const positive = extractSection(cleaned, ["正向提示词", "positive prompt", "positive"]);
  return (extractFirstCodePrompt(value) || positive || cleaned).trim();
}

function stripMarkdownNoise(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .trim();
}

function extractSection(value: string, labels: string[]): string {
  const escapedLabels = labels.map(escapeRegExp).join("|");
  const nextLabels = [
    "正向提示词",
    "负向提示词",
    "positive prompt",
    "negative prompt",
    "positive",
    "negative",
    "元素权重",
    "核心要素",
    "关键点",
    "版本"
  ].map(escapeRegExp).join("|");
  const match = value.match(new RegExp(`(?:${escapedLabels})\\s*[:：]?\\s*([\\s\\S]*?)(?=\\n\\s*(?:${nextLabels})\\s*[:：]|$)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function extractFirstCodePrompt(value: string): string {
  const matches = [...value.matchAll(/```(?:[a-zA-Z]*)?\s*([\s\S]*?)```/g)];
  for (const match of matches) {
    const content = match[1]?.trim() ?? "";
    if (content && !/^\s*(json|javascript|typescript)\b/i.test(content)) {
      return content;
    }
  }
  return "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
