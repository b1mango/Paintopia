import { inferImageResolution, normalizeImageProviderConfig, normalizeImageResolution, resolveImageSize, validateImageSize, type ImageProviderConfig } from "@paintopia/shared";
import { nanoid } from "nanoid";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";
import {
  callImageProvider,
  callImageProviderStream,
  isImageProviderStreamingUnsupportedError,
  type ImageGenerationPartial
} from "../providers/imageProvider.js";
import { sanitizeRequestValue, type UpstreamRequestSnapshot } from "../providers/requestSnapshot.js";
import { getRequestedImageCount } from "./imageParams.js";
import { HttpRequestError } from "./requestError.js";

import { personalAssetExpiry, personalAssetKey, type AssetRetentionPolicy } from "../services/assetRetention.js";
import { type AssetStorage } from "../services/assetStorage.js";
import { createImageThumbnail } from "../services/imageThumbnail.js";
import { type ProviderSecretCodec } from "../services/providerSecrets.js";
import { assetThumbnailKey, deleteStoredAsset, displayAuthorName, imageMimeType, safeJsonParse } from "./assets.js";
import { classifyImageResolution, decodedImageDimensions, ImageResolution, imageResolutionFromModelId, imageResolutionWarning, splitProviderModelIds } from "./imageCapabilities.js";
import { decryptProviderRecord, sortProviders } from "./providerConfig.js";
import { getUserEmailById } from "./users.js";

type ImageProviderRuntime = ImageProviderConfig & {
  id: string;
  name: string;
  supportedModels: string[];
};

export type ImageGenerationStage = {
  type: "stage";
  stage: "requesting" | "waiting" | "saving";
  message: string;
  providerName?: string;
  model?: string;
};

export type ImageProviderHealth = {
  failures: number;
  coolingUntil: number;
  lastError?: string;
};

type ImageProviderSelection = {
  providers: ImageProviderRuntime[];
  skipped: string[];
};

type GeneratedProviderImage = {
  b64Json?: string;
  url?: string;
  upstreamSize?: string;
  upstreamQuality?: string;
  upstreamResolution?: string;
  upstreamModel?: string;
};

type ImageProviderAttemptMetric = {
  providerId: string;
  providerName: string;
  model?: string;
  startedAt?: string;
  mode: "batch" | "single";
  requestedCount: number;
  returnedCount: number;
  durationMs: number;
  status: "succeeded" | "failed";
  error?: string;
  failureCategory?: string;
  requests?: UpstreamRequestSnapshot[];
};

type ImageOutputMetric = { assetId: string; width: number | null; height: number | null; imageUrl: string };

export type ImageProviderRunMetrics = {
  requestedCount: number;
  returnedCount: number;
  attemptCount: number;
  providerRequestMs: number;
  attempts: ImageProviderAttemptMetric[];
};

type ImageProviderRunResult = {
  images: GeneratedProviderImage[];
  metrics: ImageProviderRunMetrics;
};

export class ImageProviderRunError extends Error {
  constructor(
    message: string,
    public readonly metrics: ImageProviderRunMetrics
  ) {
    super(message);
  }
}

export class InsufficientQuotaError extends Error {
  constructor(
    public readonly requiredQuota: number,
    public readonly remainingQuota: number
  ) {
    super(`额度不足：需要 ${requiredQuota}，当前剩余 ${remainingQuota}`);
  }
}

const IMAGE_PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;

function selectProviderModelForRequest(storedModelValue: string, requestedModel?: string) {
  const supportedModels = splitProviderModelIds(storedModelValue);
  if (!requestedModel) return supportedModels[0] ?? "";
  return supportedModels.includes(requestedModel) ? requestedModel : "";
}

function imageProviderSupportsModel(storedModelValue: string, requestedModel: string | undefined) {
  return !requestedModel || Boolean(selectProviderModelForRequest(storedModelValue, requestedModel));
}

function imageProviderMetadataParams(image: GeneratedProviderImage) {
  return {
    ...(image.upstreamSize ? { upstreamSize: image.upstreamSize } : {}),
    ...(image.upstreamQuality ? { upstreamQuality: image.upstreamQuality } : {}),
    ...(image.upstreamResolution ? { upstreamResolution: image.upstreamResolution } : {}),
    ...(image.upstreamModel ? { upstreamModel: image.upstreamModel } : {})
  };
}

