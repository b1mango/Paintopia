import path from "node:path";
import dotenv from "dotenv";
import type { TextProviderMode } from "@paintopia/shared";
import { parseProhibitedTerms } from "../services/contentSafety.js";

const workspaceRoot = resolveWorkspaceRoot();
dotenv.config({ path: path.resolve(workspaceRoot, ".env") });

export type PaintopiaConfig = {
  host: string;
  apiPort: number;
  webOrigin: string;
  dataDir: string;
  bootstrapEmail: string;
  bootstrapPassword: string;
  ownerEmail: string;
  inviteCode: string;
  sessionSecret: string;
  databaseUrl?: string;
  providerEncryptionKey?: string;
  production: boolean;
  assetRetentionDays: number;
  pendingGalleryRetentionDays: number;
  cronSecret?: string;
  prohibitedTerms: string[];
  r2?: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
  defaultTextProvider?: {
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    mode: TextProviderMode;
  };
};

export function loadConfig(): PaintopiaConfig {
  const defaultTextApiKey = process.env.PAINTOPIA_DEFAULT_TEXT_API_KEY?.trim();

  const r2AccountId = process.env.PAINTOPIA_R2_ACCOUNT_ID?.trim();
  const r2AccessKeyId = process.env.PAINTOPIA_R2_ACCESS_KEY_ID?.trim();
  const r2SecretAccessKey = process.env.PAINTOPIA_R2_SECRET_ACCESS_KEY?.trim();
  const r2Bucket = process.env.PAINTOPIA_R2_BUCKET?.trim();
  const production = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
  const webOrigin = process.env.PAINTOPIA_WEB_ORIGIN ?? "http://localhost:5173";

  return {
    host: process.env.PAINTOPIA_HOST ?? "127.0.0.1",
    apiPort: Number(process.env.PORT ?? process.env.PAINTOPIA_API_PORT ?? (process.env.VERCEL ? 3000 : 8787)),
    webOrigin,
    dataDir: path.resolve(workspaceRoot, process.env.PAINTOPIA_DATA_DIR ?? "data"),
    bootstrapEmail: process.env.PAINTOPIA_BOOTSTRAP_EMAIL ?? "admin@paintopia.local",
    bootstrapPassword: process.env.PAINTOPIA_BOOTSTRAP_PASSWORD ?? "paintopia123",
    ownerEmail: process.env.PAINTOPIA_OWNER_EMAIL?.trim() || process.env.PAINTOPIA_BOOTSTRAP_EMAIL || "admin@paintopia.local",
    inviteCode: process.env.PAINTOPIA_INVITE_CODE ?? "",
    sessionSecret: process.env.PAINTOPIA_SESSION_SECRET ?? "paintopia-local-dev-session",
    databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
    providerEncryptionKey: process.env.PAINTOPIA_PROVIDER_ENCRYPTION_KEY?.trim() || undefined,
    production,
    assetRetentionDays: positiveInteger(process.env.PAINTOPIA_ASSET_RETENTION_DAYS, 7),
    pendingGalleryRetentionDays: positiveInteger(process.env.PAINTOPIA_PENDING_GALLERY_RETENTION_DAYS, 30),
    cronSecret: process.env.CRON_SECRET?.trim() || undefined,
    prohibitedTerms: parseProhibitedTerms(process.env.PAINTOPIA_PROHIBITED_TERMS),
    r2: r2AccountId && r2AccessKeyId && r2SecretAccessKey && r2Bucket
      ? {
        accountId: r2AccountId,
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
        bucket: r2Bucket
      }
      : undefined,
    defaultTextProvider: defaultTextApiKey
      ? {
        name: process.env.PAINTOPIA_DEFAULT_TEXT_PROVIDER_NAME ?? "GPT-5 Nano",
        baseUrl: process.env.PAINTOPIA_DEFAULT_TEXT_BASE_URL?.trim() ?? "",
        apiKey: defaultTextApiKey,
        model: process.env.PAINTOPIA_DEFAULT_TEXT_MODEL ?? "gpt-5-nano",
        mode: (process.env.PAINTOPIA_DEFAULT_TEXT_MODE ?? "chat_completions") as TextProviderMode
      }
      : undefined
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveWorkspaceRoot(): string {
  const cwd = process.cwd();
  if (cwd.replaceAll("\\", "/").endsWith("/apps/api")) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}
