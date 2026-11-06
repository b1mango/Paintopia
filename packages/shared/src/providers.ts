export type ImageProviderMode = "generations" | "edits" | "responses" | "chat_completions";
export type LegacyImageProviderMode = "images";

export type ImageProviderCapabilities = {
 qualities?: string[];
 sizeField?: "size" | "image_size" | null;
 resolutionField?: "resolution" | "image_size" | null;
 supportsStreaming?: boolean;
};
export type ImageProviderConfig = {
 imageCapabilities?: ImageProviderCapabilities;
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: ImageProviderMode | LegacyImageProviderMode;
  maxConcurrency: number;
};

export type TextProviderMode = "chat_completions" | "responses" | "anthropic_messages";

export type TextProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: TextProviderMode;
};

export function normalizeImageProviderConfig(config: ImageProviderConfig): ImageProviderConfig & { mode: ImageProviderMode } {
  return {
    ...config,
    mode: config.mode === "images" ? "generations" : config.mode,
    baseUrl: stripTrailingSlash(config.baseUrl),
    maxConcurrency: Math.max(1, Math.floor(config.maxConcurrency || 1))
  };
}

export function normalizeTextProviderConfig(config: TextProviderConfig): TextProviderConfig {
  return {
    ...config,
    baseUrl: stripTrailingSlash(config.baseUrl)
  };
}

function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
