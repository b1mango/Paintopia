export const CURATED_PROMPT_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS curated_prompts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, description TEXT,
  tags TEXT NOT NULL DEFAULT '[]', object_key TEXT NOT NULL, thumb_key TEXT NOT NULL,
  mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS curated_prompts_asset_idx ON curated_prompts(source_asset_id);
CREATE INDEX IF NOT EXISTS curated_prompts_order_idx ON curated_prompts(sort_order DESC, created_at DESC, id DESC);`;
