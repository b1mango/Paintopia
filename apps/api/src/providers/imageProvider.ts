import { observeImageRequests, type UpstreamRequestSnapshot } from "./requestSnapshot.js";
import { normalizeImageProviderConfig, type ImageProviderConfig } from "@paintopia/shared";
import { Buffer } from "node:buffer";

export type ImageGenerationInput = {
  prompt: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  onRequest?: (snapshot: UpstreamRequestSnapshot) => void;
};

export type ImageGenerationResult = {
  raw: unknown;
  images: Array<{
    b64Json?: string;
    url?: string;
    upstreamSize?: string;
    upstreamQuality?: string;
    upstreamResolution?: string;
    upstreamModel?: string;
  }>;
};

export type ImageGenerationPartial = {
  b64Json: string;
  partialImageIndex: number;
  mimeType: string;
};

type FetchLike = typeof fetch;

function imageSizeForRequest(params: Record<string, unknown>) {
  return typeof params.size === "string" && params.size.trim()
    ? params.size.trim()
    : undefined;
}

function imageResolutionForRequest(params: Record<string, unknown>) {
  if (typeof params.resolution !== "string" || !params.resolution.trim()) {
    return undefined;
  }
  const resolution = params.resolution.trim().toUpperCase();
  return resolution === "AUTO" ? "auto" : ["1K", "2K", "4K"].includes(resolution) ? resolution : undefined;
}

export async function callImageProvider(
  config: ImageProviderConfig,
  input: ImageGenerationInput,
  fetchImpl: FetchLike = fetch
): Promise<ImageGenerationResult> {
  const provider = normalizeImageProviderConfig(config);
  validateProviderQuality(provider, input.params);
  fetchImpl = observeImageRequests(fetchImpl, provider.apiKey, input.onRequest);
  let result: ImageGenerationResult;
  if (provider.mode === "generations") {
    result = await callImagesEndpoint(provider, input, fetchImpl);
  } else if (provider.mode === "edits") {
    result = await callImageEditsEndpoint(provider, input, fetchImpl);
  } else if (provider.mode === "chat_completions") {
    result = await callChatCompletionsEndpoint(provider, input, fetchImpl);
  } else {
    result = await callResponsesEndpoint(provider, input, fetchImpl);
  }
  return excludeInputImages(result, normalizeEditImages(input.params.image ?? input.params.images));
}

export async function callImageProviderStream(
  config: ImageProviderConfig,
  input: ImageGenerationInput,
  onPartialImage: (partial: ImageGenerationPartial) => void,
  fetchImpl: FetchLike = fetch
): Promise<ImageGenerationResult> {
  const provider = normalizeImageProviderConfig(config);
  validateProviderQuality(provider, input.params);
  fetchImpl = observeImageRequests(fetchImpl, provider.apiKey, input.onRequest);
  if (provider.imageCapabilities?.supportsStreaming === false) throw new Error("此渠道已禁用流式响应");
  if (provider.mode === "generations") {
    return callImagesEndpointStream(provider, input, onPartialImage, fetchImpl);
  }
  if (provider.mode === "responses") {
    return callResponsesEndpointStream(provider, input, onPartialImage, fetchImpl);
  }
  if (provider.mode === "chat_completions") {
    throw new Error("Chat Completions 生图暂不支持上游 partial 流式响应");
  }
  throw new Error("Image edit streaming is not enabled for this provider route");
}

export function isImageProviderStreamingUnsupportedError(error: unknown) {
  if (!(error instanceof ImageProviderHttpError)) {
    return false;
  }
  if ([404, 405, 415].includes(error.statusCode)) {
    return true;
  }
  if (![400, 422].includes(error.statusCode)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return ["stream", "partial_images", "partial images", "text/event-stream"]
    .some((token) => message.includes(token));
}

async function callImagesEndpoint(
  provider: ImageProviderConfig,
  input: ImageGenerationInput,
  fetchImpl: FetchLike
): Promise<ImageGenerationResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    prompt: input.prompt,
    quality: String(input.params.quality ?? "high"),
    n: Number(input.params.n ?? 1)
  };
  appendImageResolutionValue(provider, body, input.params);

  const raw = await retryTransientImageRequest(() => (
    postJson(fetchImpl, openAiUrl(provider.baseUrl, "images/generations"), provider.apiKey, body, input.signal)
  ));
  const images = extractImagesResponse(raw);

  return { raw, images };
}

