import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_PROMPT_TEMPLATES } from "@paintopia/shared";
import { migrate } from "../src/db/migrate.js";
import { migratePostgres } from "../src/db/migratePostgres.js";
import { LEGACY_OPTIMIZE_TEMPLATES } from "../src/db/legacyPromptTemplates.js";
import { PROMPT_TEMPLATE_MIGRATION_SQL } from "../src/db/promptTemplateMigration.js";

function legacyDatabase() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE prompt_templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    target_model TEXT NOT NULL DEFAULT 'general', content TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  return db;
}

function insert(db: Database.Database, id: string, type: string, content: string, createdAt = 1, name = id) {
  db.prepare("INSERT INTO prompt_templates (id,name,type,content,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, name, type, content, createdAt, createdAt);
}

describe("optimizer template migration", () => {
  it("removes translation seeds, preserves custom data and upgrades exact legacy content idempotently", () => {
    const db = legacyDatabase();
    try {
      insert(db, "translate", "translate", "seed");
      insert(db, "translate-cinematic", "translate", "seed");
      insert(db, "custom", "translate", "Custom {{input_prompt}}", 0);
      for (const template of LEGACY_OPTIMIZE_TEMPLATES) insert(db, template.id, "optimize", template.content, 2, template.name);
      migrate(db);
      migrate(db);
      expect(db.prepare("SELECT id FROM prompt_templates WHERE id LIKE 'translate%'").all()).toEqual([]);
      expect(db.prepare("SELECT type,content,created_at,updated_at,is_default FROM prompt_templates WHERE id='custom'").get())
        .toEqual({ type: "optimize", content: "Custom {{input_prompt}}", created_at: 0, updated_at: 0, is_default: 0 });
      for (const template of BUILT_IN_PROMPT_TEMPLATES) {
        expect(db.prepare("SELECT name,content FROM prompt_templates WHERE id=?").get(template.id))
          .toEqual({ name: template.name, content: template.content });
      }
      expect(db.prepare("SELECT id FROM prompt_templates WHERE is_default=1").all()).toEqual([{ id: "optimize" }]);
      expect(() => db.prepare("UPDATE prompt_templates SET is_default=1 WHERE id='custom'").run()).toThrow();
    } finally { db.close(); }
  });

  it("preserves edited built-ins and an existing administrator-selected default", () => {
    const db = legacyDatabase();
    try {
      for (const template of LEGACY_OPTIMIZE_TEMPLATES) insert(db, template.id, "optimize", template.content + "\nAdmin edit", 2, "Custom name");
      migrate(db);
      db.exec("UPDATE prompt_templates SET is_default=0; UPDATE prompt_templates SET is_default=1 WHERE id='optimize-portrait'");
      migrate(db);
      for (const template of LEGACY_OPTIMIZE_TEMPLATES) {
        expect(db.prepare("SELECT name,content FROM prompt_templates WHERE id=?").get(template.id))
          .toEqual({ name: "Custom name", content: template.content + "\nAdmin edit" });
      }
      expect(db.prepare("SELECT id FROM prompt_templates WHERE is_default=1").all()).toEqual([{ id: "optimize-portrait" }]);
    } finally { db.close(); }
  });

  it("selects the earliest template when optimize is absent and handles an empty table", () => {
    const db = legacyDatabase();
    try {
      migrate(db);
      expect(db.prepare("SELECT * FROM prompt_templates").all()).toEqual([]);
      insert(db, "newer", "optimize", "newer", 3);
      insert(db, "older", "translate", "older", 1);
      migrate(db);
      expect(db.prepare("SELECT id FROM prompt_templates WHERE is_default=1").all()).toEqual([{ id: "older" }]);
    } finally { db.close(); }
  });

  it("adds the PostgreSQL column before applying the same idempotent data migration", async () => {
    const unsafe = vi.fn().mockResolvedValue([]);
    await migratePostgres({ unsafe } as unknown as Parameters<typeof migratePostgres>[0]);
    expect(unsafe).toHaveBeenNthCalledWith(2, "ALTER TABLE prompt_templates ADD COLUMN IF NOT EXISTS is_default INTEGER NOT NULL DEFAULT 0");
    expect(unsafe).toHaveBeenNthCalledWith(3, PROMPT_TEMPLATE_MIGRATION_SQL);
  });
});
