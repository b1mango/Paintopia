import { type FastifyRequest } from "fastify";
import { z } from "zod";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";
import { cleanupTransientReferenceAssets, readStoredAsset } from "../services/assets.js";
import { type AssetStorage } from "../services/assetStorage.js";
import {
  type UserRecord
} from "../services/authService.js";
import { mapWithConcurrency } from "../services/imageGeneration.js";
import { HttpRequestError } from "../services/requestError.js";


export type ImageEditRequestInput = {
  prompt: string;
  providerId?: string;
  params: Record<string, unknown>;
  images: Blob[];
  referenceSources: string[];
  assetIds: string[];
  transientAssetIds: string[];
};

export async function parseImageEditRequest(
  appDb: AppDatabase,
  assetStorage: AssetStorage,
  request: FastifyRequest,
  user: UserRecord
): Promise<ImageEditRequestInput> {
  if (!request.isMultipart()) {
    const body = z.object({
      prompt: imagePromptSchema,
      providerId: z.string().optional(),
      params: z.record(z.string(), z.unknown()).default({}),
      assetIds: z.array(z.string().min(1)).max(MAX_EDIT_REFERENCE_IMAGES).default([]),
      transientAssetIds: z.array(z.string().min(1)).max(MAX_EDIT_REFERENCE_IMAGES).default([])
    }).parse(request.body);
    const allAssetIds = [...body.assetIds, ...body.transientAssetIds];
    try {
      if (allAssetIds.length === 0) {
        throw new HttpRequestError(400, "图生图需要至少一张参考图");
      }
      if (allAssetIds.length > MAX_EDIT_REFERENCE_IMAGES) {
        throw new HttpRequestError(400, "参考图最多 " + MAX_EDIT_REFERENCE_IMAGES + " 张");
      }
      const assetImages = await loadAssetReferenceImages(appDb, assetStorage, user, allAssetIds);
      assertReferenceImageTotalSize(assetImages);
      return {
        prompt: body.prompt,
        providerId: body.providerId,
        params: body.params,
        images: assetImages,
        referenceSources: [
          ...body.assetIds.map(() => "asset"),
          ...body.transientAssetIds.map(() => "upload")
        ],
        assetIds: allAssetIds,
        transientAssetIds: body.transientAssetIds
      };
    } catch (error) {
      await cleanupTransientReferenceAssets(appDb, assetStorage, user.id, body.transientAssetIds);
      throw error;
    }
  }

  const fields: Record<string, string[]> = {};
  const uploadedImages: Blob[] = [];
  const referenceSources: string[] = [];
  const parts = request.parts();

  for await (const part of parts) {
    if (part.type === "file") {
      if (part.fieldname !== "image") {
        continue;
      }
      if (!ALLOWED_EDIT_IMAGE_MIME_TYPES.has(part.mimetype)) {
        throw new HttpRequestError(415, "参考图只支持 PNG、JPEG 或 WebP");
      }
      if (uploadedImages.length >= MAX_EDIT_REFERENCE_IMAGES) {
        throw new HttpRequestError(400, `参考图最多 ${MAX_EDIT_REFERENCE_IMAGES} 张`);
      }
      const buffer = await part.toBuffer();
      uploadedImages.push(new Blob([new Uint8Array(buffer)], { type: part.mimetype }));
      assertReferenceImageTotalSize(uploadedImages);
      referenceSources.push("upload");
      continue;
    }

    const fieldName = String(part.fieldname ?? "");
    if (!fieldName) {
      continue;
    }
    const value = String(part.value ?? "").trim();
    if (!fields[fieldName]) {
      fields[fieldName] = [];
    }
    fields[fieldName]!.push(value);
  }

  const prompt = imagePromptSchema.parse(firstField(fields, "prompt"));

  const assetIds = collectAssetIds(fields);
  const assetImages = await loadAssetReferenceImages(appDb, assetStorage, user, assetIds);
  const images = [...assetImages, ...uploadedImages];
  if (images.length === 0) {
    throw new HttpRequestError(400, "图生图需要至少一张参考图");
  }
  if (images.length > MAX_EDIT_REFERENCE_IMAGES) {
    throw new HttpRequestError(400, `参考图最多 ${MAX_EDIT_REFERENCE_IMAGES} 张`);
  }
  assertReferenceImageTotalSize(images);

  const params: Record<string, unknown> = {};
  const resolution = firstField(fields, "resolution");
  const legacySize = firstField(fields, "size");
  appendRequestParam(params, "model", firstField(fields, "model"));
  appendRequestParam(params, "resolution", resolution ?? (legacySize ? undefined : "1K"));
  appendRequestParam(params, "size", legacySize);
  appendRequestParam(params, "aspectRatio", firstField(fields, "aspectRatio"));
  appendRequestParam(params, "background", firstField(fields, "background"));
  appendRequestParam(params, "quality", firstField(fields, "quality") ?? "high");
  appendRequestParam(params, "n", Number(firstField(fields, "n") ?? 1));

  return {
    prompt,
    providerId: firstField(fields, "providerId") || undefined,
    params,
    images,
    referenceSources: [
      ...assetImages.map(() => "asset"),
      ...referenceSources
    ],
    assetIds,
    transientAssetIds: []
  };
}

function assertReferenceImageTotalSize(images: Blob[]) {
  const totalBytes = images.reduce((sum, image) => sum + image.size, 0);
  if (totalBytes > MAX_EDIT_REFERENCE_TOTAL_BYTES) {
    throw new HttpRequestError(413, "参考图总大小不能超过 50MB");
  }
}

function firstField(fields: Record<string, string[]>, key: string): string | undefined {
  return fields[key]?.find((value) => value.length > 0);
}

function collectAssetIds(fields: Record<string, string[]>): string[] {
  const values = [
    ...(fields.assetIds ?? []),
    ...(fields.assetId ?? [])
  ];
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function appendRequestParam(target: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  target[key] = value;
}

async function loadAssetReferenceImages(
  appDb: AppDatabase,
  assetStorage: AssetStorage,
  user: UserRecord,
  assetIds: string[]
): Promise<Blob[]> {
  if (new Set(assetIds).size !== assetIds.length) {
    throw new HttpRequestError(400, "参考图不能重复选择");
  }
  const assets = await mapWithConcurrency(assetIds, 4, async (assetId) => {
    const asset = await repo.findAsset(appDb, assetId);
    if (!asset || asset.status !== "ready" || (asset.userId !== user.id && user.role !== "admin")) {
      throw new HttpRequestError(404, "参考资产不存在");
    }
    return asset;
  });
  const declaredBytes = assets.reduce((sum, asset) => sum + Number(asset.sizeBytes ?? 0), 0);
  if (declaredBytes > MAX_EDIT_REFERENCE_TOTAL_BYTES) {
    throw new HttpRequestError(413, "参考图总大小不能超过 50MB");
  }
  return mapWithConcurrency(assets, 4, async (asset) => {
    const buffer = await readStoredAsset(appDb, assetStorage, asset);
    return new Blob([new Uint8Array(buffer)], { type: asset.mimeType });
  });
}

export const MAX_EDIT_REFERENCE_IMAGES = 16;

export const MAX_EDIT_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

const MAX_EDIT_REFERENCE_TOTAL_BYTES = 50 * 1024 * 1024;

const ALLOWED_EDIT_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export const MAX_PROMPT_LENGTH = 20_000;

export const imagePromptSchema = z.string().trim().min(1).max(MAX_PROMPT_LENGTH);
