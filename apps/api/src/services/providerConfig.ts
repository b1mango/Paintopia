import {
  type ImageProviderConfig,
  type TextProviderMode
} from "@paintopia/shared";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";
import { type ProviderSecretCodec } from "../services/providerSecrets.js";
import { providerInitialPriority } from "./providerPriority.js";

export function maskProvider(provider: repo.ProviderRecord | undefined) {
  if (!provider) {
    return provider;
  }
  return {
    ...provider,
    apiKey: provider.apiKey ? "********" : ""
  };
}

type ProviderQuotaResult = {
  providerId: string;
  status: "available" | "unlimited" | "unknown";
  remaining: number | null;
  used: number | null;
  total: number | null;
  source: "newapi" | "credit_grants" | null;
  scope: "token" | "account" | null;
  unit: string | null;
  checkedAt: string;
  tokenUnlimited: boolean;
};

export async function queryProviderQuota(provider: repo.ProviderRecord): Promise<ProviderQuotaResult> {
  const unknown: ProviderQuotaResult = {
    providerId: provider.id,
    status: "unknown",
    remaining: null,
    used: null,
    total: null,
    source: null,
    scope: null,
    unit: null,
    checkedAt: new Date().toISOString(),
    tokenUnlimited: false
  };
  if (!provider.apiKey.trim()) return unknown;

  let origin: string;
  try {
    origin = new URL(provider.baseUrl).origin;
  } catch {
    return unknown;
  }
  const candidates = [
    { url: `${origin}/api/usage/token`, source: "newapi" as const },
    { url: `${origin}/v1/dashboard/billing/credit_grants`, source: "credit_grants" as const }
  ];
  let tokenResult: ProviderQuotaResult | undefined;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.url, {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          Accept: "application/json",
          "User-Agent": "Paintopia/0.1.0"
        },
        signal: AbortSignal.timeout(4_000)
      });
      if (!response.ok) continue;
      const payload = await response.json() as Record<string, unknown>;
      const nested = isRecord(payload.data) ? payload.data : payload;
      if (payload.success === false) continue;
      const unlimited = nested.unlimited_quota === true || nested.unlimited === true;
      const remaining = finiteNumber(nested.total_available ?? nested.remaining_quota ?? nested.remain_quota ?? nested.remaining ?? nested.balance);
      const used = finiteNumber(nested.total_used ?? nested.used_quota ?? nested.used);
      const total = finiteNumber(nested.total_granted ?? nested.total);
      if (!unlimited && remaining === null && used === null && total === null) continue;
      const result: ProviderQuotaResult = {
        ...unknown,
        status: unlimited ? "unlimited" : remaining !== null ? "available" : "unknown",
        remaining: unlimited ? null : remaining,
        used,
        total,
        source: candidate.source,
        scope: candidate.source === "newapi" ? "token" : "account",
        // Token counters are raw quota units: never assume a currency conversion rate.
        unit: candidate.source === "newapi" ? "quota" : (typeof nested.currency === "string" && nested.currency.trim() ? nested.currency.trim() : "USD"),
        tokenUnlimited: unlimited || Boolean(tokenResult?.tokenUnlimited)
      };
      if (candidate.source === "newapi") {
        tokenResult = result;
        continue;
      }
      return result;
    } catch {
      // Try the next documented balance endpoint.
    }
  }
  return tokenResult ?? unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function listProviders(appDb: AppDatabase, secrets: ProviderSecretCodec) {
  return sortProviders((await repo.listProviders(appDb)).map((provider) => decryptProviderRecord(provider, secrets)));
}

export function sortProviders<T extends repo.ProviderRecord>(providers: T[]): T[] {
  return [...providers].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder;
    }
    if (left.createdAt.getTime() !== right.createdAt.getTime()) {
      return left.createdAt.getTime() - right.createdAt.getTime();
    }
    return left.id.localeCompare(right.id);
  });
}

export async function nextProviderSortOrderForConfig(
  appDb: AppDatabase,
  input: { kind: "image" | "text"; name?: string; baseUrl?: string; model?: string }
) {
  const priority = input.kind === "image"
    ? providerInitialPriority("image", input.name ?? "", input.baseUrl ?? "", "")
    : providerInitialPriority("text", input.name ?? "", input.baseUrl ?? "", input.model ?? "");
  const lowerBound = priority * 10000;
  const upperBound = lowerBound + 9999;
  const rows = (await repo.listProviders(appDb))
    .filter((provider) => provider.kind === input.kind)
    .filter((provider) => provider.sortOrder >= lowerBound && provider.sortOrder <= upperBound);
  const maxSortOrder = rows.reduce((max, provider) => Math.max(max, provider.sortOrder), lowerBound - 10);
  return maxSortOrder + 10;
}

export async function testImageProviderConnectivity(provider: ImageProviderConfig) {
  const url = provider.baseUrl.replace(/\/+$/, "");
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`
    },
    signal: AbortSignal.timeout(5000)
  });
  if (response.status >= 500) {
    throw new Error(`Image provider connectivity test failed with status ${response.status}`);
  }
}

export async function fetchProviderModels(baseUrl: string, apiKey: string) {
  const url = providerModelsUrl(baseUrl);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(8000)
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    throw new Error(`Model list request failed with status ${response.status}`);
  }
  return extractProviderModelIds(parsed);
}

function providerModelsUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    url.search = "";
    url.hash = "";
    let pathname = url.pathname.replace(/\/+$/, "");
    const endpointSuffixes = [
      "/chat/completions",
      "/responses",
      "/messages",
      "/images/generations",
      "/images/edits",
      "/completions"
    ];
    for (const suffix of endpointSuffixes) {
      if (pathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length);
        break;
      }
    }
    if (pathname.endsWith("/models")) {
      url.pathname = pathname;
    } else if (pathname.endsWith("/v1")) {
      url.pathname = `${pathname}/models`;
    } else {
      url.pathname = `${pathname}/v1/models`;
    }
    return url.toString();
  } catch {
    return `${trimmed}/v1/models`;
  }
}

function extractProviderModelIds(value: unknown) {
  const data = value && typeof value === "object" && "data" in value ? (value as { data?: unknown }).data : value;
  const rows = Array.isArray(data) ? data : [];
  const ids = rows
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "id" in item && typeof (item as { id?: unknown }).id === "string") {
        return (item as { id: string }).id;
      }
      return null;
    })
    .filter((id): id is string => Boolean(id?.trim()));
  return Array.from(new Set(ids)).sort((left, right) => left.localeCompare(right));
}

export async function getTextProviders(appDb: AppDatabase, secrets: ProviderSecretCodec) {
  return sortProviders((await repo.listProviders(appDb))
    .filter((provider) => provider.kind === "text" && provider.enabled)
    .map((provider) => decryptProviderRecord(provider, secrets)))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      mode: provider.mode as TextProviderMode
    }));
}

export function decryptProviderRecord(provider: repo.ProviderRecord, secrets: ProviderSecretCodec): repo.ProviderRecord {
  return {
    ...provider,
    apiKey: secrets.decrypt(provider.apiKey)
  };
}
