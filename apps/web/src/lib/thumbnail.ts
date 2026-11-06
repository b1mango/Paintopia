import type { SyntheticEvent } from "react";
import type { GeneratedAsset } from "./apiClient";

/** 320 小图：签名未过期时直取边缘，否则走 API（API 会按需补生成）。 */
const apiSmallThumbnail = (asset: GeneratedAsset) => (asset.thumbnailUrl ?? `/api/assets/${encodeURIComponent(asset.id)}/thumbnail`) + "?size=320";

export const smallThumbnail = (asset: GeneratedAsset) =>
  asset.thumbnailEdgeUrl && (asset.thumbnailEdgeExpiresAt ?? 0) > Date.now() ? asset.thumbnailEdgeUrl : apiSmallThumbnail(asset);

/** 边缘小图缺失（历史作品）时回退到 API；API 也失败才交给 onFail。 */
export function smallThumbnailFallback(asset: GeneratedAsset, onFail?: () => void) {
  return (event: SyntheticEvent<HTMLImageElement>) => {
    const fallback = apiSmallThumbnail(asset);
    if (event.currentTarget.getAttribute("src") !== fallback) event.currentTarget.src = fallback;
    else onFail?.();
  };
}

type FeedImage = { id: string; imageUrl: string; thumbnailUrl?: string; thumbnailEdgeUrl?: string | null; thumbnailEdgeExpiresAt?: number };
const pinned = new Map<string, string>();
const pinKey = (item: FeedImage) => item.thumbnailUrl ?? item.imageUrl;

/**
 * 列表缩略图：同一页面会话里每张图只认一个地址。列表刷新会带来新签名，
 * 若跟着换 src 就会整页重下；钉住首个有效的边缘地址，浏览器内存缓存直接复用。
 */
export function feedThumbnail(item: FeedImage) {
  const kept = pinned.get(pinKey(item));
  if (kept) return kept;
  if (item.thumbnailEdgeUrl && (item.thumbnailEdgeExpiresAt ?? 0) > Date.now()) {
    pinned.set(pinKey(item), item.thumbnailEdgeUrl);
    return item.thumbnailEdgeUrl;
  }
  return item.thumbnailUrl ?? item.imageUrl;
}

/**
 * 边缘地址失效（懒加载到时签名已过期、历史作品缺图）时依次退到 API 缩略图、原图，
 * 并记住当前一级，避免重挂载时再撞一次；原图也失败就停在那里，不再循环。
 */
export function feedThumbnailFallback(item: FeedImage) {
  return (event: SyntheticEvent<HTMLImageElement>) => {
    const chain = [item.thumbnailUrl, item.imageUrl].filter((url): url is string => Boolean(url));
    const current = event.currentTarget.getAttribute("src");
    const next = chain[chain.indexOf(current ?? "") + 1];
    if (!next) return;
    pinned.set(pinKey(item), next);
    event.currentTarget.src = next;
  };
}
