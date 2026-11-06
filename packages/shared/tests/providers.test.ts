import { describe, expect, it } from "vitest";
import { normalizeImageProviderConfig, normalizeTextProviderConfig } from "../src/providers";

describe("provider config normalization", () => {
  it("normalizes image provider base urls and concurrency", () => {
    const provider = normalizeImageProviderConfig({
      id: "codex",
      name: "Codex GPT Image 2",
      baseUrl: "https://example.com/v1/",
      apiKey: "test-key",
      model: "gpt-image-2",
      mode: "generations",
      maxConcurrency: 0
    });

    expect(provider.baseUrl).toBe("https://example.com/v1");
    expect(provider.mode).toBe("generations");
    expect(provider.maxConcurrency).toBe(1);
  });

  it("keeps legacy image mode compatible with generation endpoint settings", () => {
    const provider = normalizeImageProviderConfig({
      id: "codex",
      name: "Codex GPT Image 2",
      baseUrl: "https://example.com/v1/",
      apiKey: "test-key",
      model: "gpt-image-2",
      mode: "images",
      maxConcurrency: 1
    });

    expect(provider.mode).toBe("generations");
  });

  it("normalizes text provider mode and url", () => {
    const provider = normalizeTextProviderConfig({
      id: "translate",
      name: "Low cost translator",
      baseUrl: "https://example.com/openai/",
      apiKey: "test-key",
      model: "qwen-cheap",
      mode: "chat_completions"
    });

    expect(provider.baseUrl).toBe("https://example.com/openai");
    expect(provider.mode).toBe("chat_completions");
  });
});