async function callImageEditsEndpoint(
  provider: ImageProviderConfig,
  input: ImageGenerationInput,
  fetchImpl: FetchLike
): Promise<ImageGenerationResult> {
  const images = normalizeEditImages(input.params.image ?? input.params.images);
  if (images.length === 0) {
    throw new Error("图像编辑需要上传至少一张参考图");
  }

  const form = new FormData();
  form.append("model", provider.model);
  form.append("prompt", input.prompt);
  const dimensions: Record<string, unknown> = {};
  appendImageResolutionValue(provider, dimensions, input.params);
  for (const [key, value] of Object.entries(dimensions)) appendOptionalFormValue(form, key, value);
  appendOptionalFormValue(form, "quality", input.params.quality ?? "high");
  appendOptionalFormValue(form, "n", input.params.n);
  appendOptionalFormValue(form, "mask", input.params.mask);

  for (const image of images) {
    form.append(images.length > 1 ? "image[]" : "image", image, "image.png");
  }

  const raw = await postForm(fetchImpl, openAiUrl(provider.baseUrl, "images/edits"), provider.apiKey, form, input.signal);
  const outputImages = extractImagesResponse(raw);

  return { raw, images: outputImages };
}

async function callResponsesEndpoint(
  provider: ImageProviderConfig,
  input: ImageGenerationInput,
  fetchImpl: FetchLike
): Promise<ImageGenerationResult> {
  const images = normalizeEditImages(input.params.image ?? input.params.images);
  const imageGenerationTool: Record<string, unknown> = {
    type: "image_generation"
  };
  appendOptionalObjectValue(imageGenerationTool, "action", input.params.action ?? (images.length > 0 ? "edit" : undefined));
  appendImageResolutionValue(provider, imageGenerationTool, input.params);
  appendOptionalObjectValue(imageGenerationTool, "quality", input.params.quality ?? "high");

  const body = {
    model: provider.model,
    input: images.length > 0
      ? [{
          role: "user",
          content: [
            { type: "input_text", text: input.prompt },
            ...await Promise.all(images.map(async (image) => ({
              type: "input_image",
              image_url: await blobToDataUrl(image),
              detail: "auto"
            })))
          ]
        }]
      : input.prompt,
    tools: [imageGenerationTool]
  };

  const raw = await retryTransientImageRequest(() => (
    postJson(fetchImpl, openAiUrl(provider.baseUrl, "responses"), provider.apiKey, body, input.signal)
  ));
  return {
    raw,
    images: findImages(raw)
  };
}

async function callChatCompletionsEndpoint(
  provider: ImageProviderConfig,
  input: ImageGenerationInput,
  fetchImpl: FetchLike
): Promise<ImageGenerationResult> {
  const inputImages = normalizeEditImages(input.params.image ?? input.params.images);
  const content = inputImages.length > 0
    ? [
        { type: "text", text: input.prompt },
        ...await Promise.all(inputImages.map(async (image) => ({
          type: "image_url",
          image_url: { url: await blobToDataUrl(image), detail: "auto" }
        })))
      ]
    : input.prompt;
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: [{ role: "user", content }],
    n: 1,
    stream: false
  };
  appendOptionalObjectValue(body, "quality", input.params.quality ?? "high");
  appendImageResolutionValue(provider, body, input.params);

  const raw = await retryTransientImageRequest(() => (
    postJson(
      fetchImpl,
      openAiUrl(provider.baseUrl, "chat/completions"),
      provider.apiKey,
      body,
      input.signal
    )
  ));
  const images = resolveProviderImageUrls(provider, findChatCompletionImages(raw));
  if (images.length > 0) {
    return { raw, images: images.slice(0, 1) };
  }

  const task = findPendingImageTask(raw);
  if (!task) {
    return { raw, images: [] };
  }
  return pollChatCompletionImageTask(provider, task.taskId, raw, fetchImpl, input.signal);
}

type PendingImageTask = {
  taskId: string;
  status?: string;
};

