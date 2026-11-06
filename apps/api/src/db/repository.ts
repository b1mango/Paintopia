import { GALLERY_TAGS, type GalleryTag, type ImageProviderCapabilities } from "@paintopia/shared";
import { nanoid } from "nanoid";
import { randomBytes } from "node:crypto";
import type { AppDatabase, DatabaseExecutor, DatabaseValue } from "./database.js";
import type { UserRecord } from "../services/authService.js";

type Timestamp = number | string;
type BooleanValue = number | string | boolean;

export type PreferenceRecord = {
  userId: string;
  theme: "dark" | "light" | "system";
  language: "zh" | "en";
  reduceMotion: boolean;
  defaultImageModel: string;
  defaultSize: string;
  updatedAt: Date;
};

export type ProviderRecord = {
  imageCapabilities?: ImageProviderCapabilities;
  id: string;
  kind: "image" | "text";
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: string;
  maxConcurrency: number;
  enabled: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PromptTemplateRecord = {
  id: string;
  name: string;
  type: "optimize";
  targetModel: string;
  content: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type InviteRecord = {
  id: string;
  code: string;
  status: "active" | "used" | "destroyed";
  createdBy: string | null;
  usedBy: string | null;
  createdAt: Date;
  usedAt: Date | null;
  destroyedAt: Date | null;
};

export type GenerationJobRecord = {
  id: string;
  userId: string;
  providerId: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  prompt: string;
  paramsJson: string;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TextToolRunRecord = {
  id: string;
  userId: string;
  providerId: string | null;
  type: "translate" | "optimize";
  status: "succeeded" | "failed";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  error: string | null;
  createdAt: Date;
};

export type AssetRecord = {
  id: string;
  userId: string;
  jobId: string | null;
  originalPath: string;
  thumbPath: string | null;
  storageBackend: "local" | "r2";
  mimeType: string;
  sizeBytes: number | null;
  status: "uploading" | "ready";
  expiresAt: Date | null;
  prompt: string;
  paramsJson: string;
  createdAt: Date;
};

export type GalleryItemRecord = {
  id: string;
  assetId: string;
  userId: string;
  title: string;
  prompt: string;
  status: "pending" | "approved" | "rejected";
  objectKey: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
};

export type PromptRecord = {
  id: string;
  userId: string;
  zh: string;
  en: string;
  category: string;
  createdAt: Date;
  updatedAt: Date;
};

export type QuotaPricingRuleRecord = {
  key: string;
  label: string;
  amount: number;
  updatedAt: Date;
};

const userColumns = `
  id, email, password_hash AS "passwordHash", role, status, quota,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;
const providerColumns = `
  id, kind, name, base_url AS "baseUrl", api_key AS "apiKey", model, mode,
  max_concurrency AS "maxConcurrency", config_json AS "configJson", enabled, sort_order AS "sortOrder",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;
const inviteColumns = `
  id, code, status, created_by AS "createdBy", used_by AS "usedBy",
  created_at AS "createdAt", used_at AS "usedAt", destroyed_at AS "destroyedAt"
`;
const assetColumns = `
  id, user_id AS "userId", job_id AS "jobId", original_path AS "originalPath",
  thumb_path AS "thumbPath", storage_backend AS "storageBackend", mime_type AS "mimeType",
  size_bytes AS "sizeBytes", status, expires_at AS "expiresAt", prompt,
  params_json AS "paramsJson", created_at AS "createdAt"
`;
const galleryColumns = `
  id, asset_id AS "assetId", user_id AS "userId", title, prompt, status,
  object_key AS "objectKey", reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt",
  rejection_reason AS "rejectionReason", created_at AS "createdAt"
`;

export async function getPreference(db: DatabaseExecutor, userId: string): Promise<PreferenceRecord | undefined> {
  const row = await db.queryOne<any>(`
    SELECT user_id AS "userId", theme, language, reduce_motion AS "reduceMotion",
      default_image_model AS "defaultImageModel", default_size AS "defaultSize",
      updated_at AS "updatedAt"
    FROM user_preferences WHERE user_id = ?
  `, [userId]);
  return row ? {
    ...row,
    reduceMotion: toBoolean(row.reduceMotion),
    updatedAt: toDate(row.updatedAt)
  } : undefined;
}

export async function updatePreference(
  db: DatabaseExecutor,
  userId: string,
  values: Partial<Omit<PreferenceRecord, "userId" | "updatedAt">>
): Promise<PreferenceRecord | undefined> {
  const fields: string[] = [];
  const params: DatabaseValue[] = [];
  const mapping: Record<string, string> = {
    theme: "theme",
    language: "language",
    reduceMotion: "reduce_motion",
    defaultImageModel: "default_image_model",
    defaultSize: "default_size"
  };
  for (const [key, column] of Object.entries(mapping)) {
    const value = values[key as keyof typeof values];
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      params.push(value as DatabaseValue);
    }
  }
  fields.push("updated_at = ?");
  params.push(new Date(), userId);
  await db.execute(`UPDATE user_preferences SET ${fields.join(", ")} WHERE user_id = ?`, params);
  return getPreference(db, userId);
}

export async function createInvitedUser(
  db: AppDatabase,
  input: { id: string; email: string; passwordHash: string; inviteCode: string; quota: number }
): Promise<
  | { status: "created"; user: UserRecord; sessionId: string }
  | { status: "invite_invalid" }
  | { status: "email_exists" }
> {
  return db.transaction(async (tx) => {
    const invite = await tx.queryOne<{ id: string }>(
      "SELECT id FROM invite_codes WHERE code = ? AND status = 'active'",
      [input.inviteCode]
    );
    if (!invite) return { status: "invite_invalid" } as const;
    const existing = await tx.queryOne<{ id: string }>("SELECT id FROM users WHERE email = ?", [input.email]);
    if (existing) return { status: "email_exists" } as const;
    const now = new Date();
    const sessionId = nanoid(32);
    const sessionExpiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14);
    await tx.execute(`
      INSERT INTO users (id, email, password_hash, role, status, quota, created_at, updated_at)
      VALUES (?, ?, ?, 'user', 'active', ?, ?, ?)
    `, [input.id, input.email, input.passwordHash, input.quota, now, now]);
    await tx.execute(`
      INSERT INTO user_preferences (
        user_id, theme, language, reduce_motion, default_image_model, default_size, updated_at
      ) VALUES (?, 'dark', 'zh', 0, 'gpt-image-2', '1024x1024', ?)
    `, [input.id, now]);
    const changed = await tx.execute(`
      UPDATE invite_codes SET status = 'used', used_by = ?, used_at = ?
      WHERE id = ? AND status = 'active'
    `, [input.id, now, invite.id]);
    if (changed !== 1) throw new Error("Invite code was used concurrently");
    await tx.execute(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      [sessionId, input.id, sessionExpiresAt, now]
    );
    return {
      status: "created",
      sessionId,
      user: {
        id: input.id,
        email: input.email,
        passwordHash: input.passwordHash,
        role: "user",
        status: "active",
        quota: input.quota,
        createdAt: now,
        updatedAt: now
      }
    } as const;
  });
}

export async function listUsers(db: DatabaseExecutor): Promise<UserRecord[]> {
  const rows = await db.query<any>(`SELECT ${userColumns} FROM users ORDER BY created_at DESC, id`);
  return rows.map(normalizeUser);
}

export async function findUserById(db: DatabaseExecutor, id: string): Promise<UserRecord | undefined> {
  const row = await db.queryOne<any>(`SELECT ${userColumns} FROM users WHERE id = ?`, [id]);
  return row ? normalizeUser(row) : undefined;
}

export async function updateUser(
  db: DatabaseExecutor,
  id: string,
  values: { quota?: number; status?: "active" | "disabled" }
): Promise<UserRecord | undefined> {
  const fields = ["updated_at = ?"];
  const params: DatabaseValue[] = [new Date()];
  if (values.quota !== undefined) {
    fields.push("quota = ?");
    params.push(values.quota);
  }
  if (values.status !== undefined) {
    fields.push("status = ?");
    params.push(values.status);
  }
  params.push(id);
  await db.execute(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, params);
  return findUserById(db, id);
}

export async function listProviders(db: DatabaseExecutor): Promise<ProviderRecord[]> {
  const rows = await db.query<any>(`
    SELECT ${providerColumns} FROM provider_configs
    ORDER BY sort_order, created_at, id
  `);
  return rows.map(normalizeProvider);
}

export async function findProvider(db: DatabaseExecutor, id: string): Promise<ProviderRecord | undefined> {
  const row = await db.queryOne<any>(`SELECT ${providerColumns} FROM provider_configs WHERE id = ?`, [id]);
  return row ? normalizeProvider(row) : undefined;
}

export async function insertProvider(db: DatabaseExecutor, provider: ProviderRecord): Promise<void> {
  await db.execute(`
    INSERT INTO provider_configs (
      id, kind, name, base_url, api_key, model, mode, max_concurrency, enabled,
      sort_order, created_at, updated_at, config_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, providerValues(provider));
}

export async function upsertProvider(db: DatabaseExecutor, provider: ProviderRecord): Promise<void> {
  await db.execute(`
    INSERT INTO provider_configs (
      id, kind, name, base_url, api_key, model, mode, max_concurrency, enabled,
      sort_order, created_at, updated_at, config_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      name = excluded.name,
      base_url = excluded.base_url,
      api_key = excluded.api_key,
      model = excluded.model,
      mode = excluded.mode,
      max_concurrency = excluded.max_concurrency,
      config_json = excluded.config_json,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `, providerValues(provider));
}

export async function updateProvider(db: DatabaseExecutor, provider: ProviderRecord): Promise<void> {
  await db.execute(`
    UPDATE provider_configs SET kind = ?, name = ?, base_url = ?, api_key = ?, model = ?,
      mode = ?, max_concurrency = ?, enabled = ?, updated_at = ?, config_json = ?
    WHERE id = ?
  `, [
    provider.kind, provider.name, provider.baseUrl, provider.apiKey, provider.model,
    provider.mode, provider.maxConcurrency, provider.enabled, provider.updatedAt, JSON.stringify({ imageCapabilities: provider.imageCapabilities }), provider.id
  ]);
}

export async function deleteProvider(db: DatabaseExecutor, id: string): Promise<number> {
  return db.execute("DELETE FROM provider_configs WHERE id = ?", [id]);
}

export async function reorderProviders(db: AppDatabase, ids: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    for (const [index, id] of ids.entries()) {
      await tx.execute(
        "UPDATE provider_configs SET sort_order = ?, updated_at = ? WHERE id = ?",
        [index * 10, now, id]
      );
    }
  });
}

export async function listTemplates(db: DatabaseExecutor): Promise<PromptTemplateRecord[]> {
  const rows = await db.query<any>(`
    SELECT id, name, type, target_model AS "targetModel", content, is_default AS "isDefault",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM prompt_templates WHERE type = 'optimize' ORDER BY is_default DESC, created_at DESC, id
  `);
  return rows.map((row) => ({ ...row, isDefault: Boolean(row.isDefault), createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt) }));
}

export async function findTemplate(db: DatabaseExecutor, id: string): Promise<PromptTemplateRecord | undefined> {
  const row = await db.queryOne<any>(`
    SELECT id, name, type, target_model AS "targetModel", content, is_default AS "isDefault",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM prompt_templates WHERE id = ? AND type = 'optimize'
  `, [id]);
  return row ? { ...row, isDefault: Boolean(row.isDefault), createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt) } : undefined;
}

export async function findDefaultTemplate(db: DatabaseExecutor): Promise<PromptTemplateRecord | undefined> {
  const row = await db.queryOne<any>(`
    SELECT id, name, type, target_model AS "targetModel", content, is_default AS "isDefault",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM prompt_templates WHERE type = 'optimize' AND is_default = 1
  `);
  return row ? { ...row, isDefault: Boolean(row.isDefault), createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt) } : undefined;
}

export async function setDefaultTemplate(db: AppDatabase, id: string): Promise<PromptTemplateRecord[] | undefined> {
  return db.transaction(async tx => {
    if (db.dialect === "postgres") await tx.execute("LOCK TABLE prompt_templates IN SHARE ROW EXCLUSIVE MODE");
    if (!await findTemplate(tx, id)) return undefined;
    await tx.execute("UPDATE prompt_templates SET is_default = 0 WHERE type = 'optimize' AND is_default = 1");
    await tx.execute("UPDATE prompt_templates SET is_default = 1, updated_at = ? WHERE id = ?", [new Date(), id]);
    return listTemplates(tx);
  });
}

export async function insertTemplate(db: DatabaseExecutor, template: PromptTemplateRecord): Promise<void> {
  await db.execute(`
    INSERT INTO prompt_templates (id, name, type, target_model, content, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    template.id, template.name, template.type, template.targetModel,
    template.content, template.isDefault, template.createdAt, template.updatedAt
  ]);
}

export async function insertTemplateIfMissing(
  db: DatabaseExecutor,
  template: PromptTemplateRecord
): Promise<boolean> {
  const inserted = await db.execute(`
    INSERT INTO prompt_templates (id, name, type, target_model, content, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `, [
    template.id, template.name, template.type, template.targetModel,
    template.content, template.isDefault, template.createdAt, template.updatedAt
  ]);
  return inserted === 1;
}

export async function updateTemplate(
  db: DatabaseExecutor,
  id: string,
  values: Pick<PromptTemplateRecord, "name" | "type" | "targetModel" | "content">
): Promise<PromptTemplateRecord | undefined> {
  await db.execute(`
    UPDATE prompt_templates
    SET name = ?, type = ?, target_model = ?, content = ?, updated_at = ?
    WHERE id = ?
  `, [values.name, values.type, values.targetModel, values.content, new Date(), id]);
  return findTemplate(db, id);
}

export async function deleteTemplate(db: AppDatabase, id: string): Promise<"missing" | "default" | "deleted"> {
  return db.transaction(async tx => {
    if (db.dialect === "postgres") await tx.execute("LOCK TABLE prompt_templates IN SHARE ROW EXCLUSIVE MODE");
    const template = await findTemplate(tx, id);
    if (!template) return "missing";
    if (template.isDefault) return "default";
    await tx.execute("DELETE FROM prompt_templates WHERE id = ?", [id]);
    return "deleted";
  });
}

export async function listInvites(db: DatabaseExecutor): Promise<InviteRecord[]> {
  const rows = await db.query<any>(`
    SELECT ${inviteColumns} FROM invite_codes ORDER BY created_at DESC, id
  `);
  return rows.map(normalizeInvite);
}

export async function findInvite(db: DatabaseExecutor, id: string): Promise<InviteRecord | undefined> {
  const row = await db.queryOne<any>(`SELECT ${inviteColumns} FROM invite_codes WHERE id = ?`, [id]);
  return row ? normalizeInvite(row) : undefined;
}

export async function findInviteByCode(db: DatabaseExecutor, code: string): Promise<InviteRecord | undefined> {
  const row = await db.queryOne<any>(`SELECT ${inviteColumns} FROM invite_codes WHERE code = ?`, [code]);
  return row ? normalizeInvite(row) : undefined;
}

export async function insertInvite(db: DatabaseExecutor, invite: InviteRecord): Promise<void> {
  await db.execute(`
    INSERT INTO invite_codes (
      id, code, status, created_by, used_by, created_at, used_at, destroyed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    invite.id, invite.code, invite.status, invite.createdBy, invite.usedBy,
    invite.createdAt, invite.usedAt, invite.destroyedAt
  ]);
}

export async function destroyInvite(db: DatabaseExecutor, id: string): Promise<void> {
  await db.execute(`
    UPDATE invite_codes SET status = 'destroyed', destroyed_at = ?
    WHERE id = ? AND status = 'active'
  `, [new Date(), id]);
}

export async function insertGenerationJob(db: DatabaseExecutor, job: GenerationJobRecord): Promise<void> {
  await db.execute(`
    INSERT INTO generation_jobs (
      id, user_id, provider_id, status, prompt, params_json, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    job.id, job.userId, job.providerId, job.status, job.prompt, job.paramsJson,
    job.error, job.createdAt, job.updatedAt
  ]);
}

export async function updateGenerationJob(
  db: DatabaseExecutor,
  id: string,
  values: Partial<Pick<GenerationJobRecord, "providerId" | "status" | "paramsJson" | "error">>
): Promise<void> {
  const fields = ["updated_at = ?"];
  const params: DatabaseValue[] = [new Date()];
  const mapping: Record<string, string> = {
    providerId: "provider_id",
    status: "status",
    paramsJson: "params_json",
    error: "error"
  };
  for (const [key, column] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      fields.push(`${column} = ?`);
      params.push(values[key as keyof typeof values] ?? null);
    }
  }
  params.push(id);
  await db.execute(`UPDATE generation_jobs SET ${fields.join(", ")} WHERE id = ?`, params);
}

export async function listGenerationJobs(db: DatabaseExecutor, userId?: string, limit?: number): Promise<GenerationJobRecord[]> {
  const rows = await db.query<any>(`
    SELECT id, user_id AS "userId", provider_id AS "providerId", status, prompt,
      params_json AS "paramsJson", error, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM generation_jobs ${userId ? "WHERE user_id = ?" : ""} ORDER BY created_at DESC, id
    ${limit ? "LIMIT ?" : ""}
  `, [...(userId ? [userId] : []), ...(limit ? [limit] : [])]);
  return rows.map((row) => ({ ...row, createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt) }));
}

