import type Database from "better-sqlite3";
import { providerInitialPriority } from "../services/providerPriority.js";
import { CURATED_PROMPT_MIGRATION_SQL } from "./curatedPromptMigration.js";
import { PROMPT_TEMPLATE_MIGRATION_SQL } from "./promptTemplateMigration.js";

export function migrate(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      quota INTEGER NOT NULL DEFAULT 66,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS image_quota_reservations (
      job_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'reserved'
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme TEXT NOT NULL DEFAULT 'dark',
      language TEXT NOT NULL DEFAULT 'zh',
      reduce_motion INTEGER NOT NULL DEFAULT 0,
      default_image_model TEXT NOT NULL DEFAULT 'gpt-image-2',
      default_size TEXT NOT NULL DEFAULT '1024x1024',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      used_at INTEGER,
      destroyed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS provider_configs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      target_model TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS generation_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id TEXT,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      params_json TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS text_tool_runs (
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
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
      original_path TEXT NOT NULL,
      thumb_path TEXT,
      prompt TEXT NOT NULL,
      params_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gallery_items (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gallery_tags (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      group_id TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS gallery_tags_label_idx ON gallery_tags(LOWER(label));

    CREATE TABLE IF NOT EXISTS gallery_item_tags (
      gallery_item_id TEXT NOT NULL REFERENCES gallery_items(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (gallery_item_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS gallery_item_tags_tag_idx ON gallery_item_tags(tag_id, gallery_item_id);

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      zh TEXT NOT NULL,
      en TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS prompt_prompt_tags (
      prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES prompt_tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS prompt_favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quota_pricing_rules (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      amount INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `);

  ensureColumn(database, "provider_configs", "config_json", "TEXT NOT NULL DEFAULT '{}'");
  if (ensureColumn(database, "provider_configs", "sort_order", "INTEGER NOT NULL DEFAULT 0")) {
    const rows = database.prepare("SELECT id, kind, name, base_url AS baseUrl, model FROM provider_configs ORDER BY created_at ASC, updated_at ASC, id ASC")
      .all() as Array<{ id: string; kind: "image" | "text"; name: string; baseUrl: string; model: string }>;
    const update = database.prepare("UPDATE provider_configs SET sort_order = ? WHERE id = ?");
    const applyOrder = database.transaction((items: Array<{ id: string }>) => {
      const counters = new Map<number, number>();
      items.forEach((item) => {
        const row = item as { id: string; kind: "image" | "text"; name: string; baseUrl: string; model: string };
        const priority = providerInitialPriority(row.kind, row.name, row.baseUrl, row.model);
        const offset = counters.get(priority) ?? 0;
        counters.set(priority, offset + 1);
        update.run(priority * 10000 + offset * 10, row.id);
      });
    });
    applyOrder(rows);
  }

  ensureColumn(database, "prompt_templates", "is_default", "INTEGER NOT NULL DEFAULT 0");
  database.exec(PROMPT_TEMPLATE_MIGRATION_SQL);

  ensureColumn(database, "assets", "storage_backend", "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(database, "assets", "mime_type", "TEXT NOT NULL DEFAULT 'image/png'");
  ensureColumn(database, "assets", "size_bytes", "INTEGER");
  ensureColumn(database, "assets", "status", "TEXT NOT NULL DEFAULT 'ready'");
  ensureColumn(database, "assets", "expires_at", "INTEGER");
  ensureColumn(database, "gallery_items", "object_key", "TEXT");
  ensureColumn(database, "gallery_items", "reviewed_by", "TEXT REFERENCES users(id) ON DELETE SET NULL");
  ensureColumn(database, "gallery_items", "reviewed_at", "INTEGER");
  ensureColumn(database, "gallery_items", "rejection_reason", "TEXT");
  const duplicateGallery = database.prepare("SELECT asset_id FROM gallery_items GROUP BY asset_id HAVING COUNT(*) > 1 LIMIT 1").get();
  if (duplicateGallery) throw new Error("Duplicate gallery submissions found; back up the database and review gallery_items before adding gallery_asset_idx. No records were deleted.");

  database.exec(`
    UPDATE gallery_items SET status = 'pending' WHERE status = 'draft';
    UPDATE gallery_items SET status = 'approved' WHERE status = 'published';
    CREATE INDEX IF NOT EXISTS ledger_job_cost_idx ON usage_ledger(user_id, json_extract(CASE WHEN json_valid(note) THEN note ELSE '{}' END, '$.jobId')) WHERE action = 'image_generation';
    CREATE INDEX IF NOT EXISTS jobs_created_id_idx ON generation_jobs(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS jobs_user_created_idx ON generation_jobs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON generation_jobs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS assets_user_created_idx ON assets(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS assets_expiry_idx ON assets(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS gallery_asset_idx ON gallery_items(asset_id);
    CREATE INDEX IF NOT EXISTS gallery_status_created_idx ON gallery_items(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS providers_kind_order_idx ON provider_configs(kind, sort_order, created_at, id);
  `);
  database.exec(CURATED_PROMPT_MIGRATION_SQL);
}

function ensureColumn(database: Database.Database, table: string, column: string, definition: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}