async function pollChatCompletionImageTask(
  provider: ImageProviderConfig,
  taskId: string,
  initialRaw: unknown,
  fetchImpl: FetchLike,
  signal?: AbortSignal
): Promise<ImageGenerationResult> {
  let raw = initialRaw;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = findFirstStringField(raw, "status")?.toLowerCase();
    if (status && ["failed", "error", "cancelled", "canceled"].includes(status)) {
      throw new Error(enhanceImageProviderError(extractError(raw, 502)));
    }
    if (attempt > 0) {
      await delay(1000);
    }
    raw = await getJson(
      fetchImpl,
      openAiUrl(provider.baseUrl, "images/generations/" + encodeURIComponent(taskId)),
      provider.apiKey,
      signal
    );
    const images = resolveProviderImageUrls(provider, findChatCompletionImages(raw));
    if (images.length > 0) {
      return { raw, images: images.slice(0, 1) };
    }
    const nextStatus = findFirstStringField(raw, "status")?.toLowerCase();
    if (nextStatus === "completed") {
      break;
    }
  }
  throw new Error("Chat Completions 生图任务超时，未返回可保存的图片");
}

async function callImagesEndpointStream(
  provider: ImageProviderConfig,
  input: ImageGenerationInput,
  onPartialImage: (partial: ImageGenerationPartial) => void,
  fetchImpl: FetchLike
): Promise<ImageGenerationResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    prompt: input.prompt,
    quality: String(input.params.quality ?? "high"),
    n: Number(input.params.n ?? 1),
    stream: true,
    partial_images: normalizePartialImageCount(input.params.partialImages)
  };
  appendImageResolutionValue(provider, body, input.params);
  return postJsonStream(
    fetchImpl,
    openAiUrl(provider.baseUrl, "images/generations"),
    provider.apiKey,
    body,
    onPartialImage,
    input.signal
  );
}

async function callResponsesEndpointStream(
  provider: ImageProviderConfig,
  input: ImageGenerationInput,
  onPartialImage: (partial: ImageGenerationPartial) => void,
  fetchImpl: FetchLike
): Promise<ImageGenerationResult> {
  const imageGenerationTool: Record<string, unknown> = {
    type: "image_generation",
    partial_images: normalizePartialImageCount(input.params.partialImages)
  };
  appendOptionalObjectValue(imageGenerationTool, "action", input.params.action);
  appendImageResolutionValue(provider, imageGenerationTool, input.params);
  appendOptionalObjectValue(imageGenerationTool, "quality", input.params.quality ?? "high");

  return postJsonStream(
    fetchImpl,
    openAiUrl(provider.baseUrl, "responses"),
    provider.apiKey,
    {
      model: provider.model,
      input: input.prompt,
      tools: [imageGenerationTool],
      stream: true
    },
    onPartialImage,
    input.signal
  );
}

async function postJsonStream(
  fetchImpl: FetchLike,
  url: string,
  apiKey: string,
  body: unknown,
  onPartialImage: (partial: ImageGenerationPartial) => void,
  signal?: AbortSignal
): Promise<ImageGenerationResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image provider network request failed";
    throw new Error(enhanceImageProviderError(message));
  }

  if (!response.ok) {
    const text = await response.text();
    const parsed = parseProviderResponse(text);
    throw new ImageProviderHttpError(
      response.status,
      enhanceImageProviderError(extractError(parsed, response.status))
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body || (!contentType.includes("text/event-stream") && !contentType.includes("ndjson"))) {
    const text = await response.text();
    const raw = parseProviderResponse(text);
    return { raw, images: findImages(raw) };
  }

  return consumeImageEventStream(response.body, contentType, onPartialImage);
}