export async function imageGenerationLedger(db: DatabaseExecutor, userId?: string) {
  return db.query<{ userId: string; amount: number; note: string }>(`
    SELECT user_id AS "userId", amount, note FROM usage_ledger
    WHERE action = 'image_generation' ${userId ? "AND user_id = ?" : ""}
  `, userId ? [userId] : []);
}

export async function insertTextToolRun(db: DatabaseExecutor, run: TextToolRunRecord): Promise<void> {
  await db.execute(`
    INSERT INTO text_tool_runs (
      id, user_id, provider_id, type, status, prompt_tokens, completion_tokens,
      total_tokens, duration_ms, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    run.id, run.userId, run.providerId, run.type, run.status, run.promptTokens,
    run.completionTokens, run.totalTokens, run.durationMs, run.error, run.createdAt
  ]);
}

export async function listTextToolRuns(db: DatabaseExecutor): Promise<TextToolRunRecord[]> {
  const rows = await db.query<any>(`
    SELECT id, user_id AS "userId", provider_id AS "providerId", type, status,
      prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens",
      total_tokens AS "totalTokens", duration_ms AS "durationMs", error,
      created_at AS "createdAt"
    FROM text_tool_runs ORDER BY created_at DESC, id
  `);
  return rows.map((row) => ({
    ...row,
    promptTokens: Number(row.promptTokens),
    completionTokens: Number(row.completionTokens),
    totalTokens: Number(row.totalTokens),
    durationMs: Number(row.durationMs),
    createdAt: toDate(row.createdAt)
  }));
}

export async function listAssets(db: DatabaseExecutor): Promise<AssetRecord[]> {
  const rows = await db.query<any>(`SELECT ${assetColumns} FROM assets ORDER BY created_at DESC, id`);
  return rows.map(normalizeAsset);
}

export async function listAssetsWithOwner(
  db: DatabaseExecutor, userId: string, page?: number, pageSize = 20
): Promise<Array<AssetRecord & { ownerEmail: string }>> {
  const pagination = page === undefined ? "" : " LIMIT ? OFFSET ?";
  const values: DatabaseValue[] = [userId];
  if (page !== undefined) values.push(pageSize, (page - 1) * pageSize);
  const rows = await db.query<any>("SELECT " + assetColumns + ", (SELECT email FROM users WHERE users.id = assets.user_id) AS \"ownerEmail\" FROM assets WHERE user_id = ? AND status = 'ready' ORDER BY created_at DESC, id" + pagination, values);
  return rows.map((row) => ({ ...normalizeAsset(row), ownerEmail: String(row.ownerEmail ?? "") }));
}
export async function countOwnedAssets(db: DatabaseExecutor, userId: string): Promise<number> {
  const row = await db.queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM assets WHERE user_id = ? AND status = 'ready'", [userId]);
  return Number(row?.total ?? 0);
}

export async function findAsset(db: DatabaseExecutor, id: string): Promise<AssetRecord | undefined> {
  const row = await db.queryOne<any>(`SELECT ${assetColumns} FROM assets WHERE id = ?`, [id]);
  return row ? normalizeAsset(row) : undefined;
}

export async function insertAsset(db: DatabaseExecutor, asset: AssetRecord): Promise<void> {
  await db.execute(`
    INSERT INTO assets (
      id, user_id, job_id, original_path, thumb_path, storage_backend, mime_type,
      size_bytes, status, expires_at, prompt, params_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, assetValues(asset));
}

export async function insertAssets(db: AppDatabase, assets: AssetRecord[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const asset of assets) {
      await insertAsset(tx, asset);
    }
  });
}

