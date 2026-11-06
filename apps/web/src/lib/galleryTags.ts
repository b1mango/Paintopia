import { useEffect, useState } from "react";
import { GALLERY_TAGS, type GalleryTag } from "@paintopia/shared";
import { apiClient } from "./apiClient";

/** 内置标签立即可用；管理员自建的标签按需拉取一次，全页面共享。 */
let cached: readonly GalleryTag[] = GALLERY_TAGS;
let loading: Promise<void> | null = null;
const listeners = new Set<(tags: readonly GalleryTag[]) => void>();

function publish(tags: readonly GalleryTag[]) {
  cached = tags;
  listeners.forEach(listener => listener(tags));
}

export function useGalleryTags() {
  const [tags, setTags] = useState(cached);
  useEffect(() => {
    listeners.add(setTags);
    setTags(cached);
    loading ??= apiClient.listGalleryTags().then(publish, () => { loading = null; });
    return () => { listeners.delete(setTags); };
  }, []);
  return tags;
}

export async function createGalleryTag(label: string, group: GalleryTag["group"]) {
  const tag = await apiClient.createGalleryTag(label, group);
  if (!cached.some(value => value.id === tag.id)) publish([...cached, tag]);
  return tag;
}

export function resetGalleryTagCache() {
  cached = GALLERY_TAGS;
  loading = null;
}
