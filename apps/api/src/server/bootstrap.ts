import {
  BUILT_IN_PROMPT_TEMPLATES,
  normalizeTextProviderConfig
} from "@paintopia/shared";
import { nanoid } from "nanoid";
import { type AppDatabase } from "../db/database.js";
import { ENSURE_DEFAULT_TEMPLATE_SQL } from "../db/promptTemplateMigration.js";
import * as repo from "../db/repository.js";
import { nextProviderSortOrderForConfig } from "../services/providerConfig.js";
import { type ProviderSecretCodec } from "../services/providerSecrets.js";
import { CreateServerOptions } from "./options.js";

export async function bootstrapDefaultTextProvider(
  appDb: AppDatabase,
  secrets: ProviderSecretCodec,
  provider: CreateServerOptions["defaultTextProvider"]
) {
  if (!provider?.apiKey || !provider.baseUrl || !provider.model) {
    return;
  }

  const normalized = normalizeTextProviderConfig({
    id: "default-text-provider",
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    mode: provider.mode
  });
  const now = new Date();
  const existingDefaultProvider = await repo.findProvider(appDb, normalized.id);
  const enabledTextProvider = (await repo.listProviders(appDb))
    .find((item) => item.kind === "text" && item.enabled);

  if (!existingDefaultProvider && enabledTextProvider) {
    return;
  }

  await repo.upsertProvider(appDb, {
    id: normalized.id,
    kind: "text",
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    apiKey: secrets.encrypt(normalized.apiKey),
    model: normalized.model,
    mode: normalized.mode,
    maxConcurrency: 1,
    enabled: true,
    sortOrder: await nextProviderSortOrderForConfig(appDb, {
      kind: "text",
      name: normalized.name,
      baseUrl: normalized.baseUrl,
      model: normalized.model
    }),
    createdAt: now,
    updatedAt: now
  });
}

export function validateProductionConfig(options: CreateServerOptions) {
  if (!options.production) return;
  const missing = [
    !options.databaseUrl ? "DATABASE_URL" : "",
    !options.r2 ? "PAINTOPIA_R2_*" : "",
    !options.providerEncryptionKey ? "PAINTOPIA_PROVIDER_ENCRYPTION_KEY" : "",
    !options.cronSecret ? "CRON_SECRET" : "",
    options.sessionSecret.length < 32 ? "PAINTOPIA_SESSION_SECRET (at least 32 characters)" : "",
    !options.webOrigin.startsWith("https://") ? "PAINTOPIA_WEB_ORIGIN (HTTPS)" : ""
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing or unsafe production configuration: ${missing.join(", ")}`);
  }
}

export async function bootstrapInviteCode(appDb: AppDatabase, inviteCode: string) {
  const normalized = inviteCode.trim();
  if (!normalized) {
    return;
  }
  const existing = await repo.findInviteByCode(appDb, normalized);
  if (existing) {
    return;
  }

  const now = new Date();
  await repo.insertInvite(appDb, {
    id: nanoid(),
    code: normalized,
    status: "active",
    createdBy: null,
    usedBy: null,
    createdAt: now,
    usedAt: null,
    destroyedAt: null
  });
}

export async function bootstrapDefaultPromptTemplates(appDb: AppDatabase) {
  const existingIds = await findExistingSeedIds(
    appDb,
    "prompt_templates",
    BUILT_IN_PROMPT_TEMPLATES.map((template) => template.id)
  );
  const now = new Date();
  for (const template of BUILT_IN_PROMPT_TEMPLATES) {
    if (existingIds.has(template.id)) continue;
    await repo.insertTemplateIfMissing(appDb, {
      ...template,
      isDefault: false,
      createdAt: now,
      updatedAt: now
    });
  }
  await appDb.execute(ENSURE_DEFAULT_TEMPLATE_SQL);
}

async function findExistingSeedIds(
  appDb: AppDatabase,
  table: "prompts" | "prompt_templates",
  ids: string[]
) {
  if (ids.length === 0) return new Set<string>();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await appDb.query<{ id: string }>(
    "SELECT id FROM " + table + " WHERE id IN (" + placeholders + ")",
    ids
  );
  return new Set(rows.map((row) => row.id));
}