export async function completeAssetUpload(
  db: DatabaseExecutor,
  id: string,
  sizeBytes: number,
  mimeType: string
): Promise<void> {
  await db.execute(`
    UPDATE assets SET status = 'ready', size_bytes = ?, mime_type = ? WHERE id = ?
  `, [sizeBytes, mimeType, id]);
}

export async function updateAssetThumbnail(
  db: DatabaseExecutor,
  id: string,
  thumbPath: string
): Promise<void> {
  await db.execute("UPDATE assets SET thumb_path = ? WHERE id = ?", [thumbPath, id]);
}

export async function deleteAsset(db: DatabaseExecutor, id: string, userId: string): Promise<number> {
  return db.execute("DELETE FROM assets WHERE id = ? AND user_id = ?", [id, userId]);
}

export async function deleteAssets(db: AppDatabase, ids: string[], userId: string): Promise<AssetRecord[]> {
  return db.transaction(async (tx) => {
    const removed: AssetRecord[] = [];
    for (const id of ids) {
      const row = await tx.queryOne<any>(`SELECT ${assetColumns} FROM assets WHERE id = ? AND user_id = ?`, [id, userId]);
      if (!row) continue;
      removed.push(normalizeAsset(row));
      await tx.execute("DELETE FROM assets WHERE id = ? AND user_id = ?", [id, userId]);
    }
    return removed;
  });
}

