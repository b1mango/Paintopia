/**
 * 进行中的生成记在 localStorage：页面刷新后凭 clientRequestId 向服务端查询，接着显示生成进度。
 * 只存恢复界面所需的参数，不存参考图文件。
 */
export interface PendingGeneration {
  clientRequestId: string;
  startedAt: number;
  prompt: string;
  imageModel: string;
  imageResolution: string;
  imageQuality: string;
  imageCount: number;
  imageWidth: string;
  imageHeight: string;
  aspectRatio: string;
  transparentBackground: boolean;
}

/** 超过这个时长仍未完成的记录视为已中断，不再接续。 */
export const PENDING_GENERATION_MAX_AGE_MS = 15 * 60_000;

const storageKey = (userKey: string) => `paintopia:pending-generation:${userKey}`;

export function createClientRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function savePendingGeneration(userKey: string, pending: PendingGeneration) {
  try { localStorage.setItem(storageKey(userKey), JSON.stringify(pending)); } catch { /* 存储不可用时只是失去刷新接续能力 */ }
}

export function clearPendingGeneration(userKey: string, clientRequestId: string) {
  try {
    if (loadPendingGeneration(userKey)?.clientRequestId === clientRequestId) localStorage.removeItem(storageKey(userKey));
  } catch { /* 同上 */ }
}

export function loadPendingGeneration(userKey: string): PendingGeneration | null {
  try {
    const raw = localStorage.getItem(storageKey(userKey));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingGeneration>;
    if (typeof value.clientRequestId !== "string" || typeof value.startedAt !== "number" || typeof value.prompt !== "string") return null;
    if (Date.now() - value.startedAt > PENDING_GENERATION_MAX_AGE_MS) { localStorage.removeItem(storageKey(userKey)); return null; }
    return value as PendingGeneration;
  } catch { return null; }
}