function isStrictImageResolution(resolution: ImageResolution) {
  return resolution !== "1K";
}



export function stripImageResultMetadata(params: Record<string, unknown>): Record<string, unknown> {
  const serverFields = new Set([
    "actualWidth", "actualHeight", "actualResolution", "resolutionWarning", "__paintopiaRuntime",
    "upstreamSize", "upstreamQuality", "upstreamResolution", "upstreamModel", "providerId", "providerName",
    "outputs", "mode", "referenceImageCount", "referenceSources", "assetIds"
  ]);
  return Object.fromEntries(Object.entries(params).filter(([key]) => !serverFields.has(key)));
}

export function normalizeImageRequestParams(params: Record<string, unknown>, resolution: ImageResolution): Record<string, unknown> {
  try {
    const aspectRatio = params.aspectRatio === undefined ? "1:1" : String(params.aspectRatio);
    const computed = resolveImageSize(resolution, aspectRatio);
    const legacyTier = typeof params.size === "string" && /^[124]k$/i.test(params.size.trim()) ? normalizeImageResolution(params.size) : undefined;
    if (legacyTier && legacyTier !== resolution) throw new Error("尺寸与分辨率档位不一致");
    const size = params.size !== undefined && !legacyTier ? validateImageSize(String(params.size)) : computed;
    if (size === "auto" && resolution !== "auto") throw new Error("自动尺寸必须使用 auto 分辨率，按 4K 档位计价");
    if (size !== "auto" && resolution !== "auto" && inferImageResolution(size) !== resolution) throw new Error("像素尺寸与分辨率档位不一致，请使用 " + inferImageResolution(size));
    const background = params.background === undefined ? undefined : String(params.background);
    if (background && !["auto", "opaque", "transparent"].includes(background)) throw new Error("背景必须是 auto、opaque 或 transparent");
    const quality = String(params.quality ?? "high").trim();
    if (!quality || quality.length > 40) throw new Error("无效质量参数");
    return { ...stripImageResultMetadata(params), size, resolution, quality, n: getRequestedImageCount(params), ...(background ? { background } : {}) };
  } catch (error) { throw new HttpRequestError(400, error instanceof Error ? error.message : "无效图片参数"); }
}

export async function filterImageProvidersByResolution(
  providers: ImageProviderRuntime[],
  resolution: ImageResolution
) {
  const skipped: string[] = [];
  const compatible = providers.filter(provider => {
    const tier = imageResolutionFromModelId(provider.model);
    if (!tier || tier === resolution) return true;
    skipped.push(provider.name + " 模型 " + provider.model + " 指定 " + tier + "，请求为 " + resolution);
    return false;
  });
  return { providers: compatible, skipped };
}

export function imageRequestModel(params: Record<string, unknown>) {
  return typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined;
}

export async function getImageProviders(
  appDb: AppDatabase,
  secrets: ProviderSecretCodec,
  providerId: string | undefined,
  health: Map<string, ImageProviderHealth>,
  modes?: ImageProviderConfig["mode"][],
  model?: string,
  resolution?: ImageResolution
): Promise<ImageProviderSelection> {
  const now = Date.now();
  const allProviders = (await repo.listProviders(appDb))
    .map((provider) => decryptProviderRecord(provider, secrets));
  const rows = providerId
    ? allProviders.filter((provider) => provider.id === providerId && provider.kind === "image" && provider.enabled)
    : sortProviders(allProviders.filter((provider) => provider.kind === "image" && provider.enabled));

  const skipped: string[] = [];
  const providers = rows
    .filter((provider) => {
      if (providerId) {
        return true;
      }
      const state = health.get(provider.id);
      if (!state || state.coolingUntil <= now) {
        return true;
      }
      skipped.push(`${provider.name} 冷却中，还剩 ${formatCooldownMs(state.coolingUntil - now)}`);
      return false;
    })
    .filter((provider) => {
      if (!modes?.length) {
        return true;
      }
      const normalizedMode = normalizeImageProviderConfig({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        mode: provider.mode as ImageProviderConfig["mode"],
        maxConcurrency: provider.maxConcurrency,
        imageCapabilities: provider.imageCapabilities
      }).mode;
      const allowed = modes.includes(normalizedMode);
      if (!allowed && isStrictImageResolution(resolution ?? "1K") && normalizedMode === "chat_completions") {
        skipped.push(`${provider.name} 使用 Chat Completions，无法强制 ${resolution} 尺寸`);
      }
      return allowed;
    })
    .filter((provider) => imageProviderSupportsModel(provider.model, model))
    .map((provider) => {
      const supportedModels = splitProviderModelIds(provider.model);
      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: selectProviderModelForRequest(provider.model, model) || supportedModels[0] || provider.model,
        supportedModels,
        mode: provider.mode as ImageProviderConfig["mode"],
        maxConcurrency: provider.maxConcurrency,
        imageCapabilities: provider.imageCapabilities
      };
    });

  return { providers, skipped };
}

