export function providerInitialPriority(kind: "image" | "text", name: string, baseUrl: string, model: string): number {
  const value = `${name} ${baseUrl} ${model}`.toLowerCase();
  if (kind === "image") {
    if (value.includes("newapi")) return 0;
    if (value.includes("cliproxy") || value.includes("cpa.")) return 1;
    return 2;
  }
  if (value.includes("gpt-5-nano")) return 0;
  if (value.includes("linuxdo") || value.includes("translation")) return 1;
  if (value.includes("qwen")) return 2;
  return 9;
}