export async function listExpiredAssets(db: DatabaseExecutor, now: Date): Promise<AssetRecord[]> {
  const rows = await db.query<any>(`
    SELECT ${assetColumns} FROM assets
    WHERE expires_at IS NOT NULL AND expires_at <= ?
    ORDER BY expires_at
  `, [now]);
  return rows.map(normalizeAsset);
}

export async function listGallery(db: DatabaseExecutor): Promise<GalleryItemRecord[]> {
  const rows = await db.query<any>(`SELECT ${galleryColumns} FROM gallery_items ORDER BY created_at DESC, id`);
  return rows.map(normalizeGallery);
}

export async function listGalleryWithAuthor(
  db: DatabaseExecutor
): Promise<Array<GalleryItemRecord & { authorEmail: string }>> {
  const rows = await db.query<any>(`
    SELECT ${galleryColumns},
      (SELECT email FROM users WHERE users.id = gallery_items.user_id) AS "authorEmail"
    FROM gallery_items ORDER BY created_at DESC, id
  `);
  return rows.map((row) => ({ ...normalizeGallery(row), authorEmail: String(row.authorEmail ?? "") }));
}

export async function findGalleryByAsset(db: DatabaseExecutor, assetId: string): Promise<GalleryItemRecord | undefined> {
  const row = await db.queryOne<any>(`SELECT ${galleryColumns} FROM gallery_items WHERE asset_id = ?`, [assetId]);
  return row ? normalizeGallery(row) : undefined;
}