export function formatImageProviderFailures(errors: string[], skipped: string[] = []) {
  const parts = [...errors, ...skipped];
  if (parts.length === 0) {
    return "所有图像接口均未返回结果";
  }
  return `所有图像接口均生成失败：${parts.join("；")}`;
}

export function clearImageProviderHealthForIds(health: Map<string, ImageProviderHealth>, providerIds: string[]) {
  for (const providerId of providerIds) {
    health.delete(providerId);
  }
}

export function markImageProviderHealthy(health: Map<string, ImageProviderHealth>, providerId: string) {
  health.delete(providerId);
}

export function markImageProviderUnhealthy(health: Map<string, ImageProviderHealth>, providerId: string, message: string) {
  const previous = health.get(providerId);
  const failures = (previous?.failures ?? 0) + 1;
  health.set(providerId, {
    failures,
    coolingUntil: Date.now() + cooldownForImageProviderError(message, failures),
    lastError: message
  });
}

export function shouldCooldownImageProviderError(message: string) {
  const normalized = message.toLowerCase();
  return ![
    "no available image quota",
    "insufficient_quota",
    "insufficient quota",
    "quota exceeded",
    "额度不足",
    "无可用额度"
  ].some((token) => normalized.includes(token));
}

function cooldownForImageProviderError(message: string, failures: number) {
  if (message.includes("Cloudflare 524")) {
    return Math.min(20 * 60 * 1000, IMAGE_PROVIDER_COOLDOWN_MS * failures);
  }
  if (message.includes("INTERNAL_ERROR") || message.includes("stream error")) {
    return Math.min(5 * 60 * 1000, 60 * 1000 * failures);
  }
  return Math.min(10 * 60 * 1000, 2 * 60 * 1000 * failures);
}

function formatCooldownMs(value: number) {
  const seconds = Math.max(1, Math.ceil(value / 1000));
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  return `${Math.ceil(seconds / 60)} 分钟`;
}



function buildPerImagePrompt(prompt: string, index: number, count: number) {
  if (count <= 1) {
    return prompt;
  }
  return [
    prompt,
    "",
    `Generate image ${index + 1} of ${count} as one standalone separate image.`,
    "Do not create a collage, contact sheet, split-screen layout, grid, or multi-panel composition."
  ].join("\n");
}

