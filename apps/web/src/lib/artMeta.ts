export const QUALITY_LABELS: Record<string, string> = { auto: "自动", high: "高", medium: "中", low: "低" };

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Actual pixel size of a work, preferring the stored dimensions over the requested size. */
export function artSize(item: { width?: number | null; height?: number | null; params?: Record<string, unknown> }) {
  const width = positive(item.width) ?? positive(item.params?.actualWidth);
  const height = positive(item.height) ?? positive(item.params?.actualHeight);
  return width && height ? { width, height } : undefined;
}

/** Display label for a work's date: 今日 / 昨日 / M月D日. */
export function dayLabel(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days === 0) return "今日";
  if (days === 1) return "昨日";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Key/value lines shown beside a work (模型 / 尺寸 / 大小 / 质量 / 用时). */
export function artMeta(item: { width?: number | null; height?: number | null; sizeBytes?: number | null; params?: Record<string, unknown> }) {
  const params = item.params ?? {};
  const lines: { label: string; value: string }[] = [];
  if (typeof params.model === "string" && params.model) lines.push({ label: "模型", value: params.model });
  const size = artSize(item);
  const resolution = typeof params.resolution === "string" && params.resolution !== "auto" ? ` · ${params.resolution}` : "";
  if (size) lines.push({ label: "尺寸", value: `${size.width} × ${size.height}${resolution}` });
  else if (typeof params.size === "string" && params.size && params.size !== "auto") lines.push({ label: "尺寸", value: `${params.size.replace("x", " × ")}${resolution}` });
  const bytes = positive(item.sizeBytes);
  if (bytes) lines.push({ label: "大小", value: formatBytes(bytes) });
  if (typeof params.quality === "string" && params.quality) lines.push({ label: "质量", value: QUALITY_LABELS[params.quality] ?? params.quality });
  const duration = positive(params.durationMs);
  if (duration) lines.push({ label: "用时", value: `${Math.round(duration / 1000)} 秒` });
  return lines;
}