export async function findGallery(db: DatabaseExecutor, id: string): Promise<GalleryItemRecord | undefined> {
  const row = await db.queryOne<any>(`SELECT ${galleryColumns} FROM gallery_items WHERE id = ?`, [id]);
  return row ? normalizeGallery(row) : undefined;
}

export async function insertGallery(db: DatabaseExecutor, item: GalleryItemRecord): Promise<number> {
  return db.execute(`
    INSERT INTO gallery_items (
      id, asset_id, user_id, title, prompt, status, object_key,
      reviewed_by, reviewed_at, rejection_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(asset_id) DO NOTHING
  `, [
    item.id, item.assetId, item.userId, item.title, item.prompt, item.status,
    item.objectKey, item.reviewedBy, item.reviewedAt, item.rejectionReason, item.createdAt
  ]);
}

export async function reviewGallery(
  db: DatabaseExecutor,
  id: string,
  input: {
    status: "approved" | "rejected";
    objectKey: string | null;
    reviewedBy: string;
    rejectionReason: string | null;
  }
): Promise<number> {
  return db.execute(`
    UPDATE gallery_items SET status = ?, object_key = ?, reviewed_by = ?,
      reviewed_at = ?, rejection_reason = ?
    WHERE id = ? AND status = 'pending'
  `, [
    input.status, input.objectKey, input.reviewedBy, new Date(),
    input.rejectionReason, id
  ]);
}

export async function listCustomGalleryTags(db: DatabaseExecutor): Promise<GalleryTag[]> {
  const rows = await db.query<{ id: string; label: string; group_id: GalleryTag["group"] }>(
    "SELECT id, label, group_id FROM gallery_tags ORDER BY created_at ASC"
  );
  return rows.map((row) => ({ id: row.id, label: row.label, aliases: [], group: row.group_id }));
}

export async function listAllGalleryTags(db: DatabaseExecutor): Promise<GalleryTag[]> {
  return [...GALLERY_TAGS, ...await listCustomGalleryTags(db)];
}

export async function createCustomGalleryTag(
  db: DatabaseExecutor,
  input: { label: string; group: GalleryTag["group"]; createdBy: string }
): Promise<{ tag: GalleryTag; created: boolean }> {
  const tag: GalleryTag = { id: `custom-${randomBytes(4).toString("hex")}`, label: input.label, aliases: [], group: input.group };
  const created = await db.execute(
    `INSERT INTO gallery_tags (id, label, group_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(LOWER(label)) DO NOTHING`,
    [tag.id, tag.label, tag.group, input.createdBy, new Date()]
  );
  if (created) return { tag, created: true };
  const existing = await db.queryOne<{ id: string; label: string; group_id: GalleryTag["group"] }>(
    "SELECT id, label, group_id FROM gallery_tags WHERE LOWER(label) = LOWER(?)", [input.label]
  );
  return { tag: { id: existing!.id, label: existing!.label, aliases: [], group: existing!.group_id }, created: false };
}