export async function generateImagesWithProvider(
  provider: ImageProviderRuntime,
  prompt: string,
  params: Record<string, unknown>,
  requestedImageCount: number,
  options: {
    onPartialImage?: (partial: ImageGenerationPartial) => void;
    onStage?: (event: ImageGenerationStage) => void;
  } = {}
): Promise<ImageProviderRunResult> {
  const metrics: ImageProviderRunMetrics = {
    requestedCount: requestedImageCount,
    returnedCount: 0,
    attemptCount: 0,
    providerRequestMs: 0,
    attempts: []
  };
  const generatedImages: GeneratedProviderImage[] = [];
  const normalizedMode = normalizeImageProviderConfig(provider).mode;
  const stage = (value: ImageGenerationStage["stage"], message: string) => options.onStage?.({
    type: "stage", stage: value, message, providerName: provider.name, model: provider.model
  });
  stage("requesting", "正在向接口提交生图请求");
  stage("waiting", provider.imageCapabilities?.supportsStreaming !== true || normalizedMode === "chat_completions" || normalizedMode === "edits" || requestedImageCount > 1
    ? "当前调用不提供过程预览，等待最终图片"
    : "等待上游生成图片；若接口提供过程预览，将在收到后显示");

  if (options.onPartialImage && requestedImageCount === 1 && provider.imageCapabilities?.supportsStreaming === true && normalizedMode !== "edits" && normalizedMode !== "chat_completions") {
    try {
      const result = await timedImageProviderCall(metrics, provider, "single", 1, (onRequest) => (
        callImageProviderStream(provider, {
          onRequest,
          prompt,
          params: {
            ...params,
            n: 1,
            partialImages: 1
          }
        }, options.onPartialImage!)
      ));
      if (result.images.length === 0) {
        throw new ImageProviderRunError(
          "Image provider stream did not return a final saveable image",
          finalizeImageRunMetrics(metrics, 0)
        );
      }
      return {
        images: result.images.slice(0, 1),
        metrics: finalizeImageRunMetrics(metrics, 1)
      };
    } catch (error) {
      if (!isImageProviderStreamingUnsupportedError(error)) {
        throw error instanceof ImageProviderRunError
          ? error
          : new ImageProviderRunError(
            error instanceof Error ? error.message : "Image provider stream failed",
            finalizeImageRunMetrics(metrics, 0)
          );
      }
      stage("waiting", "上游不支持过程预览，等待最终图片");
    }
  }

  if (normalizedMode === "generations" && requestedImageCount > 1) {
    try {
      const result = await timedImageProviderCall(metrics, provider, "batch", requestedImageCount, (onRequest) => (
        callImageProvider(provider, {
          onRequest,
          prompt,
          params: {
            ...params,
            n: requestedImageCount
          }
        })
      ));
      generatedImages.push(...result.images);
      if (generatedImages.length >= requestedImageCount) {
        metrics.returnedCount = requestedImageCount;
        return {
          images: generatedImages.slice(0, requestedImageCount),
          metrics
        };
      }
    } catch (error) {
      if (!shouldFallbackFromBatchError(error)) {
        throw new ImageProviderRunError(
          error instanceof Error ? error.message : "Image provider batch request failed",
          finalizeImageRunMetrics(metrics, generatedImages.length)
        );
      }
      // Batch support differs across OpenAI-compatible gateways; fall back to per-image calls.
    }
  }

  let singleFailure: unknown;
  const remainingCount = requestedImageCount - generatedImages.length;
  if (remainingCount > 0) {
    try {
      const startIndex = generatedImages.length;
      const remainingIndexes = Array.from({ length: remainingCount }, (_value, index) => startIndex + index);
      const singleResults = await mapWithConcurrency(
        remainingIndexes,
        provider.maxConcurrency,
        async (index) => timedImageProviderCall(metrics, provider, "single", 1, (onRequest) => (
          callImageProvider(provider, {
            onRequest,
            prompt: buildPerImagePrompt(prompt, index, requestedImageCount),
            params: {
              ...params,
              n: 1
            }
          })
        )).catch(error => { singleFailure = error; return { images: [] as GeneratedProviderImage[] }; })
      );
      for (const result of singleResults) {
        generatedImages.push(...result.images);
        if (generatedImages.length >= requestedImageCount) {
          break;
        }
      }
    } catch (error) {
      throw new ImageProviderRunError(
        error instanceof Error ? error.message : "Image provider request failed",
        finalizeImageRunMetrics(metrics, generatedImages.length)
      );
    }
  }

  if (generatedImages.length === 0) {
    throw new ImageProviderRunError(
      singleFailure instanceof Error ? singleFailure.message : "Image provider did not return a saveable image",
      finalizeImageRunMetrics(metrics, 0)
    );
  }


  return {
    images: generatedImages.slice(0, requestedImageCount),
    metrics: finalizeImageRunMetrics(metrics, Math.min(generatedImages.length, requestedImageCount))
  };
}

