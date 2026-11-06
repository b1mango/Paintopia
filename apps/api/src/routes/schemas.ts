import {
  MAX_GALLERY_TAGS
} from "@paintopia/shared";
import { z } from "zod";
import { MAX_EDIT_REFERENCE_IMAGE_BYTES, MAX_PROMPT_LENGTH, imagePromptSchema } from "./imageEditInput.js";

export const loginSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1)
});

export const registerSchema = z.object({
  email: z.string().trim().min(1).max(80),
  password: z.string().min(6).max(128),
  inviteCode: z.string().trim().min(1)
});

const imageCapabilitySchema = z.object({
  qualities: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  sizeField: z.enum(["size", "image_size"]).nullable().optional(),
  resolutionField: z.enum(["resolution", "image_size"]).nullable().optional(),
  supportsStreaming: z.boolean().optional()
}).refine(value => !(value.sizeField && value.sizeField === value.resolutionField), "尺寸字段和分辨率字段不可相同");

export const providerSchema = z.object({
  imageCapabilities: imageCapabilitySchema.optional(),
  kind: z.enum(["image", "text"]),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().optional().default(""),
  model: z.string().min(1),
  mode: z.string().min(1),
  maxConcurrency: z.number().int().min(1).optional(),
  enabled: z.boolean().optional()
});

export const providerUpdateSchema = providerSchema.extend({
  apiKey: z.string().optional()
});

export const providerTestSchema = providerUpdateSchema.extend({
  providerId: z.string().optional(),
  prompt: z.string().optional()
});

export const providerModelsSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional().default(""),
  providerId: z.string().optional()
});

export const providerOrderSchema = z.object({
  kind: z.enum(["image", "text"]),
  providerIds: z.array(z.string().min(1)).min(1)
});

export const templateSchema = z.object({
  name: z.string().min(1),
  type: z.literal("optimize").default("optimize"),
  targetModel: z.string().min(1).default("general"),
  content: z.string().min(1)
});

export const generationSchema = z.object({
  prompt: imagePromptSchema,
  providerId: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({})
});

const promptToolSchema = z.object({
  inputPrompt: imagePromptSchema,
  targetModel: z.string().default("general"),
  outputFormat: z.string().default("natural language"),
  weightRules: z.string().default("subject 1.2, light 1.1, atmosphere 1.1"),
  styleConstraints: z.string().default("clear, faithful, useful for image generation"),
  negativePromptRules: z.string().default("avoid low quality, blur, distorted anatomy")
});

export const optimizePromptSchema = promptToolSchema.extend({
  outputLanguage: z.enum(["zh", "en"]).optional(),
  templateId: z.string().trim().min(1).max(120).optional()
});

export const promptSchema = z.object({
  zh: imagePromptSchema,
  en: imagePromptSchema,
  category: z.string().trim().min(1).max(80),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).default([])
});

export const userPatchSchema = z.object({
  quota: z.number().int().min(0).optional(),
  status: z.enum(["active", "disabled"]).optional()
});

export const quotaPricingPatchSchema = z.object({
  rules: z.array(z.object({
    key: z.string().min(1),
    amount: z.number().int().min(0)
  }))
});

export const idParamSchema = z.object({
  id: z.string().min(1)
});

export const assetUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  sizeBytes: z.number().int().positive().max(MAX_EDIT_REFERENCE_IMAGE_BYTES),
  prompt: z.string().max(MAX_PROMPT_LENGTH).optional().default(""),
  params: z.record(z.string(), z.unknown()).optional().default({})
});

export const galleryTagIdsSchema = z.array(z.string()).min(1, "请至少选择一个标签").max(MAX_GALLERY_TAGS, `最多选择 ${MAX_GALLERY_TAGS} 个标签`)
  .refine((ids) => new Set(ids).size === ids.length, "标签不能重复");

export const galleryReviewSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), tagIds: galleryTagIdsSchema }),
  z.object({ decision: z.literal("reject"), reason: z.string().trim().max(500).optional() })
]);

export const inviteQuerySchema = z.object({
  q: z.string().optional(),
  status: z.enum(["all", "active", "used", "destroyed"]).optional()
});

export const IMAGE_GENERATION_RATE_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 };

export const TEXT_TOOL_RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };

export const ASSET_UPLOAD_RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };

export const CONTENT_MUTATION_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };
