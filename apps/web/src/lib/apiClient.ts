import { mapUploads, putUpload } from "./uploadQueue";
import type { PaintopiaUser } from "../app/AppShell";
import type { DailyCheckInResult, DailyCheckInStatus, GalleryTag, ImageProviderCapabilities, PromptLibraryItem } from "@paintopia/shared";

const JSON_HEADERS = {
  "Content-Type": "application/json"
};

const IMAGE_EDIT_RECOVERY_TIMEOUT_MS = 6 * 60 * 1000;
const IMAGE_EDIT_RECOVERY_POLL_MS = 2_000;

export const apiClient = {
  async listMediaFeed(kind: "assets" | "gallery", query: URLSearchParams, signal?: AbortSignal): Promise<{items: (GeneratedAsset | GalleryItem)[]; nextCursor: string | null}> {
    return request(`/api/media-feed/${kind}?${query}`, { signal });
  },
  async login(credentials: { email: string; password: string }): Promise<PaintopiaUser> {
    return request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials)
    });
  },

  async register(input: { email: string; password: string; inviteCode: string }): Promise<PaintopiaUser> {
    return request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async logout(): Promise<void> {
    await request("/api/auth/logout", { method: "POST" });
  },

  async me(): Promise<PaintopiaUser> {
    return request("/api/auth/me");
  },

  async changePassword(input: { currentPassword: string; newPassword: string }): Promise<{ ok: true }> {
    return request("/api/auth/change-password", { method: "POST", body: JSON.stringify(input) });
  },

  async getDailyCheckIn(signal?: AbortSignal): Promise<DailyCheckInStatus> {
    return request("/api/check-in", { signal });
  },

  async claimDailyCheckIn(): Promise<DailyCheckInResult> {
    return request("/api/check-in", { method: "POST", body: "{}" });
  },

  async getGenerationStats(): Promise<GenerationStats> {
    return request("/api/generation-stats");
  },

  /** scope "all" 仅管理员可用（后台统计）；"mine" 为使用日志，任何角色都只返回本人记录。 */
  async listGenerationHistory(filters: GenerationHistoryFilters = {}, scope: "mine" | "all" = "mine"): Promise<GenerationHistoryResponse> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) { if (value !== undefined && value !== "") query.set(key, String(value)); }
    return request(`${scope === "all" ? "/api/admin/generation-history" : "/api/generation-history"}?${query}`);
  },

  async listImageCapabilities(): Promise<ImageCapabilitiesResponse> {
    return request("/api/image-capabilities");
  },

  async generate(input: { prompt: string; params: Record<string, unknown>; providerId?: string }): Promise<GenerationResponse> {
    return request("/api/generate", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async generateStream(
    input: { prompt: string; params: Record<string, unknown>; providerId?: string },
    onPreview: (preview: GenerationPreview) => void,
    onStage?: (event: GenerationStage) => void
  ): Promise<GenerationResponse> {
    return requestGenerationStream(input, onPreview, onStage);
  },

  async generateEdit(
    input: ImageEditGenerationRequest,
    onRecovering?: () => void
  ): Promise<GenerationResponse> {
    const clientRequestId = createClientRequestId();
    let uploadedAssets: GeneratedAsset[];
    try {
      uploadedAssets = await mapUploads(input.images ?? [], image => uploadAssetFile(image, input.prompt));
    } catch (error) {
      if (isFetchNetworkError(error)) {
        throw new Error("参考图上传连接失败，请检查网络后重试");
      }
      throw error;
    }
    try {
      return await request("/api/generate/edit", {
        method: "POST",
        body: JSON.stringify({
          prompt: input.prompt,
          providerId: input.providerId,
          params: { ...input.params, clientRequestId },
          assetIds: input.assetIds ?? [],
          transientAssetIds: uploadedAssets.map((asset) => asset.id)
        })
      });
    } catch (error) {
      if (!isImageEditRecoverableDisconnect(error)) {
        throw error;
      }
      onRecovering?.();
      const assets = await recoverGeneratedEditAssets(clientRequestId);
      const remainingQuota = await request<PaintopiaUser>("/api/auth/me")
        .then((user) => user.quota)
        .catch(() => undefined);
      return { assets, remainingQuota, recovered: true };
    }
  },

  async uploadAsset(file: File, prompt = ""): Promise<GeneratedAsset> {
    return uploadAssetFile(file, prompt);
  },

  /** 优化弹窗可选的模板（只有名称），默认模板排第一。 */
  async listOptimizeTemplates(): Promise<OptimizeTemplateOption[]> {
    return request("/api/prompt-tools/templates");
  },

  async optimize(input: PromptToolRequest): Promise<PromptToolResponse> {
    return request("/api/prompt-tools/optimize", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async listPrompts(): Promise<PromptLibraryItem[]> {
    return request("/api/prompts");
  },

  async listAssets(): Promise<GeneratedAsset[]> {
    return request("/api/assets");
  },

  async listGalleryItems(): Promise<GalleryItem[]> {
    return request("/api/gallery");
  },

  async listGalleryReview(status: GalleryItem["status"] | "all" = "pending"): Promise<GalleryItem[]> {
    return request(`/api/admin/gallery-review?status=${encodeURIComponent(status)}`);
  },

  async reviewGalleryItem(
    galleryItemId: string,
    decision: "approve" | "reject",
    reason?: string,
    tagIds?: string[]
  ): Promise<GalleryItem> {
    return request(`/api/admin/gallery-review/${encodeURIComponent(galleryItemId)}`, {
      method: "PATCH",
      body: JSON.stringify({ decision, reason, tagIds })
    });
  },

  async listGalleryTags(): Promise<GalleryTag[]> {
    return (await request<{ tags: GalleryTag[] }>("/api/gallery-tags")).tags;
  },

  /** 当前用户在画廊里能看到的作品，各标签被使用的次数（未使用的标签不出现）。 */
  async listGalleryTagUsage(): Promise<Record<string, number>> {
    return (await request<{ counts: Record<string, number> }>("/api/gallery-tags/in-use")).counts;
  },

  /** 同名（含内置别名）已存在时返回已有标签，不会重复创建。 */
  async createGalleryTag(label: string, group: GalleryTag["group"]): Promise<GalleryTag> {
    return request("/api/admin/gallery-tags", { method: "POST", body: JSON.stringify({ label, group }) });
  },

  async updateGalleryTags(galleryItemId: string, tagIds: string[]): Promise<GalleryItem> {
    return request(`/api/admin/gallery-review/${encodeURIComponent(galleryItemId)}/tags`, {
      method: "PATCH",
      body: JSON.stringify({ tagIds })
    });
  },

  async deleteAsset(assetId: string): Promise<void> {
    await request(`/api/assets/${encodeURIComponent(assetId)}`, {
      method: "DELETE"
    });
  },

  async syncAssetToGallery(assetId: string): Promise<GalleryItem> {
    return request(`/api/assets/${encodeURIComponent(assetId)}/gallery`, {
      method: "POST"
    });
  },

  async unsyncAssetFromGallery(assetId: string): Promise<{ expiresAt: string | null }> {
    return request(`/api/assets/${encodeURIComponent(assetId)}/gallery`, {
      method: "DELETE"
    });
  },

  async createProvider(input: ProviderRequest): Promise<unknown> {
    return request("/api/admin/providers", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async listProviders(): Promise<ProviderConfigResponse[]> {
    return request("/api/admin/providers");
  },

  async listProviderQuotas(): Promise<ProviderQuotaResponse[]> {
    return request("/api/admin/providers/quotas");
  },

  async updateProvider(providerId: string, input: ProviderRequest): Promise<ProviderConfigResponse> {
    return request(`/api/admin/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async reorderProviders(kind: "image" | "text", providerIds: string[]): Promise<ProviderConfigResponse[]> {
    return request("/api/admin/providers/order", {
      method: "PATCH",
      body: JSON.stringify({ kind, providerIds })
    });
  },

  async deleteProvider(providerId: string): Promise<void> {
    await request(`/api/admin/providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE"
    });
  },

  async testProvider(input: ProviderTestRequest): Promise<ProviderTestResponse> {
    return request("/api/admin/providers/test", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async listProviderModels(input: ProviderModelsRequest): Promise<ProviderModelsResponse> {
    return request("/api/admin/providers/models", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async createTemplate(input: TemplateRequest): Promise<TemplateResponse> {
    return request("/api/admin/templates", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async listTemplates(): Promise<TemplateResponse[]> {
    return request("/api/admin/templates");
  },

  async updateTemplate(templateId: string, input: TemplateRequest): Promise<TemplateResponse> {
    return request(`/api/admin/templates/${encodeURIComponent(templateId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  /** 设为创作页「优化」使用的默认模板，返回更新后的完整列表。 */
  async setDefaultTemplate(templateId: string): Promise<TemplateResponse[]> {
    return request(`/api/admin/templates/${encodeURIComponent(templateId)}/default`, { method: "POST" });
  },

  async deleteTemplate(templateId: string): Promise<void> {
    await request(`/api/admin/templates/${encodeURIComponent(templateId)}`, {
      method: "DELETE"
    });
  },

  async listQuotaPricing(): Promise<QuotaPricingRule[]> {
    return request("/api/quota-pricing");
  },

  async updateQuotaPricing(rules: Array<{ key: string; amount: number }>): Promise<QuotaPricingRule[]> {
    return request("/api/admin/quota-pricing", {
      method: "PATCH",
      body: JSON.stringify({ rules })
    });
  },

  async listUsers(query = ""): Promise<AdminUser[]> {
    const search = query.trim();
    const suffix = search ? `?q=${encodeURIComponent(search)}` : "";
    return request(`/api/admin/users${suffix}`);
  },

  async getAdminGenerationStats(): Promise<GenerationStats> {
    return request("/api/admin/generation-stats");
  },

  async updateUserQuota(userId: string, quota: number): Promise<AdminUser> {
    return request(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ quota })
    });
  },

  async listInviteCodes(filters: { q?: string; status?: string } = {}): Promise<AdminInviteCode[]> {
    const params = new URLSearchParams();
    if (filters.q?.trim()) {
      params.set("q", filters.q.trim());
    }
    if (filters.status && filters.status !== "all") {
      params.set("status", filters.status);
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request(`/api/admin/invite-codes${suffix}`);
  },

  async createInviteCode(): Promise<AdminInviteCode> {
    return request("/api/admin/invite-codes", {
      method: "POST"
    });
  },

  async destroyInviteCode(inviteId: string): Promise<AdminInviteCode> {
    return request(`/api/admin/invite-codes/${encodeURIComponent(inviteId)}`, {
      method: "DELETE"
    });
  }
};

export type PromptToolRequest = {
  inputPrompt: string;
  targetModel: string;
  outputFormat?: string;
  weightRules?: string;
  styleConstraints?: string;
  negativePromptRules?: string;
  /** 仅 optimize 使用；缺省时与输入同语言。 */
  outputLanguage?: "zh" | "en";
  /** 仅 optimize 使用；缺省或已删除时用默认模板。 */
  templateId?: string;
};

export type OptimizeTemplateOption = { id: string; name: string; isDefault: boolean };

export type PromptToolResponse = {
  providerConfigured: boolean;
  text: string;
  systemPrompt: string;
};

export type ProviderRequest = {
  imageCapabilities?: ImageProviderCapabilities;
  kind: "image" | "text";
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: string;
  maxConcurrency?: number;
  enabled?: boolean;
};

export type ProviderTestRequest = ProviderRequest & {
  providerId?: string;
  prompt?: string;
};

export type ProviderTestResponse = {
  ok: boolean;
  status: "connected" | "failed";
  latencyMs: number;
  totalTokens?: number;
  message: string;
};

export type ProviderConfigResponse = ProviderRequest & {
  id: string;
  apiKey: string;
  sortOrder?: number;
};

export type ProviderQuotaResponse = {
  providerId: string;
  status: "available" | "unlimited" | "unknown";
  remaining: number | null;
  used: number | null;
  total: number | null;
  source: "newapi" | "credit_grants" | null;
  scope?: "token" | "account" | null;
  unit?: string | null;
  checkedAt?: string;
  tokenUnlimited?: boolean;
};

export type ProviderModelsRequest = {
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
};

export type ProviderModelsResponse = {
  models: string[];
};

export type GenerationHistoryFilters = { page?: number; pageSize?: number; from?: string; to?: string; user?: string; model?: string; provider?: string; status?: string };
export type GenerationHistoryResponse = { summary?: {total:number;succeeded:number;failed:number;successRate:number;averageDurationMs:number}; options?:{models:string[];providers:string[]}; items: GenerationHistoryItem[]; total: number; page: number; pageSize: number };
export type GenerationHistoryItem = {
  userId: string; userEmail: string; quotaCost: number | null;
  id: string; providerId: string | null; providerName: string; model: string;
  status: string; createdAt: string; updatedAt: string; params: Record<string, unknown>;
  error: string | null; durationMs: number | null; attempts?: unknown[];
};

export type ImageModelCapability = {
  imageCapabilities?: ImageProviderCapabilities;
  providerId?: string;
  providerName?: string;
  mode?: string;
  model: string;
  resolutions: string[];
};

export type ImageCapabilitiesResponse = {
  models: ImageModelCapability[];
};

export type QuotaPricingRule = {
  key: string;
  label: string;
  amount: number;
};

export type ImageEditGenerationRequest = {
  prompt: string;
  params: Record<string, unknown>;
  images?: File[];
  assetIds?: string[];
  providerId?: string;
};

export type TemplateRequest = {
  name: string;
  type: "optimize";
  targetModel: string;
  content: string;
};

export type TemplateResponse = TemplateRequest & {
  id: string;
  isDefault: boolean;
};

export type AdminUser = {
  id: string;
  email: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  quota: number;
  createdAt: string;
  updatedAt: string;
};

export type GenerationStats = {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  running: number;
  queued: number;
  successRate: number;
  averageDurationMs: number;
  textStats?: TextToolStats;
  userStats?: UserStats;
};

export type TextToolStats = {
  totalRuns: number;
  succeeded: number;
  failed: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  averageDurationMs: number;
  byProvider: TextProviderStats[];
  byType: TextTypeStats[];
};

export type TextProviderStats = TextToolStatsSummary & {
  providerId: string | null;
  providerName: string;
};

export type TextTypeStats = Pick<TextToolStatsSummary, "totalRuns" | "succeeded" | "failed" | "successRate" | "totalTokens"> & {
  type: "translate" | "optimize";
};

type TextToolStatsSummary = {
  totalRuns: number;
  succeeded: number;
  failed: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  averageDurationMs: number;
};

export type UserStats = {
  total: number;
  active: number;
  disabled: number;
  admins: number;
  regularUsers: number;
};

export type GeneratedAsset = {
  width?:number|null; height?:number|null;
  sizeBytes?: number | null;
  id: string;
  imageUrl: string;
  thumbnailUrl?: string;
  thumbnailEdgeUrl?: string | null;
  thumbnailEdgeExpiresAt?: number;
  ownerName?: string;
  ownerEmail?: string | null;
  prompt: string;
  params?: Record<string, unknown>;
  createdAt: string;
  gallerySynced?: boolean;
  galleryItemId?: string | null;
  galleryStatus?: GalleryItem["status"] | null;
  expiresAt?: string | null;
  /** 仅管理员可见：已加入灵感页站主推荐时为其 id。 */
  curatedPromptId?: string | null;
};

export type GalleryItem = {
  tags: GalleryTag[];
  width?:number|null; height?:number|null;
  id: string;
  assetId: string;
  userId: string;
  imageUrl: string;
  thumbnailUrl?: string;
  thumbnailEdgeUrl?: string | null;
  thumbnailEdgeExpiresAt?: number;
  authorName?: string;
  title: string;
  prompt: string;
  status: "pending" | "approved" | "rejected";
  rejectionReason?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
};

export type AdminInviteCode = {
  id: string;
  code: string;
  status: "active" | "used" | "destroyed";
  createdByEmail: string | null;
  usedByEmail: string | null;
  createdAt: string;
  usedAt: string | null;
  destroyedAt: string | null;
};

export type GenerationStage = { type: "stage"; stage: "requesting" | "waiting" | "saving"; message: string; providerName?: string; model?: string };

export type GenerationPreview = {
  imageUrl: string;
  partialImageIndex: number;
};

export type GenerationResponse = {
  jobId?: string;
  quotaCost?: number;
  remainingQuota?: number;
  recovered?: boolean;
  provider?: {
    id: string;
    name: string;
  };
  skippedProviders?: string[];
  assets: GeneratedAsset[];
};

function createClientRequestId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isFetchNetworkError(error: unknown): error is TypeError {
  return error instanceof TypeError;
}

function isImageEditRecoverableDisconnect(error: unknown) {
  return isFetchNetworkError(error)
    || (error instanceof Error && /^请求失败: (502|503|504|520|522|523|524)$/.test(error.message));
}

async function recoverGeneratedEditAssets(clientRequestId: string): Promise<GeneratedAsset[]> {
  const deadline = Date.now() + IMAGE_EDIT_RECOVERY_TIMEOUT_MS;
  let consecutiveNetworkFailures = 0;

  while (Date.now() < deadline) {
    try {
      const assets = await request<GeneratedAsset[]>("/api/assets");
      const recovered = assets.filter((asset) => (
        asset.params?.clientRequestId === clientRequestId
      ));
      if (recovered.length > 0) {
        return recovered;
      }
      consecutiveNetworkFailures = 0;
    } catch (error) {
      if (!isFetchNetworkError(error)) {
        throw error;
      }
      consecutiveNetworkFailures += 1;
      if (consecutiveNetworkFailures >= 5) {
        throw new Error("网络连接持续中断，请恢复网络后到资产页查看生成结果");
      }
    }
    await delay(IMAGE_EDIT_RECOVERY_POLL_MS);
  }

  throw new Error("生成请求连接已中断，服务端可能仍在处理，请稍后到资产页查看结果");
}

function delay(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}

async function requestGenerationStream(
  input: { prompt: string; params: Record<string, unknown>; providerId?: string },
  onPreview: (preview: GenerationPreview) => void,
    onStage?: (event: GenerationStage) => void
): Promise<GenerationResponse> {
  const response = await fetch("/api/generate/stream", {
    method: "POST",
    credentials: "include",
    headers: {
      ...JSON_HEADERS,
      Accept: "application/x-ndjson"
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    let message = `请求失败: ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // keep status fallback
    }
    throw new Error(message);
  }
  if (!response.body) {
    throw new Error("浏览器未提供流式响应正文");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: GenerationResponse | null = null;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    if (event.type === "stage" && typeof event.message === "string") {
      onStage?.(event as GenerationStage);
      return;
    }
    if (event.type === "preview" && typeof event.b64Json === "string") {
      const mimeType = typeof event.mimeType === "string" ? event.mimeType : "image/png";
      onPreview({
        imageUrl: `data:${mimeType};base64,${event.b64Json}`,
        partialImageIndex: Number(event.partialImageIndex ?? 0)
      });
      return;
    }
    if (event.type === "completed" && event.result && typeof event.result === "object") {
      completed = event.result as GenerationResponse;
      return;
    }
    if (event.type === "error") {
      throw new Error(typeof event.error === "string" ? event.error : "图像生成失败");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let lineBreak = buffer.indexOf("\n");
    while (lineBreak >= 0) {
      consumeLine(buffer.slice(0, lineBreak));
      buffer = buffer.slice(lineBreak + 1);
      lineBreak = buffer.indexOf("\n");
    }
    if (done) {
      break;
    }
  }
  if (buffer.trim()) {
    consumeLine(buffer);
  }
  if (!completed) {
    throw new Error("图像生成流在完成事件前已结束");
  }
  return completed;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = {
    ...(init.body ? JSON_HEADERS : {}),
    ...init.headers
  };

  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    let message = `请求失败: ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // keep status fallback
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function uploadAssetFile(file: File, prompt: string): Promise<GeneratedAsset> {
  const intent = await request<AssetUploadIntent>("/api/assets/uploads", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      prompt
    })
  });
  const uploadResponse = await putUpload(intent.uploadUrl, {
    method: intent.method,
    credentials: intent.uploadUrl.startsWith("/") ? "include" : "omit",
    headers: intent.headers,
    body: file
  });
  if (!uploadResponse.ok) {
    let message = `上传失败: ${uploadResponse.status}`;
    try {
      const responseBody = await uploadResponse.json();
      if (typeof responseBody.error === "string") {
        message = responseBody.error;
      }
    } catch {
      // keep status fallback
    }
    throw new Error(message);
  }
  return request(`/api/assets/${encodeURIComponent(intent.assetId)}/complete-upload`, {
    method: "POST"
  });
}

type AssetUploadIntent = {
  assetId: string;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string | null;
};