async function timedImageProviderCall(
  metrics: ImageProviderRunMetrics,
  provider: ImageProviderRuntime,
  mode: "batch" | "single",
  requestedCount: number,
  call: (onRequest: (snapshot: UpstreamRequestSnapshot) => void) => Promise<{ images: GeneratedProviderImage[] }>
) {
  const startedAt = Date.now();
  const requests: UpstreamRequestSnapshot[] = [];
  try {
    const result = await call(snapshot => requests.push(snapshot));
    recordImageProviderAttempt(metrics, {
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model,
      startedAt: new Date(startedAt).toISOString(),
      mode,
      requests,
      requestedCount,
      returnedCount: result.images.length,
      durationMs: Date.now() - startedAt,
      status: "succeeded"
    });
    return result;
  } catch (error) {
    const message = String(sanitizeRequestValue(error instanceof Error ? error.message : String(error), provider.apiKey));
    recordImageProviderAttempt(metrics, {
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model,
      startedAt: new Date(startedAt).toISOString(),
      mode,
      requests,
      requestedCount,
      returnedCount: 0,
      durationMs: Date.now() - startedAt,
      status: "failed",
      error: message,
      failureCategory: categorizeImageProviderFailure(message)
    });
    if (error instanceof Error) error.message = message;
    throw error;
  }
}

function recordImageProviderAttempt(metrics: ImageProviderRunMetrics, attempt: ImageProviderAttemptMetric) {
  metrics.attempts.push(attempt);
  metrics.attemptCount = metrics.attempts.length;
  metrics.providerRequestMs = metrics.attempts.reduce((sum, item) => sum + item.durationMs, 0);
}

function finalizeImageRunMetrics(metrics: ImageProviderRunMetrics, returnedCount: number) {
  metrics.returnedCount = returnedCount;
  metrics.attemptCount = metrics.attempts.length;
  metrics.providerRequestMs = metrics.attempts.reduce((sum, item) => sum + item.durationMs, 0);
  return metrics;
}

export async function mapWithConcurrency<T, TResult>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<TResult>
): Promise<TResult[]> {
  const normalizedLimit = Math.max(1, Math.floor(limit || 1));
  const results: TResult[] = [];
  for (let index = 0; index < items.length; index += normalizedLimit) {
    const chunk = items.slice(index, index + normalizedLimit);
    results.push(...await Promise.all(chunk.map(worker)));
  }
  return results;
}

function shouldFallbackFromBatchError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("n must")
    || message.includes("n should")
    || message.includes("n has to")
    || message.includes("only n=1")
    || message.includes("only supports n=1")
    || message.includes("unsupported parameter")
    || message.includes("unsupported value")
  );
}

export function imageOutputMetrics(assets: Array<{ id: string; imageUrl: string; params: Record<string, unknown> }>): ImageOutputMetric[] {
  return assets.map(asset => ({
    assetId: asset.id, imageUrl: asset.imageUrl,
    width: typeof asset.params.actualWidth === "number" ? asset.params.actualWidth : null,
    height: typeof asset.params.actualHeight === "number" ? asset.params.actualHeight : null
  }));
}

export function withImageRuntimeMetrics(
  params: Record<string, unknown>,
  metrics: ImageProviderRunMetrics,
  extra: { persistMs?: number; totalMs?: number; failure?: string; outputs?: ImageOutputMetric[] } = {}
) {
  return {
    ...params,
    __paintopiaRuntime: {
      imageGeneration: {
        requestedCount: metrics.requestedCount,
        returnedCount: metrics.returnedCount,
        attemptCount: metrics.attempts.length,
        providerRequestMs: metrics.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
        persistMs: extra.persistMs ?? 0,
        totalMs: extra.totalMs ?? metrics.providerRequestMs + (extra.persistMs ?? 0),
        failure: extra.failure,
        attempts: metrics.attempts,
        outputs: extra.outputs ?? []
      }
    }
  };
}

export function summarizeFailedImageRuns(metrics: ImageProviderRunMetrics[], failure: string): ImageProviderRunMetrics {
  const attempts = metrics.flatMap((entry) => entry.attempts);
  return {
    requestedCount: metrics[0]?.requestedCount ?? 0,
    returnedCount: metrics.reduce((sum, entry) => sum + entry.returnedCount, 0),
    attemptCount: attempts.length,
    providerRequestMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
    attempts: attempts.length > 0
      ? attempts
      : [{
        providerId: "",
        providerName: "",
        mode: "single",
        requestedCount: 0,
        returnedCount: 0,
        durationMs: 0,
        status: "failed",
        error: failure,
        failureCategory: categorizeImageProviderFailure(failure)
      }]
  };
}

