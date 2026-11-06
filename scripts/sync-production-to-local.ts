import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../apps/api/src/config/env";
import { migrate } from "../apps/api/src/db/migrate";
import { hashPassword } from "../apps/api/src/services/authService";

type RemoteUser = {
  id: string;
  email: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  quota: number;
  createdAt?: string;
  updatedAt?: string;
};

type RemoteProvider = {
  id: string;
  kind: "image" | "text";
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  mode: string;
  maxConcurrency?: number;
  enabled?: boolean;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
};

type RemoteTemplate = {
  id: string;
  name: string;
  type: "translate" | "optimize";
  targetModel: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
};

type RemotePrompt = {
  id: string;
  zh: string;
  en: string;
  category: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
};

type RemoteAsset = {
  id: string;
  imageUrl: string;
  ownerEmail?: string | null;
  prompt: string;
  params?: Record<string, unknown>;
  createdAt: string;
  expiresAt?: string | null;
};

type RemoteGalleryItem = {
  id: string;
  assetId: string;
  userId: string;
  title: string;
  prompt: string;
  tags?: { id: string }[];
  status: "pending" | "approved" | "rejected";
  rejectionReason?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
};

type DownloadedAsset = {
  asset: RemoteAsset;
  bytes: Buffer;
  mimeType: string;
  objectKey: string;
  remoteOwnerId: string | null;
};

if (!process.argv.includes("--confirm-replace-local")) {
  throw new Error("Refusing to replace local data without --confirm-replace-local");
}

const config = loadConfig();
const source = new URL(process.env.PAINTOPIA_SYNC_SOURCE ?? "https://paintopia.b1mango.cc");
if (source.protocol !== "https:" || source.hostname === "localhost" || source.hostname === "127.0.0.1") {
  throw new Error("PAINTOPIA_SYNC_SOURCE must be a remote HTTPS origin");
}

const cookie = await login();
const [users, providers, templates, prompts, assets, gallery] = await Promise.all([
  apiJson<RemoteUser[]>("/api/admin/users"),
  apiJson<RemoteProvider[]>("/api/admin/providers"),
  apiJson<RemoteTemplate[]>("/api/admin/templates"),
  apiJson<RemotePrompt[]>("/api/prompts"),
  apiJson<RemoteAsset[]>("/api/assets"),
  apiJson<RemoteGalleryItem[]>("/api/gallery")
]);

const dataDir = config.dataDir;
const databasePath = path.join(dataDir, "paintopia.sqlite");
const exportDir = path.join(dataDir, "exports");
const objectDir = path.join(dataDir, "objects");
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = path.join(exportDir, `paintopia-before-production-sync-${timestamp}.sqlite`);
await mkdir(exportDir, { recursive: true });
await mkdir(objectDir, { recursive: true });
await copyFile(databasePath, backupPath);

const galleryOwnerByAsset = new Map(gallery.map((item) => [item.assetId, item.userId]));
const downloads = await mapWithConcurrency(assets, 3, async (asset) => {
  const downloaded = await downloadAsset(asset, galleryOwnerByAsset.get(asset.id) ?? null);
  const target = path.join(objectDir, ...downloaded.objectKey.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, downloaded.bytes);
  return downloaded;
});

const database = new Database(databasePath);
migrate(database);
database.pragma("foreign_keys = ON");

