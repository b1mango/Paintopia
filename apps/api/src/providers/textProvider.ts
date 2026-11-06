import { normalizeTextProviderConfig, type TextProviderConfig } from "@paintopia/shared";

export type TextProviderInput = {
  systemPrompt: string;
  userPrompt: string;
};

export type TextProviderResult = {
  raw: unknown;
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

type FetchLike = typeof fetch;

export async function callTextProvider(
  config: TextProviderConfig,
  input: TextProviderInput,
  fetchImpl: FetchLike = fetch
): Promise<TextProviderResult> {
  const provider = normalizeTextProviderConfig(config);
  if (provider.mode === "chat_completions") {
    return callChatCompletions(provider, input, fetchImpl);
  }
  if (provider.mode === "anthropic_messages") {
    return callAnthropicMessages(provider, input, fetchImpl);
  }
  return callResponses(provider, input, fetchImpl);
}

async function callChatCompletions(
  provider: TextProviderConfig,
  input: TextProviderInput,
  fetchImpl: FetchLike
): Promise<TextProviderResult> {
  const raw = await postJson(fetchImpl, openAiUrl(provider.baseUrl, "chat/completions"), provider, {
    model: provider.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt }
    ],
    temperature: 0.3
  });

  return {
    raw,
    text: extractText(raw.choices?.[0]?.message?.content),
    usage: extractUsage(raw)
  };
}

async function callResponses(
  provider: TextProviderConfig,
  input: TextProviderInput,
  fetchImpl: FetchLike
): Promise<TextProviderResult> {
  const raw = await postJson(fetchImpl, openAiUrl(provider.baseUrl, "responses"), provider, {
    model: provider.model,
    input: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt }
    ],
    temperature: 0.3
  });

  return {
    raw,
    text: extractText(raw.output_text) || extractOutputText(raw),
    usage: extractUsage(raw)
  };
}

async function callAnthropicMessages(
  provider: TextProviderConfig,
  input: TextProviderInput,
  fetchImpl: FetchLike
): Promise<TextProviderResult> {
  const raw = await postJson(fetchImpl, anthropicUrl(provider.baseUrl), provider, {
    model: provider.model,
    system: input.systemPrompt,
    messages: [
      { role: "user", content: input.userPrompt }
    ],
    max_tokens: 1200,
    temperature: 0.3
  });

  return {
    raw,
    text: extractText(raw.content),
    usage: extractUsage(raw)
  };
}

async function postJson(fetchImpl: FetchLike, url: string, provider: TextProviderConfig, body: unknown) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: textProviderHeaders(provider),
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Text provider request failed with status ${response.status}`);
  }
  return parsed;
}

function openAiUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  if (normalizedBase.endsWith(`/${normalizedEndpoint}`)) {
    return normalizedBase;
  }
  const versionedBase = normalizedBase.endsWith("/v1") ? normalizedBase : `${normalizedBase}/v1`;
  return `${versionedBase}/${normalizedEndpoint}`;
}

function anthropicUrl(baseUrl: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  if (normalizedBase.endsWith("/messages")) {
    return normalizedBase;
  }
  const versionedBase = normalizedBase.endsWith("/v1") ? normalizedBase : `${normalizedBase}/v1`;
  return `${versionedBase}/messages`;
}

function textProviderHeaders(provider: TextProviderConfig) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (provider.mode === "anthropic_messages") {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  if (usesXApiKey(provider.baseUrl)) {
    headers["x-api-key"] = provider.apiKey;
    return headers;
  }
  headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

function usesXApiKey(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname === "api.xn-vrvr26c72pz7b.cyou";
  } catch {
    return baseUrl.includes("api.xn-vrvr26c72pz7b.cyou");
  }
}

function extractOutputText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const output = (value as Record<string, unknown>).output;
  if (!Array.isArray(output)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== "message" || (entry.role && entry.role !== "assistant")) {
      continue;
    }
    const content = entry.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        continue;
      }
      const contentPart = part as Record<string, unknown>;
      if ((contentPart.type === "output_text" || contentPart.type === "text") && typeof contentPart.text === "string") {
        parts.push(contentPart.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object") {
        const entry = part as Record<string, unknown>;
        if (typeof entry.text === "string") {
          return entry.text;
        }
        if (typeof entry.content === "string") {
          return entry.content;
        }
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function extractUsage(value: unknown) {
  const usage = value && typeof value === "object" ? (value as Record<string, unknown>).usage : undefined;
  if (!usage || typeof usage !== "object") {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const entry = usage as Record<string, unknown>;
  const promptTokens = numberFromUsage(entry.prompt_tokens ?? entry.input_tokens);
  const completionTokens = numberFromUsage(entry.completion_tokens ?? entry.output_tokens);
  const totalTokens = numberFromUsage(entry.total_tokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function numberFromUsage(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0;
}