function categorizeImageProviderFailure(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes(" n ") || normalized.includes("n must") || normalized.includes("n=")) {
    return "batch_unsupported";
  }
  if (normalized.includes("524") || normalized.includes("timeout") || normalized.includes("timed out")) {
    return "timeout";
  }
  if (normalized.includes("internal_error") || normalized.includes("stream error") || normalized.includes("econnreset")) {
    return "transient";
  }
  if (normalized.includes("did not return") || normalized.includes("returned 0")) {
    return "empty_result";
  }
  return "provider_error";
}

export async function persistGeneratedImages(
  appDb: AppDatabase,
  assetStorage: AssetStorage,
  retention: AssetRetentionPolicy,
  userId: string,
  jobId: string,
  prompt: string,
  params: Record<string, unknown>,
  images: GeneratedProviderImage[]
) {
  const outcomes = await Promise.allSettled(images.map(async (image): Promise<repo.AssetRecord | null> => {
    const assetId = nanoid();
    let bytes: Buffer;
    if (image.b64Json) {
      bytes = Buffer.from(image.b64Json, "base64");
    } else if (image.url) {
      const response = await fetch(image.url);
      if (!response.ok) {
        throw new Error(`Failed to download generated image: ${response.status}`);
      }
      bytes = Buffer.from(await response.arrayBuffer());
    } else {
      return null;
    }
    const mimeType = imageMimeType(bytes);
    const objectKey = personalAssetKey(retention, userId, assetId, mimeType);
    const dimensions = await decodedImageDimensions(bytes);
    const resolutionWarning = imageResolutionWarning(params, dimensions);
    const upstreamMetadata = { ...imageProviderMetadataParams(image), resolutionWarning };
    const assetParams = dimensions ? {
      ...params,
      ...upstreamMetadata,
      actualWidth: dimensions.width,
      actualHeight: dimensions.height,
      actualResolution: classifyImageResolution(dimensions.width, dimensions.height)
    } : { ...params, ...upstreamMetadata };
    await assetStorage.put(objectKey, bytes, mimeType);
    const thumbPath = await createImageThumbnail(bytes)
      .then(async (thumbnail) => {
        const key = assetThumbnailKey(assetId);
        await assetStorage.put(key, thumbnail, "image/webp");
        await assetStorage.put(`thumbnails/${assetId}-320.webp`, await createImageThumbnail(thumbnail, 320), "image/webp");
        return key;
      })
      .catch((error) => {
        console.warn("Paintopia thumbnail generation failed", error instanceof Error ? error.message : error);
        return null;
      });
    const createdAt = new Date();
    return {
      id: assetId,
      userId,
      jobId,
      originalPath: objectKey,
      thumbPath,
      storageBackend: assetStorage.backend,
      mimeType,
      sizeBytes: bytes.length,
      status: "ready",
      expiresAt: personalAssetExpiry(retention, userId, createdAt),
      prompt,
      paramsJson: JSON.stringify(assetParams),
      createdAt
    };
  }));

  const prepared = outcomes.flatMap((outcome) => (
    outcome.status === "fulfilled" && outcome.value ? [outcome.value] : []
  ));
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failure && prepared.length === 0) throw failure.reason;

  try {
    await repo.insertAssets(appDb, prepared);
  } catch (error) {
    await Promise.allSettled(prepared.map((asset) => deleteStoredAsset(appDb, assetStorage, asset)));
    throw error;
  }

  const ownerName = displayAuthorName((await getUserEmailById(appDb, userId)) ?? "");
  return prepared.map((asset) => ({
    id: asset.id,
    imageUrl: `/api/assets/${asset.id}/original`,
    thumbnailUrl: `/api/assets/${asset.id}/thumbnail`,
    sizeBytes: asset.sizeBytes ?? null,
    ownerName,
    prompt,
    params: safeJsonParse(asset.paramsJson),
    createdAt: asset.createdAt.toISOString()
  }));
}