async function consumeImageEventStream(
  body: ReadableStream<Uint8Array>,
  contentType: string,
  onPartialImage: (partial: ImageGenerationPartial) => void
): Promise<ImageGenerationResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const finalImages: ImageGenerationResult["images"] = [];
  const eventData: string[] = [];
  let buffer = "";
  let raw: unknown = null;
  let eventName = "";
  let completed = false;

  const consumePayload = (payload: string) => {
    if (payload === "[DONE]") { completed = true; return; }
    if (!payload) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    raw = event;
    const type = typeof event.type === "string" ? event.type : eventName;
    if (type === "image_generation.partial_image" || type === "response.image_generation_call.partial_image") {
      const b64Json = typeof event.b64_json === "string"
        ? event.b64_json
        : typeof event.partial_image_b64 === "string"
          ? event.partial_image_b64
          : "";
      if (b64Json) {
        onPartialImage({
          b64Json,
          partialImageIndex: Number(event.partial_image_index ?? 0),
          mimeType: imageMimeType(event.output_format)
        });
      }
      return;
    }
    if (type === "error" || type === "response.failed" || event.error) {
      throw new Error(enhanceImageProviderError(extractError(event, 502)));
    }
    if (type === "image_generation.completed" || type === "image_edit.completed") {
      finalImages.push(...findImages(event));
      completed = true;
      return;
    }
    if (type === "response.completed") {
      finalImages.push(...findImages(event.response ?? event));
      completed = true;
    }
  };

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (contentType.includes("ndjson")) {
      consumePayload(line.trim());
      return;
    }
    if (line === "") {
      consumePayload(eventData.join("\n"));
      eventData.length = 0;
      eventName = "";
      return;
    }
    if (line.startsWith("event:")) { eventName = line.slice(6).trim(); }
    else if (line.startsWith("data:")) {
      eventData.push(line.slice(5).trimStart());
    } else if (!line.startsWith(":") && line.trim().startsWith("{")) {
      consumePayload(line.trim());
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let lineBreak = buffer.indexOf("\n");
      while (lineBreak >= 0) {
        consumeLine(buffer.slice(0, lineBreak));
        if (completed) { return { raw, images: finalImages }; }
        buffer = buffer.slice(lineBreak + 1);
        lineBreak = buffer.indexOf("\n");
      }
      if (done) {
        break;
      }
    }
    if (buffer) {
      consumeLine(buffer);
    }
    if (eventData.length > 0) {
      consumePayload(eventData.join("\n"));
    }

    return { raw, images: finalImages };
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function normalizePartialImageCount(value: unknown) {
  const count = Number(value ?? 1);
  return Math.min(3, Math.max(1, Number.isFinite(count) ? Math.floor(count) : 1));
}

function imageMimeType(outputFormat: unknown) {
  if (outputFormat === "jpeg" || outputFormat === "jpg") {
    return "image/jpeg";
  }
  if (outputFormat === "webp") {
    return "image/webp";
  }
  return "image/png";
}

class ImageProviderHttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

async function postJson(fetchImpl: FetchLike, url: string, apiKey: string, body: unknown, signal?: AbortSignal): Promise<any> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image provider network request failed";
    throw new Error(enhanceImageProviderError(message));
  }

  const text = await response.text();
  const parsed = parseProviderResponse(text);
  if (!response.ok) {
    throw new ImageProviderHttpError(response.status, enhanceImageProviderError(extractError(parsed, response.status)));
  }
  return parsed;
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<any> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + apiKey,
        Accept: "application/json"
      },
      signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image provider network request failed";
    throw new Error(enhanceImageProviderError(message));
  }

  const text = await response.text();
  const parsed = parseProviderResponse(text);
  if (!response.ok) {
    throw new ImageProviderHttpError(
      response.status,
      enhanceImageProviderError(extractError(parsed, response.status))
    );
  }
  return parsed;
}

async function retryTransientImageRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isTransientImageProviderError(message)) {
      throw error;
    }
    await delay(900);
    return request();
  }
}

function isTransientImageProviderError(message: string): boolean {
  return [
    "INTERNAL_ERROR",
    "stream error",
    "fetch failed",
    "socket",
    "ECONNRESET",
    "ETIMEDOUT",
    "network"
  ].some((pattern) => message.toLowerCase().includes(pattern.toLowerCase()));
}

function delay(ms: number) {
  return new Promise((resolve) => windowlessSetTimeout(resolve, ms));
}

const windowlessSetTimeout: typeof setTimeout = setTimeout;

async function postForm(fetchImpl: FetchLike, url: string, apiKey: string, body: FormData, signal?: AbortSignal): Promise<any> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body,
      signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image provider network request failed";
    throw new Error(enhanceImageProviderError(message));
  }

  const text = await response.text();
  const parsed = parseProviderResponse(text);
  if (!response.ok) {
    throw new ImageProviderHttpError(response.status, enhanceImageProviderError(extractError(parsed, response.status)));
  }
  return parsed;
}

function normalizeEditImages(value: unknown): Blob[] {
  if (value instanceof Blob) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is Blob => item instanceof Blob);
  }
  return [];
}

