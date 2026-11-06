import { type ImageModelCapability, type QuotaPricingRule } from "../lib/apiClient";
import { calculateImageQuotaCost } from "@paintopia/shared";

export const IMAGE_RESOLUTION_OPTIONS = ["1K", "2K", "4K"] as const;
/** 新会话默认精度；从「自动」切到具体比例时也落在这一档。 */
export const DEFAULT_IMAGE_RESOLUTION = "4K";

export const fallbackImageCapabilities: ImageModelCapability[] = [];

export function capabilityKey(item: ImageModelCapability) {
  return item.providerId ? JSON.stringify([item.providerId, item.model]) : item.model;
}

export const MAX_REFERENCE_IMAGES = 16;

export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

export const MAX_REFERENCE_TOTAL_BYTES = 50 * 1024 * 1024;

export const defaultQuotaPricingRules: QuotaPricingRule[] = [
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

export function matchHistorySource(models: ImageModelCapability[], params: Record<string, unknown>) {
  const candidates = models.filter(item => item.model === params.model);
  if (typeof params.providerId === "string") return candidates.find(item => item.providerId === params.providerId);
  if (typeof params.providerName === "string") return candidates.find(item => item.providerName === params.providerName);
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function getEstimatedQuotaCost(rules: QuotaPricingRule[], resolution: string, quality: string, imageCount: number) {
  return calculateImageQuotaCost(rules.length ? rules : defaultQuotaPricingRules, resolution, quality, imageCount);
}
