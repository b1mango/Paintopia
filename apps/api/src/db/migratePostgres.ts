import { CURATED_PROMPT_MIGRATION_SQL } from "./curatedPromptMigration.js";
import { PROMPT_TEMPLATE_MIGRATION_SQL } from "./promptTemplateMigration.js";
import type postgres from "postgres";

type PostgresClient = ReturnType<typeof postgres> | postgres.TransactionSql;

const statements = [
  `CREATE OR REPLACE FUNCTION paintopia_json(value TEXT) RETURNS JSONB
    LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RETURN value::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN RETURN '{}'::jsonb; END $$`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    quota INTEGER NOT NULL DEFAULT 66,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  "ALTER TABLE users ALTER COLUMN quota SET DEFAULT 66",
  `CREATE TABLE IF NOT EXISTS image_quota_reservations (
 job_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 amount INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'reserved'
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL DEFAULT 'dark',
    language TEXT NOT NULL DEFAULT 'zh',
    reduce_motion SMALLINT NOT NULL DEFAULT 0,
    default_image_model TEXT NOT NULL DEFAULT 'gpt-image-2',
    default_size TEXT NOT NULL DEFAULT '1024x1024',
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT NOT NULL,
    used_at BIGINT,
    destroyed_at BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS provider_configs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT NOT NULL,
    mode TEXT NOT NULL,
    max_concurrency INTEGER NOT NULL DEFAULT 1,
    enabled SMALLINT NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS prompt_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    target_model TEXT NOT NULL DEFAULT 'general',
    content TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS generation_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id TEXT,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    params_json TEXT NOT NULL,
    error TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS text_tool_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id TEXT,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
    original_path TEXT NOT NULL,
    thumb_path TEXT,
    storage_backend TEXT NOT NULL DEFAULT 'local',
    mime_type TEXT NOT NULL DEFAULT 'image/png',
    size_bytes BIGINT,
    status TEXT NOT NULL DEFAULT 'ready',
    expires_at BIGINT,
    prompt TEXT NOT NULL,
    params_json TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gallery_items (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    object_key TEXT,
    reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at BIGINT,
    rejection_reason TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gallery_tags (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    group_id TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS gallery_tags_label_idx ON gallery_tags(LOWER(label))",
  `CREATE TABLE IF NOT EXISTS gallery_item_tags (
    gallery_item_id TEXT NOT NULL REFERENCES gallery_items(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (gallery_item_id, tag_id)
  )`,
  "CREATE INDEX IF NOT EXISTS gallery_item_tags_tag_idx ON gallery_item_tags(tag_id, gallery_item_id)",
  `CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    zh TEXT NOT NULL,
    en TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS prompt_tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS prompt_prompt_tags (
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES prompt_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (prompt_id, tag_id)
  )`,
  `CREATE TABLE IF NOT EXISTS prompt_favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, prompt_id)
  )`,
  `CREATE TABLE IF NOT EXISTS usage_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    amount INTEGER NOT NULL,
    note TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS quota_pricing_rules (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    amount INTEGER NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_started_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at BIGINT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS ledger_job_cost_idx ON usage_ledger(user_id, (paintopia_json(note) #>> '{jobId}')) WHERE action = 'image_generation'",
  "CREATE INDEX IF NOT EXISTS jobs_created_id_idx ON generation_jobs(created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)",
  "CREATE INDEX IF NOT EXISTS jobs_user_created_idx ON generation_jobs(user_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON generation_jobs(status, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS assets_user_created_idx ON assets(user_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS assets_expiry_idx ON assets(expires_at) WHERE expires_at IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS gallery_asset_idx ON gallery_items(asset_id)",
  "CREATE INDEX IF NOT EXISTS gallery_status_created_idx ON gallery_items(status, created_at DESC)",
  "ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS config_json TEXT NOT NULL DEFAULT '{}'",
  "CREATE INDEX IF NOT EXISTS providers_kind_order_idx ON provider_configs(kind, sort_order, created_at, id)"
];

export async function migratePostgres(client: PostgresClient): Promise<void> {
  // PostgreSQL accepts multiple DDL statements in one simple-query call. This avoids
  // dozens of network round trips on every serverless cold start.
  await client.unsafe(statements.join(";\n"));
  await client.unsafe("ALTER TABLE prompt_templates ADD COLUMN IF NOT EXISTS is_default INTEGER NOT NULL DEFAULT 0");
  await client.unsafe(PROMPT_TEMPLATE_MIGRATION_SQL);
  await client.unsafe(CURATED_PROMPT_MIGRATION_SQL);
}