export async function listGalleryTags(db: DatabaseExecutor, itemIds: string[]): Promise<Map<string, GalleryTag[]>> {
  const result = new Map<string, GalleryTag[]>();
  if (!itemIds.length) return result;
  const allTags = await listAllGalleryTags(db);
  // Batch within SQLite's variable limit; lists and paginated feeds never query per item.
  for (let offset = 0; offset < itemIds.length; offset += 500) {
    const ids = itemIds.slice(offset, offset + 500);
    const rows = await db.query<{ gallery_item_id: string; tag_id: string }>(
      `SELECT gallery_item_id, tag_id FROM gallery_item_tags WHERE gallery_item_id IN (${ids.map(() => "?").join(",")})`, ids
    );
    const selected = new Map<string, Set<string>>();
    for (const row of rows) {
      const tags = selected.get(row.gallery_item_id) ?? new Set<string>();
      tags.add(row.tag_id);
      selected.set(row.gallery_item_id, tags);
    }
    for (const id of ids) result.set(id, allTags.filter((tag) => selected.get(id)?.has(tag.id)));
  }
  return result;
}

export async function replaceGalleryTags(db: DatabaseExecutor, itemId: string, tagIds: string[]): Promise<void> {
  await db.execute("DELETE FROM gallery_item_tags WHERE gallery_item_id = ?", [itemId]);
  for (const tagId of tagIds) {
    await db.execute("INSERT INTO gallery_item_tags (gallery_item_id, tag_id) VALUES (?, ?)", [itemId, tagId]);
  }
}

export async function expireGallery(db: DatabaseExecutor, id: string): Promise<void> {
  await db.execute(`
    UPDATE gallery_items SET status = 'rejected', object_key = NULL,
      reviewed_at = ?, rejection_reason = '审核超时自动清理'
    WHERE id = ? AND status = 'pending'
  `, [new Date(), id]);
}

export async function listStalePendingGallery(
  db: DatabaseExecutor,
  createdBefore: Date
): Promise<GalleryItemRecord[]> {
  const rows = await db.query<any>(`
    SELECT ${galleryColumns} FROM gallery_items
    WHERE status = 'pending' AND created_at <= ?
    ORDER BY created_at
  `, [createdBefore]);
  return rows.map(normalizeGallery);
}

export async function clearAssetExpiry(db: DatabaseExecutor, assetId: string): Promise<void> {
  await db.execute("UPDATE assets SET expires_at = NULL WHERE id = ?", [assetId]);
}

export async function updateAssetStorage(
  db: DatabaseExecutor,
  assetId: string,
  input: { originalPath: string; storageBackend: "local" | "r2"; expiresAt: Date | null }
): Promise<void> {
  await db.execute(`
    UPDATE assets SET original_path = ?, storage_backend = ?, expires_at = ? WHERE id = ?
  `, [input.originalPath, input.storageBackend, input.expiresAt, assetId]);
}

export async function deleteGalleryByAsset(db: DatabaseExecutor, assetId: string): Promise<number> {
  return db.execute("DELETE FROM gallery_items WHERE asset_id = ?", [assetId]);
}

export async function listQuotaRules(db: DatabaseExecutor): Promise<QuotaPricingRuleRecord[]> {
  const rows = await db.query<any>(`
    SELECT key, label, amount, updated_at AS "updatedAt"
    FROM quota_pricing_rules ORDER BY key
  `);
  return rows.map((row) => ({ ...row, amount: Number(row.amount), updatedAt: toDate(row.updatedAt) }));
}

export async function findQuotaRule(db: DatabaseExecutor, key: string): Promise<QuotaPricingRuleRecord | undefined> {
  const row = await db.queryOne<any>(`
    SELECT key, label, amount, updated_at AS "updatedAt"
    FROM quota_pricing_rules WHERE key = ?
  `, [key]);
  return row ? { ...row, amount: Number(row.amount), updatedAt: toDate(row.updatedAt) } : undefined;
}

export async function upsertQuotaRule(db: DatabaseExecutor, rule: QuotaPricingRuleRecord): Promise<void> {
  await db.execute(`
    INSERT INTO quota_pricing_rules (key, label, amount, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET label = excluded.label, amount = excluded.amount, updated_at = excluded.updated_at
  `, [rule.key, rule.label, rule.amount, rule.updatedAt]);
}

export async function updateQuotaRule(db: DatabaseExecutor, key: string, amount: number): Promise<void> {
  await db.execute(
    "UPDATE quota_pricing_rules SET amount = ?, updated_at = ? WHERE key = ?",
    [amount, new Date(), key]
  );
}

export async function getQuota(db: DatabaseExecutor, userId: string): Promise<number> {
  const row = await db.queryOne<{ quota: number }>("SELECT quota FROM users WHERE id = ?", [userId]);
  return Number(row?.quota ?? 0);
}

