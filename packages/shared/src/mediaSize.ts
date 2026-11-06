// Copyright (c) 2026 basketikun. MIT; see ../THIRD_PARTY_NOTICES.md.
export const IMAGE_RESOLUTIONS = ["1K", "2K", "4K", "auto"] as const;
export type ImageResolution = typeof IMAGE_RESOLUTIONS[number];
// Presets adapted from basketikun/infinite-canvas web/src/lib/media-size.ts.
export const IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21", "auto"] as const;
export const IMAGE_SIZE_PRESETS: Record<string, Record<string, string>> = {
 "1K": { "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024", "4:3": "1024x768", "3:4": "768x1024", "16:9": "1536x864", "9:16": "864x1536", "21:9": "2016x864", "9:21": "864x2016" },
 "2K": { "1:1": "2048x2048", "2:3": "1360x2048", "3:2": "2048x1360", "4:3": "2048x1536", "3:4": "1536x2048", "16:9": "2048x1152", "9:16": "1152x2048", "21:9": "2688x1152", "9:21": "1152x2688" },
 "4K": { "1:1": "2880x2880", "2:3": "2336x3520", "3:2": "3520x2336", "4:3": "3312x2480", "3:4": "2480x3312", "16:9": "3840x2160", "9:16": "2160x3840", "21:9": "3840x1648", "9:21": "1648x3840" }
};
export function normalizeImageResolution(value: string): ImageResolution {
 const normalized = value.trim().toLowerCase() === "auto" ? "auto" : value.trim().toUpperCase();
 if (!IMAGE_RESOLUTIONS.includes(normalized as ImageResolution)) throw new Error("分辨率必须是 1K、2K、4K 或 auto");
 return normalized as ImageResolution;
}
export function parsePixelSize(value: string): { width: number; height: number } | null {
 const match = /^(\d+)x(\d+)$/i.exec(value.trim());
 if (!match) return null;
 const width = Number(match[1]), height = Number(match[2]);
 return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? { width, height } : null;
}
export function validateImageSize(value: string): string {
 if (value.trim().toLowerCase() === "auto") return "auto";
 const d = parsePixelSize(value);
 if (!d || d.width < 16 || d.height < 16 || d.width > 8192 || d.height > 8192 || d.width * d.height > 33554432 || d.width % 16 || d.height % 16) throw new Error("尺寸必须为 auto 或 16 的倍数，边长 16–8192，最多 33554432 像素");
 return String(d.width) + "x" + String(d.height);
}
export function resolveImageSize(resolution: string, aspectRatio = "1:1"): string {
 const scale = normalizeImageResolution(resolution);
 if (!(IMAGE_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) throw new Error("不支持的画幅比例");
 return scale === "auto" || aspectRatio === "auto" ? "auto" : IMAGE_SIZE_PRESETS[scale]![aspectRatio]!;
}
export function inferImageResolution(size: string): ImageResolution {
 if (size === "auto") return "auto";
 for (const scale of ["1K", "2K", "4K"] as const) if (Object.values(IMAGE_SIZE_PRESETS[scale]!).includes(size)) return scale;
 const d = parsePixelSize(size);
 if (!d) throw new Error("无效像素尺寸");
 const pixels = d.width * d.height;
 return pixels >= 6000000 ? "4K" : pixels >= 2000000 ? "2K" : "1K";
}
export function inferImageAspectRatio(size: string): string {
 if (size === "auto") return "auto";
 const d = parsePixelSize(size);
 if (!d) throw new Error("无效像素尺寸");
 return IMAGE_ASPECT_RATIOS.filter(r => r !== "auto").reduce<string>((best, ratio) => {
  const distance = (r: string) => { const [w,h] = r.split(":").map(Number); return Math.abs(w! / h! - d.width / d.height); };
  return distance(ratio) < distance(best) ? ratio : best;
 }, "1:1");
}
export type ImageQuotaRule = { key: string; amount: number };
export function imageQuotaPricingKey(resolution: string, quality: string): string {
 const scale = normalizeImageResolution(resolution);
 const level = ["low", "medium", "high"].includes(quality.toLowerCase()) ? quality.toLowerCase() : "high";
 return "resolution." + (scale === "auto" ? "4k" : scale.toLowerCase()) + ".quality." + level;
}
export function calculateImageQuotaCost(rules: readonly ImageQuotaRule[], resolution: string, quality: string, count = 1): number {
 const key = imageQuotaPricingKey(resolution, quality);
 const [, scale, , level] = key.split(".");
 const fallback = ({ "1k": 1, "2k": 2, "4k": 4 }[scale!] ?? 1) * ({ low: 1, medium: 2, high: 3 }[level!] ?? 3);
 return Math.max(0, rules.find(rule => rule.key === key)?.amount ?? fallback) * Math.min(8, Math.max(1, Number.isFinite(count) ? Math.floor(count) : 1));
}
