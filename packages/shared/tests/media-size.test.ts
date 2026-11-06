import { describe, expect, it } from "vitest";
import { IMAGE_SIZE_PRESETS, resolveImageSize, parsePixelSize, validateImageSize, inferImageResolution, inferImageAspectRatio, calculateImageQuotaCost } from "../src/mediaSize.js";

describe("shared image size and quota contract", () => {
  it("resolves and round-trips every preset on a 16 pixel grid", () => {
    for (const [resolution, ratios] of Object.entries(IMAGE_SIZE_PRESETS)) {
      for (const [ratio, size] of Object.entries(ratios)) {
        expect(resolveImageSize(resolution.toLowerCase(), ratio)).toBe(size);
        expect(validateImageSize(size)).toBe(size);
        expect(inferImageResolution(size)).toBe(resolution);
        expect(inferImageAspectRatio(size)).toBe(ratio);
      }
    }
  });
  it("preserves auto and rejects invalid ratios, scales and pixel inputs", () => {
    expect(resolveImageSize("auto", "16:9")).toBe("auto");
    expect(resolveImageSize("4K", "auto")).toBe("auto");
    expect(() => resolveImageSize("8K", "1:1")).toThrow();
    expect(() => resolveImageSize("1K", "0:1")).toThrow();
    for (const size of ["0x1024", "1025x1024", "8192x8192", "1:1", "1024;1024"]) expect(() => validateImageSize(size)).toThrow();
    expect(parsePixelSize("9007199254740999x1")).toBeNull();
  });
  it("prices auto quality using the configured high rule for the same resolution", () => {
    const rules = [{ key: "resolution.2k.quality.high", amount: 9 }];
    expect(calculateImageQuotaCost(rules, "2K", "auto", 2)).toBe(18);
    expect(calculateImageQuotaCost([], "4K", "auto")).toBe(12);
    expect(calculateImageQuotaCost([], "auto", "auto")).toBe(12);
    expect(calculateImageQuotaCost([], "1K", "custom-quality")).toBe(3);
  });
});

describe("pricing boundaries", () => {
  it("uses configured 4K/high for auto and clamps requests to the API count limit", () => {
    const rules = [{ key: "resolution.4k.quality.high", amount: 17 }];
    expect(calculateImageQuotaCost(rules, "auto", "auto", 99)).toBe(136);
    expect(calculateImageQuotaCost(rules, "auto", "auto", 8)).toBe(136);
    expect(calculateImageQuotaCost(rules, "auto", "auto", 0)).toBe(17);
    expect(calculateImageQuotaCost(rules, "auto", "auto", NaN)).toBe(17);
    expect(calculateImageQuotaCost([{ key: "resolution.4k.quality.high", amount: 0 }], "auto", "auto")).toBe(0);
  });
  it("validates custom pixel area and edge limits without silently rounding", () => {
    expect(validateImageSize("1280x800")).toBe("1280x800");
    expect(inferImageResolution("1280x800")).toBe("1K");
    expect(validateImageSize("8192x4096")).toBe("8192x4096");
    expect(() => validateImageSize("8192x4112")).toThrow();
    expect(() => validateImageSize("8208x16")).toThrow();
    expect(() => validateImageSize("1281x800")).toThrow();
  });
});
