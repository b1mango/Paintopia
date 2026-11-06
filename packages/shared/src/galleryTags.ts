export type GalleryTagGroup = "subject" | "scene" | "style";

export type GalleryTag = {
  id: string;
  label: string;
  aliases: readonly string[];
  group: GalleryTagGroup;
};

export const MAX_GALLERY_TAGS = 8;

export const GALLERY_TAG_GROUPS: readonly { id: GalleryTagGroup; label: string }[] = [
  { id: "subject", label: "主题" },
  { id: "scene", label: "场景" },
  { id: "style", label: "风格" }
];

// Stable IDs are persisted on gallery items. Labels and aliases are display/search vocabulary.
export const GALLERY_TAGS: readonly GalleryTag[] = [
  { id: "portrait", label: "人像", aliases: ["portrait", "people", "人物"], group: "subject" },
  { id: "animal", label: "动物", aliases: ["animal", "pet", "宠物"], group: "subject" },
  { id: "plant", label: "植物", aliases: ["plant", "flower", "花卉"], group: "subject" },
  { id: "architecture", label: "建筑", aliases: ["architecture", "building"], group: "subject" },
  { id: "object", label: "静物", aliases: ["still life", "object", "物品"], group: "subject" },
  { id: "food", label: "美食", aliases: ["food", "饮食"], group: "subject" },
  { id: "vehicle", label: "交通工具", aliases: ["vehicle", "car", "汽车"], group: "subject" },
  { id: "city", label: "城市", aliases: ["city", "urban", "street", "街景"], group: "scene" },
  { id: "nature", label: "自然风光", aliases: ["nature", "landscape", "山水", "风景"], group: "scene" },
  { id: "interior", label: "室内", aliases: ["interior", "room", "家居"], group: "scene" },
  { id: "seascape", label: "海洋", aliases: ["seascape", "ocean", "sea", "海景"], group: "scene" },
  { id: "space", label: "太空", aliases: ["space", "cosmos", "宇宙"], group: "scene" },
  { id: "fantasy", label: "幻想世界", aliases: ["fantasy", "奇幻"], group: "scene" },
  { id: "photography", label: "摄影", aliases: ["photography", "photo", "写实"], group: "style" },
  { id: "illustration", label: "插画", aliases: ["illustration"], group: "style" },
  { id: "anime", label: "动漫", aliases: ["anime", "manga", "二次元"], group: "style" },
  { id: "3d-render", label: "3D 渲染", aliases: ["3d render", "三维"], group: "style" },
  { id: "pixel-art", label: "像素艺术", aliases: ["pixel art", "像素"], group: "style" },
  { id: "watercolor", label: "水彩", aliases: ["watercolor", "watercolour"], group: "style" },
  { id: "oil-painting", label: "油画", aliases: ["oil painting"], group: "style" },
  { id: "ink-painting", label: "水墨", aliases: ["ink painting", "国画"], group: "style" },
  { id: "minimalism", label: "极简", aliases: ["minimalism", "minimalist"], group: "style" },
  { id: "cyberpunk", label: "赛博朋克", aliases: ["cyberpunk"], group: "style" },
  { id: "dreamcore", label: "梦核", aliases: ["dreamcore", "liminal", "surreal", "超现实"], group: "style" }
];
