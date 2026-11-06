export type PromptTemplateVariables = Record<string, string | number | boolean | null | undefined>;

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderPromptTemplate(template: string, variables: PromptTemplateVariables): string {
  return template
    .replace(VARIABLE_PATTERN, (_match, key: string) => {
      const value = variables[key];
      return value === null || value === undefined ? "" : String(value);
    })
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