export async function consumeQuota(
  db: AppDatabase,
  input: {
    userId: string;
    amount: number;
    action: string;
    note: string;
    completedJob?: {
      id: string;
      providerId: string;
      paramsJson: string;
    };
  }
): Promise<{ consumed: boolean; quota: number }> {
  return db.transaction(async (tx) => {
    const changed = await tx.execute(`
      UPDATE users SET quota = quota - ?, updated_at = ?
      WHERE id = ? AND quota >= ?
    `, [input.amount, new Date(), input.userId, input.amount]);
    const quota = await getQuota(tx, input.userId);
    if (changed !== 1) return { consumed: false, quota };
    await tx.execute(`
      INSERT INTO usage_ledger (id, user_id, action, amount, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [nanoid(), input.userId, input.action, -input.amount, input.note, new Date()]);
    if (input.completedJob) {
      await tx.execute(`
        UPDATE generation_jobs SET status = 'succeeded', provider_id = ?,
          params_json = ?, error = NULL, updated_at = ?
        WHERE id = ?
      `, [
        input.completedJob.providerId,
        input.completedJob.paramsJson,
        new Date(),
        input.completedJob.id
      ]);
    }
    return { consumed: true, quota };
  });
}

export async function listPrompts(db: DatabaseExecutor): Promise<Array<PromptRecord & { tags: string[] }>> {
  const rows = await db.query<any>(`
    SELECT id, user_id AS "userId", zh, en, category,
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM prompts ORDER BY created_at DESC, id
  `);
  const tags = await db.query<{ promptId: string; name: string }>(`
    SELECT ppt.prompt_id AS "promptId", pt.name
    FROM prompt_prompt_tags ppt
    JOIN prompt_tags pt ON pt.id = ppt.tag_id
    ORDER BY ppt.prompt_id, pt.name
  `);
  const tagsByPrompt = new Map<string, string[]>();
  for (const tag of tags) {
    const values = tagsByPrompt.get(tag.promptId) ?? [];
    values.push(tag.name);
    tagsByPrompt.set(tag.promptId, values);
  }
  return rows.map((row) => ({
    ...row,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    tags: tagsByPrompt.get(row.id) ?? []
  }));
}

export async function insertPrompt(
  db: AppDatabase,
  prompt: PromptRecord,
  tagNames: string[]
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(`
      INSERT INTO prompts (id, user_id, zh, en, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      prompt.id, prompt.userId, prompt.zh, prompt.en, prompt.category,
      prompt.createdAt, prompt.updatedAt
    ]);
    for (const rawName of tagNames) {
      const name = rawName.trim();
      if (!name) continue;
      let tag = await tx.queryOne<{ id: string }>("SELECT id FROM prompt_tags WHERE name = ?", [name]);
      if (!tag) {
        tag = { id: nanoid() };
        await tx.execute("INSERT INTO prompt_tags (id, name) VALUES (?, ?)", [tag.id, name]);
      }
      await tx.execute(`
        INSERT INTO prompt_prompt_tags (prompt_id, tag_id)
        SELECT ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM prompt_prompt_tags WHERE prompt_id = ? AND tag_id = ?
        )
      `, [prompt.id, tag.id, prompt.id, tag.id]);
    }
  });
}

export async function insertPromptIfMissing(
  db: AppDatabase,
  prompt: PromptRecord,
  tagNames: string[]
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const inserted = await tx.execute(`
      INSERT INTO prompts (id, user_id, zh, en, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `, [
      prompt.id, prompt.userId, prompt.zh, prompt.en, prompt.category,
      prompt.createdAt, prompt.updatedAt
    ]);
    if (inserted !== 1) return false;
    for (const rawName of tagNames) {
      const name = rawName.trim();
      if (!name) continue;
      let tag = await tx.queryOne<{ id: string }>("SELECT id FROM prompt_tags WHERE name = ?", [name]);
      if (!tag) {
        tag = { id: nanoid() };
        await tx.execute("INSERT INTO prompt_tags (id, name) VALUES (?, ?)", [tag.id, name]);
      }
      await tx.execute(`
        INSERT INTO prompt_prompt_tags (prompt_id, tag_id)
        SELECT ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM prompt_prompt_tags WHERE prompt_id = ? AND tag_id = ?
        )
      `, [prompt.id, tag.id, prompt.id, tag.id]);
    }
    return true;
  });
}

export async function consumeRateLimit(
  db: AppDatabase,
  key: string,
  limit: number,
  windowMs: number
): Promise<boolean> {
  const now = Date.now();
  const row = await db.queryOne<{ count: number | string }>(`
    INSERT INTO rate_limits (key, count, window_started_at, expires_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.expires_at <= ? THEN 1
        WHEN rate_limits.count >= ? THEN ?
        ELSE rate_limits.count + 1
      END,
      window_started_at = CASE
        WHEN rate_limits.expires_at <= ? THEN excluded.window_started_at
        ELSE rate_limits.window_started_at
      END,
      expires_at = CASE
        WHEN rate_limits.expires_at <= ? THEN excluded.expires_at
        ELSE rate_limits.expires_at
      END
    RETURNING count
  `, [key, now, now + windowMs, now, limit, limit + 1, now, now]);
  return Number(row?.count ?? limit + 1) <= limit;
}

export async function deleteExpiredRateLimits(db: DatabaseExecutor, now = new Date()): Promise<number> {
  return db.execute("DELETE FROM rate_limits WHERE expires_at <= ?", [now]);
}

