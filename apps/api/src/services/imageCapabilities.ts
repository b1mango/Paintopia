import { parsePixelSize } from "@paintopia/shared";
import sharp from "sharp";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";
import { safeJsonParse } from "./assets.js";
import { imageRequestResolution } from "./imageParams.js";

type ImageCapabilityAssetRow = {
  providerId: string;
  paramsJson: string;
};

type ImageDimensions = {
  width: number;
  height: number;
};

const imageCapabilitiesCache = new WeakMap<AppDatabase, { expiresAt: number; pending: ReturnType<typeof configuredImageCapabilities> }>();

export function invalidateImageCapabilities(appDb: AppDatabase) {
  imageCapabilitiesCache.delete(appDb);
}

export function cachedImageCapabilities(appDb: AppDatabase) {
  const cached = imageCapabilitiesCache.get(appDb);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const entry = { expiresAt: Infinity, pending: configuredImageCapabilities(appDb) };
  imageCapabilitiesCache.set(appDb, entry);
  entry.pending.then(() => { entry.expiresAt = Date.now() + 60000; }, () => {
    if (imageCapabilitiesCache.get(appDb) === entry) imageCapabilitiesCache.delete(appDb);
  });
  return entry.pending;
}

async function configuredImageCapabilities(appDb: AppDatabase) {
  const [configured, observedByProvider] = await Promise.all([repo.listProviders(appDb), observedImageResolutionsByProvider(appDb)]);
  const providers = configured
    .filter((provider) => provider.kind === "image" && provider.enabled);
  return providers.flatMap((provider) => splitProviderModelIds(provider.model).map((model) => {
    const tierResolution = imageResolutionFromModelId(model);
    return {
      providerId: provider.id,
      providerName: provider.name,
      mode: provider.mode,
      model,
      imageCapabilities: provider.imageCapabilities ?? {},
      resolutions: tierResolution ? [tierResolution] : verifiedImageResolutions(observedByProvider.get(provider.id))
    };
  }));
}

async function observedImageResolutionsByProvider(appDb: AppDatabase) {
  const rows = await appDb.query<ImageCapabilityAssetRow>(`
    SELECT
      j.provider_id AS "providerId",
      a.params_json AS "paramsJson"
    FROM assets a
    JOIN generation_jobs j ON j.id = a.job_id
    WHERE j.status = 'succeeded' AND j.provider_id IS NOT NULL
    ORDER BY a.created_at DESC
    LIMIT 512
  `);
  const result = new Map<string, Set<ImageResolution>>();

  for (const row of rows) {
    const dimensions = imageDimensionsFromParams(row.paramsJson);
    if (!dimensions) continue;
    const resolutions = result.get(row.providerId) ?? new Set<ImageResolution>();
    resolutions.add(classifyImageResolution(dimensions.width, dimensions.height));
    result.set(row.providerId, resolutions);
  }

  return result;
}

function verifiedImageResolutions(observed: Set<ImageResolution> | undefined): ImageResolution[] {
  const verified = new Set<ImageResolution>(["1K"]);
  for (const resolution of observed ?? []) {
    verified.add(resolution);
  }
  return IMAGE_RESOLUTIONS.filter((resolution) => verified.has(resolution));
}

function imageDimensionsFromParams(paramsJson: string): ImageDimensions | null {
  const params = safeJsonParse(paramsJson);
  const width = Number(params.actualWidth);
  const height = Number(params.actualHeight);
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : null;
}

export async function decodedImageDimensions(bytes: Buffer): Promise<ImageDimensions | null> {
  try {
    const metadata = await sharp(bytes).metadata();
    if (metadata.width && metadata.height) return { width: metadata.width, height: metadata.height };
  } catch { /* Keep header support for older stored assets. */ }
  return imageDimensionsFromBytes(bytes);
}

function imageDimensionsFromBytes(buffer: Buffer): ImageDimensions | null {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      return null;
    }
    if (startOfFrameMarkers.has(marker)) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5)
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

export function classifyImageResolution(width: number, height: number): ImageResolution {
  const pixels = width * height;
  if (pixels < 2_000_000) return "1K";
  if (pixels < 6_000_000) return "2K";
  return "4K";
}

export function imageResolutionWarning(
  params: Record<string, unknown>,
  dimensions: ImageDimensions | null
): string | undefined {
  const requested = imageRequestResolution(params);
  if (!dimensions) {
    return `图片已保存，但无法读取实际尺寸，尚未核实请求的 ${requested ?? "目标"} 分辨率`;
  }
  if (!requested) return;
  const expected = typeof params.size === "string" ? parsePixelSize(params.size) : null;
  if (expected) {
    if (dimensions.width < expected.width || dimensions.height < expected.height) return "图片已保存。上游返回图片尺寸低于请求：请求 " + requested + "，实际 " + dimensions.width + "x" + dimensions.height + "（" + classifyImageResolution(dimensions.width, dimensions.height) + "），请求像素 " + params.size;
    return;
  }
  if (requested === "auto") return;
  const actual = classifyImageResolution(dimensions.width, dimensions.height);
  if (IMAGE_RESOLUTION_RANK[actual] < IMAGE_RESOLUTION_RANK[requested]) {
    return `图片已保存。上游返回图片分辨率低于请求档位：请求 ${requested}，实际 ${dimensions.width}x${dimensions.height}（${actual}）`;
  }
}

const IMAGE_RESOLUTIONS = ["1K", "2K", "4K", "auto"] as const;

export type ImageResolution = typeof IMAGE_RESOLUTIONS[number];

export function imageResolutionFromModelId(model: string): ImageResolution | null {
  const match = model.trim().match(/-(1k|2k|4k)$/i);
  if (!match?.[1]) return null;
  const resolution = match[1].toUpperCase();
  return IMAGE_RESOLUTIONS.includes(resolution as ImageResolution) ? resolution as ImageResolution : null;
}

export function splitProviderModelIds(value: string | null | undefined) {
  return Array.from(new Set(
    String(value ?? "")
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

const IMAGE_RESOLUTION_RANK: Record<ImageResolution, number> = { "1K": 1, "2K": 2, "4K": 3, "auto": 0 };
