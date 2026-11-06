import { inferImageResolution, normalizeImageResolution, validateImageSize } from "@paintopia/shared";
import type { ImageResolution } from "./imageCapabilities.js";
export function imageRequestResolution(params: Record<string, unknown>): ImageResolution | null {
  try {
    if (params.resolution !== undefined) return normalizeImageResolution(String(params.resolution));
    if (params.size !== undefined) {
      const size = String(params.size).trim();
      if (/^[124]k$/i.test(size)) return normalizeImageResolution(size);
      return inferImageResolution(validateImageSize(size));
    }
    return "1K";
  } catch { return null; }
}

export function getRequestedImageCount(params: Record<string, unknown>) {
  const rawCount = Number(params.n ?? 1);
  if (!Number.isFinite(rawCount)) {
    return 1;
  }
  return Math.min(8, Math.max(1, Math.floor(rawCount)));
}
