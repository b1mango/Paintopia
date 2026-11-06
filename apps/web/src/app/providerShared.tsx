import styles from "../features/admin/admin.module.css";
import { ConfirmDialog } from "../features/admin/AdminDialog";
import { apiClient, type ProviderConfigResponse, type ProviderRequest } from "../lib/apiClient";

export type TextProvider = ProviderRequest & { id: string };

export type ImageProviderPreset = ProviderRequest & { id: string };

export type ProviderTestState = {
  status: "testing" | "connected" | "failed";
  latencyMs?: number;
};

export const PROVIDER_CHANGE_EVENT = "paintopia:providers-changed";

export function notifyProviderChange() {
  window.dispatchEvent(new Event(PROVIDER_CHANGE_EVENT));
  try { localStorage.setItem(PROVIDER_CHANGE_EVENT, `${Date.now()}-${Math.random()}`); } catch { /* Storage can be disabled. Focus still refreshes the list. */ }
}

export function splitProviderModels(value: string | null | undefined) {
  return Array.from(new Set(
    String(value ?? "")
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

export function joinProviderModels(models: string[]) {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean))).join(", ");
}

export function mergeModelOptions(selectedModels: string[], discoveredModels: string[] | undefined) {
  return Array.from(new Set([...selectedModels, ...(discoveredModels ?? [])])).filter(Boolean);
}

export function preferredFetchedImageModels(models: string[]) {
  const imageModels = models.filter((model) => /image|dall|flux|midjourney|mj|draw/i.test(model));
  return imageModels.length ? imageModels : models.slice(0, 1);
}

export function providerModelSummary(value: string) {
  const models = splitProviderModels(value);
  if (models.length <= 2) {
    return models.join(", ") || "未填写模型";
  }
  return `${models.slice(0, 2).join(", ")} +${models.length - 2}`;
}

export function readProviderForm(form: HTMLFormElement | null, fallback: ProviderRequest): ProviderRequest {
  const data = new FormData(form ?? undefined);
  const hasEnabledField = Boolean(form?.elements.namedItem("enabled"));
  const selectedModels = data.getAll("model").map((value) => String(value)).filter(Boolean);
  return {
    kind: fallback.kind,
    name: String(data.get("name") || fallback.name),
    baseUrl: String(data.get("baseUrl") || fallback.baseUrl),
    apiKey: String(data.get("apiKey") ?? ""),
    model: selectedModels.length ? joinProviderModels(selectedModels) : fallback.model,
    mode: String(data.get("mode") || fallback.mode),
    maxConcurrency: Number(data.get("maxConcurrency") || fallback.maxConcurrency || 1),
    enabled: hasEnabledField ? data.get("enabled") === "on" : fallback.enabled,
    imageCapabilities: fallback.kind === "image" ? {
      qualities: String(data.get("qualities") ?? fallback.imageCapabilities?.qualities?.join(",") ?? "").split(",").map(item => item.trim()).filter(Boolean),
      sizeField: data.has("sizeField") ? (data.get("sizeField") === "none" ? null : data.get("sizeField") as "size" | "image_size") : fallback.imageCapabilities?.sizeField,
      resolutionField: data.has("resolutionField") ? (data.get("resolutionField") === "none" ? null : data.get("resolutionField") as "resolution" | "image_size") : fallback.imageCapabilities?.resolutionField,
      supportsStreaming: data.has("supportsStreamingConfigured") ? data.get("supportsStreaming") === "on" : fallback.imageCapabilities?.supportsStreaming
    } : undefined
  };
}

export async function saveProviderConfig(
  providerId: string,
  request: ProviderRequest,
  newPrefix: string
): Promise<ProviderRequest & { id?: string }> {
  if (providerId.startsWith(newPrefix)) {
    return apiClient.createProvider(request) as Promise<ProviderRequest & { id?: string }>;
  }
  return apiClient.updateProvider(providerId, request);
}

export function moveProviderBefore<T extends { id: string }>(items: T[], draggedId: string, targetId: string): T[] {
  if (draggedId === targetId) {
    return items;
  }
  const dragged = items.find((item) => item.id === draggedId);
  if (!dragged || !items.some((item) => item.id === targetId)) {
    return items;
  }
  const withoutDragged = items.filter((item) => item.id !== draggedId);
  const targetIndex = withoutDragged.findIndex((item) => item.id === targetId);
  return [
    ...withoutDragged.slice(0, targetIndex),
    dragged,
    ...withoutDragged.slice(targetIndex)
  ];
}

export function persistedProviderIds(providers: Array<{ id: string }>, newPrefix: string) {
  return providers
    .map((provider) => provider.id)
    .filter((id) => !id.startsWith(newPrefix));
}

export function ProviderTestBadge({ state }: { state?: ProviderTestState }) {
  if (!state) {
    return null;
  }
  const label = state.status === "testing"
    ? "测试中"
    : state.status === "connected"
      ? `${state.latencyMs ?? "--"} ms`
      : "失败";
  return <span className={state.status === "failed" ? styles.providerLatencyFailed : styles.providerLatency}>{label}</span>;
}

export type ProviderConfigProps = {
  savedProviders: ProviderConfigResponse[] | null;
  providerLoadError: string;
};

export function ProviderDeleteDialog({ name, busy, onCancel, onConfirm }: { name: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <ConfirmDialog label="删除接口确认" title="删除接口？" busy={busy} onCancel={onCancel} onConfirm={onConfirm}>
    <p>删除“{name}”后将无法再使用该接口。已有资产和调用记录会保留。</p>
  </ConfirmDialog>;
}