async function blobToDataUrl(blob: Blob) {
  const mimeType = blob.type || "image/png";
  const bytes = Buffer.from(await blob.arrayBuffer());
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function appendOptionalFormValue(form: FormData, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (value instanceof Blob) {
    form.append(key, value, `${key}.png`);
    return;
  }
  form.append(key, String(value));
}

function appendOptionalObjectValue(target: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  target[key] = value;
}

async function excludeInputImages(result: ImageGenerationResult, inputImages: Blob[]) {
  if (inputImages.length === 0 || result.images.length === 0) {
    return result;
  }
  const inputBase64 = new Set(await Promise.all(inputImages.map(async (image) => (
    Buffer.from(await image.arrayBuffer()).toString("base64")
  ))));
  return {
    ...result,
    images: result.images.filter((image) => (
      !image.b64Json || !inputBase64.has(image.b64Json.replace(/\s/g, ""))
    ))
  };
}

function appendImageResolutionValue(
  provider: ImageProviderConfig,
  target: Record<string, unknown>,
  params: Record<string, unknown>
) {
  const capability = provider.imageCapabilities;
  const sizeField = capability?.sizeField === undefined ? "size" : capability.sizeField;
  const resolutionField = capability?.resolutionField === undefined ? "resolution" : capability.resolutionField;
  if (sizeField) appendOptionalObjectValue(target, sizeField, imageSizeForRequest(params));
  if (resolutionField) appendOptionalObjectValue(target, resolutionField, imageResolutionForRequest(params));
  appendOptionalObjectValue(target, "background", params.background);
}

function validateProviderQuality(provider: ImageProviderConfig, params: Record<string, unknown>) {
  const quality = String(params.quality ?? "high");
  const allowed = provider.imageCapabilities?.qualities;
  if (allowed?.length && !allowed.includes(quality)) throw new Error("渠道不支持质量 " + quality + "，允许值：" + allowed.join(", "));
}

function withImageMetadata(
  image: ImageGenerationResult["images"][number],
  raw: unknown,
  item: Record<string, unknown>
): ImageGenerationResult["images"][number] {
  const rawRecord = isRecord(raw) ? raw : {};
  const upstreamSize = firstString(item.size, rawRecord.size);
  const upstreamQuality = firstString(item.quality, rawRecord.quality);
  const upstreamResolution = firstString(item.resolution, rawRecord.resolution);
  const upstreamModel = firstString(item.model, rawRecord.model);
  return {
    ...image,
    ...(upstreamSize ? { upstreamSize } : {}),
    ...(upstreamQuality ? { upstreamQuality } : {}),
    ...(upstreamResolution ? { upstreamResolution } : {}),
    ...(upstreamModel ? { upstreamModel } : {})
  };
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findChatCompletionImages(value: unknown): ImageGenerationResult["images"] {
  const images: ImageGenerationResult["images"] = [...findImages(value)];
  walkValues(value, (entry) => {
    if (typeof entry === "string") {
      images.push(...parseImageReferences(entry));
    }
  });
  return dedupeImages(images);
}

function parseImageReferences(value: string): ImageGenerationResult["images"] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return findChatCompletionImages(JSON.parse(trimmed));
    } catch {
      // Continue with Markdown/data URL parsing for non-JSON text.
    }
  }

  const images: ImageGenerationResult["images"] = [];
  const markdownPattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of trimmed.matchAll(markdownPattern)) {
    const image = parseImageReference(match[1] ?? "");
    if (image) {
      images.push(image);
    }
  }
  const dataUrlPattern = /data:image\/[^;,]+;base64,[A-Za-z0-9+/=_-]+/gi;
  for (const match of trimmed.matchAll(dataUrlPattern)) {
    const image = parseImageReference(match[0]);
    if (image) {
      images.push(image);
    }
  }
  if (images.length === 0 && (/^https?:\/\/\S+$/i.test(trimmed) || /^\/\S+$/.test(trimmed)) && (/^\/\S+$/.test(trimmed) || /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(trimmed))) {
    images.push({ url: trimmed });
  }
  return images;
}

function parseImageReference(value: string): { b64Json?: string; url?: string } | null {
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  const dataUrl = normalized.match(/^data:image\/[^;,]+;base64,(.+)$/i);
  if (dataUrl?.[1]) {
    return { b64Json: dataUrl[1].replace(/\s/g, "") };
  }
  if (/^https?:\/\//i.test(normalized) || normalized.startsWith("/")) {
    return { url: normalized };
  }
  return null;
}

function dedupeImages(images: ImageGenerationResult["images"]): ImageGenerationResult["images"] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = image.b64Json ? "b64:" + image.b64Json : image.url ? "url:" + image.url : "";
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function walkValues(value: unknown, visit: (entry: unknown) => void) {
  visit(value);
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkValues(item, visit);
    }
    return;
  }
  for (const item of Object.values(value)) {
    walkValues(item, visit);
  }
}

