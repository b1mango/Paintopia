import sharp from "sharp";

const THUMBNAIL_MAX_EDGE = 640;

export async function createImageThumbnail(bytes: Buffer, maxEdge = THUMBNAIL_MAX_EDGE): Promise<Buffer> {
  return sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true
    })
    .webp({
      quality: 78,
      effort: 4,
      smartSubsample: true
    })
    .toBuffer();
}
