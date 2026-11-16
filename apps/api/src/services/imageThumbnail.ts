import sharp from "sharp";

const THUMBNAIL_MAX_EDGE = 640;
const DISPLAY_MAX_EDGE = 2560;

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

export async function createImageDisplay(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({
      width: DISPLAY_MAX_EDGE,
      height: DISPLAY_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true
    })
    .webp({
      quality: 86,
      effort: 4,
      smartSubsample: true
    })
    .toBuffer();
}
