import { calculateImageQuotaCost } from "@paintopia/shared";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";
import { invalidateImageCapabilities } from "./imageCapabilities.js";
import { getRequestedImageCount } from "./imageParams.js";

export const defaultQuotaPricingRules = [
  { key: "resolution.1k.quality.low", label: "1K / low", amount: 1 },
  { key: "resolution.1k.quality.medium", label: "1K / medium", amount: 2 },
  { key: "resolution.1k.quality.high", label: "1K / high", amount: 3 },
  { key: "resolution.2k.quality.low", label: "2K / low", amount: 2 },
  { key: "resolution.2k.quality.medium", label: "2K / medium", amount: 4 },
  { key: "resolution.2k.quality.high", label: "2K / high", amount: 6 },
  { key: "resolution.4k.quality.low", label: "4K / low", amount: 4 },
  { key: "resolution.4k.quality.medium", label: "4K / medium", amount: 8 },
  { key: "resolution.4k.quality.high", label: "4K / high", amount: 12 }
];

export async function ensureQuotaPricingRules(appDb: AppDatabase) {
  const now = new Date();
  for (const rule of defaultQuotaPricingRules) {
    const existing = await repo.findQuotaRule(appDb, rule.key);
    if (existing) continue;
    await repo.upsertQuotaRule(appDb, {
      ...rule,
      updatedAt: now
    });
  }
}

export async function listQuotaPricingRules(appDb: AppDatabase) {
  const order = new Map(defaultQuotaPricingRules.map((rule, index) => [rule.key, index]));
  const allowedKeys = new Set(order.keys());
  return (await repo.listQuotaRules(appDb))
    .filter((rule) => allowedKeys.has(rule.key))
    .sort((left, right) => (order.get(left.key) ?? 999) - (order.get(right.key) ?? 999));
}

export async function calculateImageGenerationQuotaCost(appDb: AppDatabase, params: Record<string, unknown>) {
  await ensureQuotaPricingRules(appDb);
  return calculateImageQuotaCost(await listQuotaPricingRules(appDb), String(params.resolution ?? "1K"), String(params.quality ?? "high"), getRequestedImageCount(params));
}

export function getUserQuota(appDb: AppDatabase, userId: string) {
  return repo.getQuota(appDb, userId);
}

export async function consumeImageGenerationQuota(
  appDb: AppDatabase,
  userId: string,
  jobId: string,
  amount: number,
  details: { quality: string; imageCount: number; mode: "generation" | "edit" },
  completedJob: { providerId: string; paramsJson: string }
) {
  const quota = await repo.settleImageQuota(appDb, userId, jobId, amount, JSON.stringify({ jobId, ...details }), completedJob.providerId, completedJob.paramsJson);
  invalidateImageCapabilities(appDb);
  return quota;
}