export async function writeAuditLog(
  db: DatabaseExecutor,
  input: {
    actorUserId?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  await db.execute(`
    INSERT INTO audit_logs (
      id, actor_user_id, action, target_type, target_id, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    nanoid(), input.actorUserId ?? null, input.action, input.targetType ?? null,
    input.targetId ?? null, JSON.stringify(input.detail ?? {}), new Date()
  ]);
}

function providerValues(provider: ProviderRecord): DatabaseValue[] {
  return [
    provider.id, provider.kind, provider.name, provider.baseUrl, provider.apiKey,
    provider.model, provider.mode, provider.maxConcurrency, provider.enabled,
    provider.sortOrder, provider.createdAt, provider.updatedAt, JSON.stringify({ imageCapabilities: provider.imageCapabilities })
  ];
}

function assetValues(asset: AssetRecord): DatabaseValue[] {
  return [
    asset.id, asset.userId, asset.jobId, asset.originalPath, asset.thumbPath,
    asset.storageBackend, asset.mimeType, asset.sizeBytes, asset.status,
    asset.expiresAt, asset.prompt, asset.paramsJson, asset.createdAt
  ];
}

function normalizeUser(row: any): UserRecord {
  return {
    ...row,
    quota: Number(row.quota),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt)
  };
}

function normalizeProvider(row: any): ProviderRecord {
  const { configJson, ...record } = row;
  return {
    ...record,
    imageCapabilities: JSON.parse(configJson || "{}").imageCapabilities,
    maxConcurrency: Number(row.maxConcurrency),
    enabled: toBoolean(row.enabled),
    sortOrder: Number(row.sortOrder),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt)
  };
}

function normalizeInvite(row: any): InviteRecord {
  return {
    ...row,
    createdAt: toDate(row.createdAt),
    usedAt: nullableDate(row.usedAt),
    destroyedAt: nullableDate(row.destroyedAt)
  };
}

function normalizeAsset(row: any): AssetRecord {
  return {
    ...row,
    sizeBytes: row.sizeBytes === null || row.sizeBytes === undefined ? null : Number(row.sizeBytes),
    expiresAt: nullableDate(row.expiresAt),
    createdAt: toDate(row.createdAt)
  };
}

function normalizeGallery(row: any): GalleryItemRecord {
  return {
    ...row,
    reviewedAt: nullableDate(row.reviewedAt),
    createdAt: toDate(row.createdAt)
  };
}

function toBoolean(value: BooleanValue): boolean {
  return value === true || value === 1 || value === "1";
}

function toDate(value: Timestamp | Date): Date {
  return value instanceof Date ? value : new Date(Number(value));
}

function nullableDate(value: Timestamp | Date | null | undefined): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

/** Persistently reserve balance before upstream work; settlement is idempotent. */
export async function reserveImageQuota(db: AppDatabase, userId: string, jobId: string, amount: number) {
  return db.transaction(async tx => {
    const changed = await tx.execute("UPDATE users SET quota = quota - ?, updated_at = ? WHERE id = ? AND quota >= ?", [amount, new Date(), userId, amount]);
    if (changed !== 1) return false;
    await tx.execute("INSERT INTO image_quota_reservations (job_id,user_id,amount,state) VALUES (?,?,?,'reserved')", [jobId,userId,amount]);
    return true;
  });
}
export async function refundImageQuota(db: AppDatabase, userId: string, jobId: string) {
  await db.transaction(async tx => {
    const row = await tx.queryOne<{amount:number}>("SELECT amount FROM image_quota_reservations WHERE job_id = ? AND user_id = ? AND state = 'reserved'", [jobId,userId]);
    if (!row) return;
    const changed = await tx.execute("UPDATE image_quota_reservations SET state = 'refunded' WHERE job_id = ? AND user_id = ? AND state = 'reserved'", [jobId,userId]);
    if (changed === 1) await tx.execute("UPDATE users SET quota = quota + ?, updated_at = ? WHERE id = ?", [Number(row.amount),new Date(),userId]);
  });
}
export async function settleImageQuota(db: AppDatabase, userId: string, jobId: string, amount: number, note: string, providerId: string, paramsJson: string) {
  return db.transaction(async tx => {
    const row = await tx.queryOne<{amount:number;state:string}>("SELECT amount,state FROM image_quota_reservations WHERE job_id = ? AND user_id = ?", [jobId,userId]);
    if (!row || row.state === 'refunded' || amount > Number(row.amount)) throw new Error("Invalid image quota reservation");
    if (row.state === 'settled') return getQuota(tx,userId);
    const changed = await tx.execute("UPDATE image_quota_reservations SET state = 'settled' WHERE job_id = ? AND user_id = ? AND state = 'reserved'", [jobId,userId]);
    if (changed !== 1) throw new Error("Image quota reservation already finalized");
    await tx.execute("UPDATE users SET quota = quota + ?, updated_at = ? WHERE id = ?", [Number(row.amount)-amount,new Date(),userId]);
    await tx.execute("INSERT INTO usage_ledger (id,user_id,action,amount,note,created_at) VALUES (?,?,?,?,?,?)", [nanoid(),userId,'image_generation',-amount,note,new Date()]);
    await tx.execute("UPDATE generation_jobs SET status = 'succeeded', provider_id = ?, params_json = ?, error = NULL, updated_at = ? WHERE id = ? AND user_id = ?", [providerId,paramsJson,new Date(),jobId,userId]);
    return getQuota(tx,userId);
  });
}