function findPendingImageTask(value: unknown): PendingImageTask | null {
  let result: PendingImageTask | null = null;
  walk(value, (entry) => {
    if (result || typeof entry.task_id !== "string" || !entry.task_id.trim()) {
      return;
    }
    result = {
      taskId: entry.task_id.trim(),
      status: typeof entry.status === "string" ? entry.status : undefined
    };
  });
  return result;
}

function findFirstStringField(value: unknown, field: string): string | undefined {
  let result: string | undefined;
  walk(value, (entry) => {
    if (!result && typeof entry[field] === "string") {
      result = entry[field] as string;
    }
  });
  return result;
}

function resolveProviderImageUrls(
  provider: ImageProviderConfig,
  images: ImageGenerationResult["images"]
): ImageGenerationResult["images"] {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "") + "/";
  return images.map((image) => {
    if (!image.url || !image.url.startsWith("/")) {
      return image;
    }
    try {
      return { ...image, url: new URL(image.url, baseUrl).toString() };
    } catch {
      return image;
    }
  });
}

function extractImagesResponse(raw: Record<string, unknown>) {
  if (raw.error || (typeof raw.code === "number" && raw.code !== 0 && raw.code !== 200)) {
    throw new Error(enhanceImageProviderError(extractError(raw, 502)));
  }
  const rows = raw.data ?? raw.images ?? raw.results;
  return Array.isArray(rows) ? findImages(rows, raw) : [];
}

function findImages(value: unknown, root: unknown = value): ImageGenerationResult["images"] {
  const images: ImageGenerationResult["images"] = [];
  walk(value, (entry) => {
    const metadata = withImageMetadata({}, root, entry);
    if (typeof entry.b64_json === "string") {
      images.push({ ...metadata, b64Json: entry.b64_json });
    }
    if (typeof entry.result === "string" && entry.type === "image_generation_call") {
      images.push({ ...metadata, b64Json: entry.result });
    }
    if (typeof entry.image_base64 === "string") {
      images.push({ ...metadata, b64Json: entry.image_base64 });
    }
    const urls = [
      typeof entry.url === "string" ? entry.url : undefined,
      typeof entry.result_url === "string" ? entry.result_url : undefined,
      typeof entry.image_url === "string" ? entry.image_url : undefined
    ];
    for (const url of urls) {
      if (url && url.startsWith("http") && typeof entry.b64_json !== "string" && typeof entry.image_base64 !== "string") {
        images.push({ ...metadata, url });
      }
    }
  });
  return images;
}

function walk(value: unknown, visit: (entry: Record<string, unknown>) => void) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }

  const entry = value as Record<string, unknown>;
  visit(entry);
  for (const item of Object.values(entry)) {
    walk(item, visit);
  }
}

function openAiUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const versionedBase = normalizedBase.endsWith("/v1") ? normalizedBase : `${normalizedBase}/v1`;
  return `${versionedBase}/${endpoint.replace(/^\/+/, "")}`;
}

function parseProviderResponse(text: string): any {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

function extractError(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object" && "message" in error) {
      return String((error as { message: unknown }).message);
    }
    if (typeof error === "string") {
      return error;
    }
  }
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string") {
      return detail;
    }
    if (detail !== undefined) {
      return JSON.stringify(detail);
    }
  }
  if (isRecord(body)) {
    const message = firstString(body.message, body.msg);
    if (message) return message;
  }
  return `Provider request failed with status ${status}`;
}

function enhanceImageProviderError(message: string): string {
  if (isCloudflareTimeout(message)) {
    return "上游图像接口超时（Cloudflare 524）：源站处理生图请求过久。Paintopia 已支持自动尝试备用生图通道；如果所有通道都失败，请稍后重试或切换接口。";
  }
  if (
    message.includes("gpt-image-2")
    && message.includes("Codex")
    && message.includes("ChatGPT account")
  ) {
    return [
      "当前 Codex 反代账号不支持直接使用 gpt-image-2。",
      "请把生图 Provider 配置为 Responses 工具模式，模型填写 gpt-5.5 或该服务显示支持 image_generation 的主线模型。",
      `原始错误：${message}`
    ].join(" ");
  }
  return compactProviderError(message);
}

function isCloudflareTimeout(message: string): boolean {
  return (
    message.includes("Error code 524")
    || message.includes("524: A timeout occurred")
    || message.includes("The origin web server timed out")
  );
}

function compactProviderError(message: string): string {
  const stripped = message
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 420 ? `${stripped.slice(0, 420)}...` : stripped;
}
