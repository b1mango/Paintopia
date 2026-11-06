import { BUILT_IN_PROMPT_TEMPLATES } from "@paintopia/shared";
import { LEGACY_OPTIMIZE_TEMPLATES } from "./legacyPromptTemplates.js";

export const ENSURE_DEFAULT_TEMPLATE_SQL = `
  UPDATE prompt_templates SET is_default = 1
  WHERE id = (
    SELECT id FROM prompt_templates WHERE type = 'optimize'
    ORDER BY CASE WHEN id = 'optimize' THEN 0 ELSE 1 END, created_at, id LIMIT 1
  ) AND NOT EXISTS (SELECT 1 FROM prompt_templates WHERE type = 'optimize' AND is_default = 1)
`;

const sqlString = (value: string) => "'" + value.replace(/'/g, "''") + "'";

export const PROMPT_TEMPLATE_MIGRATION_SQL = [
  "DELETE FROM prompt_templates WHERE id IN ('translate', 'translate-cinematic')",
  "UPDATE prompt_templates SET type = 'optimize' WHERE type = 'translate'",
  ...LEGACY_OPTIMIZE_TEMPLATES.map(legacy => {
    const template = BUILT_IN_PROMPT_TEMPLATES.find(item => item.id === legacy.id)!;
    return `UPDATE prompt_templates SET content = ${sqlString(template.content)},
      name = CASE WHEN name = ${sqlString(legacy.name)} THEN ${sqlString(template.name)} ELSE name END
      WHERE id = ${sqlString(legacy.id)} AND content = ${sqlString(legacy.content)}`;
  }),
  ENSURE_DEFAULT_TEMPLATE_SQL,
  "CREATE UNIQUE INDEX IF NOT EXISTS prompt_templates_default_idx ON prompt_templates(type) WHERE is_default = 1 AND type = 'optimize'"
].join(";\n");