try {
  const localUsers = database.prepare(`
    SELECT id, email, password_hash AS passwordHash FROM users
  `).all() as Array<{ id: string; email: string; passwordHash: string }>;
  const passwordByEmail = new Map(localUsers.map((user) => [user.email.toLowerCase(), user.passwordHash]));
  const localIdByEmail = new Map(localUsers.map((user) => [user.email.toLowerCase(), user.id]));
  const effectiveUserId = new Map<string, string>();

  for (const user of users) {
    effectiveUserId.set(user.id, localIdByEmail.get(user.email.toLowerCase()) ?? user.id);
  }
  const admin = users.find((user) => user.role === "admin") ?? users[0];
  if (!admin) throw new Error("Production returned no users");
  const fallbackUserId = effectiveUserId.get(admin.id) ?? admin.id;

  const localProviders = database.prepare(`
    SELECT id, kind, name, base_url AS baseUrl, api_key AS apiKey FROM provider_configs
  `).all() as Array<{ id: string; kind: string; name: string; baseUrl: string; apiKey: string }>;
  const keyById = new Map(localProviders.map((provider) => [provider.id, provider.apiKey]));
  const keyByFingerprint = new Map(localProviders.map((provider) => [
    providerFingerprint(provider),
    provider.apiKey
  ]));
  const providerKeys = new Map<string, string>();
  for (const provider of providers) {
    const apiKey = keyById.get(provider.id) ?? keyByFingerprint.get(providerFingerprint(provider));
    if (!apiKey) {
      throw new Error(`Local API key is missing for production provider ${provider.name}`);
    }
    providerKeys.set(provider.id, apiKey);
  }

  const applySnapshot = database.transaction(() => {
    const upsertUser = database.prepare(`
      INSERT INTO users (id, email, password_hash, role, status, quota, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        role = excluded.role,
        status = excluded.status,
        quota = excluded.quota,
        updated_at = excluded.updated_at
    `);
    const insertPreference = database.prepare(`
      INSERT INTO user_preferences (
        user_id, theme, language, reduce_motion, default_image_model, default_size, updated_at
      ) VALUES (?, 'dark', 'zh', 0, 'gpt-image-2', '1024x1024', ?)
      ON CONFLICT(user_id) DO NOTHING
    `);
    for (const user of users) {
      const id = effectiveUserId.get(user.id) ?? user.id;
      const passwordHash = passwordByEmail.get(user.email.toLowerCase())
        ?? hashPassword(randomBytes(48).toString("base64url"));
      upsertUser.run(
        id,
        user.email,
        passwordHash,
        user.role,
        user.status,
        user.quota,
        dateValue(user.createdAt),
        dateValue(user.updatedAt)
      );
      insertPreference.run(id, Date.now());
    }
    database.prepare("DELETE FROM sessions").run();

    database.prepare("DELETE FROM provider_configs").run();
    const insertProvider = database.prepare(`
      INSERT INTO provider_configs (
        id, kind, name, base_url, api_key, model, mode, max_concurrency,
        enabled, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const provider of providers) {
      insertProvider.run(
        provider.id,
        provider.kind,
        provider.name,
        provider.baseUrl,
        providerKeys.get(provider.id),
        provider.model,
        provider.mode,
        provider.maxConcurrency ?? 1,
        provider.enabled === false ? 0 : 1,
        provider.sortOrder ?? 0,
        dateValue(provider.createdAt),
        dateValue(provider.updatedAt)
      );
    }

    database.prepare("DELETE FROM prompt_templates").run();
    const insertTemplate = database.prepare(`
      INSERT INTO prompt_templates (
        id, name, type, target_model, content, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const template of templates) {
      insertTemplate.run(
        template.id,
        template.name,
        template.type,
        template.targetModel,
        template.content,
        dateValue(template.createdAt),
        dateValue(template.updatedAt)
      );
    }

    database.prepare("DELETE FROM prompt_favorites").run();
    database.prepare("DELETE FROM prompt_prompt_tags").run();
    database.prepare("DELETE FROM prompt_tags").run();
    database.prepare("DELETE FROM prompts").run();
    const insertPrompt = database.prepare(`
      INSERT INTO prompts (id, user_id, zh, en, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTag = database.prepare("INSERT OR IGNORE INTO prompt_tags (id, name) VALUES (?, ?)");
    const insertPromptTag = database.prepare(`
      INSERT INTO prompt_prompt_tags (prompt_id, tag_id) VALUES (?, ?)
    `);
    for (const prompt of prompts) {
      insertPrompt.run(
        prompt.id,
        fallbackUserId,
        prompt.zh,
        prompt.en,
        prompt.category,
        dateValue(prompt.createdAt),
        dateValue(prompt.updatedAt)
      );
      for (const tag of new Set((prompt.tags ?? []).map((value) => value.trim()).filter(Boolean))) {
        const tagId = `sync-${createHash("sha256").update(tag).digest("hex").slice(0, 24)}`;
        insertTag.run(tagId, tag);
        insertPromptTag.run(prompt.id, tagId);
      }
    }

    database.prepare("DELETE FROM gallery_item_tags").run();
    database.prepare("DELETE FROM gallery_items").run();
    database.prepare("DELETE FROM assets").run();
    const insertAsset = database.prepare(`
      INSERT INTO assets (
        id, user_id, job_id, original_path, thumb_path, storage_backend,
        mime_type, size_bytes, status, expires_at, prompt, params_json, created_at
      ) VALUES (?, ?, NULL, ?, NULL, 'local', ?, ?, 'ready', ?, ?, ?, ?)
    `);
    for (const downloaded of downloads) {
      const remoteOwnerId = downloaded.remoteOwnerId ?? galleryOwnerByAsset.get(downloaded.asset.id) ?? null;
      const userId = remoteOwnerId ? effectiveUserId.get(remoteOwnerId) ?? remoteOwnerId : fallbackUserId;
      insertAsset.run(
        downloaded.asset.id,
        userId,
        downloaded.objectKey,
        downloaded.mimeType,
        downloaded.bytes.length,
        downloaded.asset.expiresAt ? dateValue(downloaded.asset.expiresAt) : null,
        downloaded.asset.prompt,
        JSON.stringify(downloaded.asset.params ?? {}),
        dateValue(downloaded.asset.createdAt)
      );
    }

    const insertGallery = database.prepare(`
      INSERT INTO gallery_items (
        id, asset_id, user_id, title, prompt, status, object_key,
        reviewed_by, reviewed_at, rejection_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `);
    const insertGalleryTag = database.prepare("INSERT INTO gallery_item_tags (gallery_item_id, tag_id) VALUES (?, ?)");
    for (const item of gallery) {
      insertGallery.run(
        item.id,
        item.assetId,
        effectiveUserId.get(item.userId) ?? item.userId,
        item.title,
        item.prompt,
        item.status,
        item.reviewedAt ? dateValue(item.reviewedAt) : null,
        item.rejectionReason ?? null,
        dateValue(item.createdAt)
      );
      for (const tagId of new Set((item.tags ?? []).map((tag) => tag.id))) {
        insertGalleryTag.run(item.id, tagId);
      }
    }
  });

  applySnapshot();
  process.stdout.write(JSON.stringify({
    ok: true,
    source: source.origin,
    backupPath,
    users: users.length,
    providers: providers.length,
    providerKeysPreserved: providerKeys.size,
    templates: templates.length,
    prompts: prompts.length,
    assets: downloads.length,
    gallery: gallery.length,
    galleryTags: gallery.reduce((count, item) => count + (item.tags?.length ?? 0), 0),
    note: "Sessions were cleared; code-managed prompts, templates and pricing are restored on API startup."
  }, null, 2) + "\n");
} finally {
  database.close();
}

async function login() {
  const response = await fetch(new URL("/api/auth/login", source), {
    method: "POST",
    headers: requestHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ email: config.bootstrapEmail, password: config.bootstrapPassword }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Production login failed with status ${response.status}`);
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const value = setCookies.filter(Boolean).map((item) => item.split(";", 1)[0]).join("; ");
  if (!value) throw new Error("Production login did not return a session cookie");
  return value;
}

async function apiJson<T>(pathname: string): Promise<T> {
  const response = await fetch(new URL(pathname, source), {
    headers: requestHeaders({ Cookie: cookie }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`${pathname} returned status ${response.status}`);
  return response.json() as Promise<T>;
}

async function downloadAsset(asset: RemoteAsset, galleryOwnerId: string | null): Promise<DownloadedAsset> {
  let response = await fetch(new URL(asset.imageUrl, source), {
    headers: requestHeaders({ Cookie: cookie }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000)
  });
  let remoteOwnerId = galleryOwnerId;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`Asset ${asset.id} redirect has no location`);
    remoteOwnerId ??= ownerFromObjectUrl(location);
    response = await fetch(location, { signal: AbortSignal.timeout(60_000) });
  }
  if (!response.ok) throw new Error(`Asset ${asset.id} returned status ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = imageMimeType(response.headers.get("content-type"), bytes);
  const objectKey = `production-sync/${asset.id}.${extensionForMime(mimeType)}`;
  return { asset, bytes, mimeType, objectKey, remoteOwnerId };
}

function requestHeaders(extra: Record<string, string> = {}) {
  return {
    Origin: source.origin,
    Referer: `${source.origin}/`,
    Accept: "application/json",
    "User-Agent": "Paintopia-Production-Sync/1.0",
    ...extra
  };
}

function ownerFromObjectUrl(value: string) {
  const parts = decodeURIComponent(new URL(value).pathname).split("/").filter(Boolean);
  const prefixIndex = parts.findIndex((part) => part === "temporary" || part === "pending" || part === "permanent");
  return prefixIndex >= 0 ? parts[prefixIndex + 1] ?? null : null;
}

function providerFingerprint(provider: { kind: string; name: string; baseUrl: string }) {
  return `${provider.kind}\u0000${provider.name.trim().toLowerCase()}\u0000${provider.baseUrl.replace(/\/+$/, "").toLowerCase()}`;
}

function dateValue(value?: string) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function imageMimeType(contentType: string | null, bytes: Buffer) {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp") return normalized;
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "image/png";
}

function extensionForMime(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}
