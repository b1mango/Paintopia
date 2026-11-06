import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  quota: integer("quota").notNull().default(66),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  theme: text("theme", { enum: ["dark", "light", "system"] }).notNull().default("dark"),
  language: text("language", { enum: ["zh", "en"] }).notNull().default("zh"),
  reduceMotion: integer("reduce_motion", { mode: "boolean" }).notNull().default(false),
  defaultImageModel: text("default_image_model").notNull().default("gpt-image-2"),
  defaultSize: text("default_size").notNull().default("1024x1024"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const inviteCodes = sqliteTable("invite_codes", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  status: text("status", { enum: ["active", "used", "destroyed"] }).notNull().default("active"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  usedBy: text("used_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  destroyedAt: integer("destroyed_at", { mode: "timestamp_ms" })
});

export const providerConfigs = sqliteTable("provider_configs", {
  configJson: text("config_json").notNull().default("{}"),
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["image", "text"] }).notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  model: text("model").notNull(),
  mode: text("mode").notNull(),
  maxConcurrency: integer("max_concurrency").notNull().default(1),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const promptTemplates = sqliteTable("prompt_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", { enum: ["optimize"] }).notNull(),
  targetModel: text("target_model").notNull().default("general"),
  content: text("content").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const generationJobs = sqliteTable("generation_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id"),
  status: text("status", { enum: ["queued", "running", "succeeded", "failed"] }).notNull(),
  prompt: text("prompt").notNull(),
  paramsJson: text("params_json").notNull(),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const textToolRuns = sqliteTable("text_tool_runs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id"),
  type: text("type", { enum: ["translate", "optimize"] }).notNull(),
  status: text("status", { enum: ["succeeded", "failed"] }).notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  jobId: text("job_id").references(() => generationJobs.id, { onDelete: "set null" }),
  originalPath: text("original_path").notNull(),
  thumbPath: text("thumb_path"),
  storageBackend: text("storage_backend", { enum: ["local", "r2"] }).notNull().default("local"),
  mimeType: text("mime_type").notNull().default("image/png"),
  sizeBytes: integer("size_bytes"),
  status: text("status", { enum: ["uploading", "ready"] }).notNull().default("ready"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  prompt: text("prompt").notNull(),
  paramsJson: text("params_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const galleryItems = sqliteTable("gallery_items", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull().unique().references(() => assets.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  objectKey: text("object_key"),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
  rejectionReason: text("rejection_reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const galleryItemTags = sqliteTable("gallery_item_tags", {
  galleryItemId: text("gallery_item_id").notNull().references(() => galleryItems.id, { onDelete: "cascade" }),
  tagId: text("tag_id").notNull()
}, (table) => [primaryKey({ columns: [table.galleryItemId, table.tagId] })]);

export const prompts = sqliteTable("prompts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  zh: text("zh").notNull(),
  en: text("en").notNull(),
  category: text("category").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const promptTags = sqliteTable("prompt_tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique()
});

export const promptPromptTags = sqliteTable("prompt_prompt_tags", {
  promptId: text("prompt_id").notNull().references(() => prompts.id, { onDelete: "cascade" }),
  tagId: text("tag_id").notNull().references(() => promptTags.id, { onDelete: "cascade" })
});

export const promptFavorites = sqliteTable("prompt_favorites", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  promptId: text("prompt_id").notNull().references(() => prompts.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const usageLedger = sqliteTable("usage_ledger", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  amount: integer("amount").notNull(),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const quotaPricingRules = sqliteTable("quota_pricing_rules", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  amount: integer("amount").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStartedAt: integer("window_started_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull()
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  detailJson: text("detail_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const schema = {
  users,
  sessions,
  userPreferences,
  inviteCodes,
  providerConfigs,
  promptTemplates,
  generationJobs,
  textToolRuns,
  assets,
  galleryItems,
  galleryItemTags,
  prompts,
  promptTags,
  promptPromptTags,
  promptFavorites,
  usageLedger,
  quotaPricingRules,
  rateLimits,
  auditLogs
};
