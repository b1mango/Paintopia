import {createHmac} from "node:crypto";

/** Expiry snaps to a 2-minute grid so an object keeps one signed URL for a while and browsers can reuse the bytes.
 * Always 120–240s ahead (the worker accepts up to 300s). Returns seconds. */
export const mediaEdgeExpiry = (now = Date.now()) => (Math.floor(now / 120_000) + 2) * 120;
/** Client-side deadline for switching to the API fallback, with a safety margin. */
export const mediaEdgeClientExpiry = (now = Date.now()) => mediaEdgeExpiry(now) * 1000 - 10_000;

/** Same-origin path (no trailing slash: Vercel would not match the rewrite) the web deployment proxies to PAINTOPIA_MEDIA_EDGE_URL (apps/web/vercel.json).
 * Browsers only talk to the site's own domain: the Cloudflare media domain is slow or unreachable from
 * some networks, which left images hanging and then broken. */
export const MEDIA_EDGE_PUBLIC_PATH = "/edge";

/** Optional private R2 edge delivery. Credentials never appear in the response. */
export function createMediaEdgeUrl(key: string, now = Date.now(), downloadFileName?: string): string | null {
  const origin = process.env.PAINTOPIA_MEDIA_EDGE_URL;
  const secret = process.env.PAINTOPIA_MEDIA_SIGNING_KEY;
  if (!origin || !secret || !/^(?:thumbnails\/[\w-]+\.webp|(?:temporary|pending|permanent)\/[\w-]+\/[\w-]+\.(?:png|jpe?g|webp)|gallery\/[\w-]+\.(?:png|jpe?g|webp))$/.test(key)) return null;
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new Error("Media edge URL must use HTTPS");
  const expires = String(mediaEdgeExpiry(now));
  const download = downloadFileName?.replace(/[^A-Za-z0-9._-]/g,"_").slice(0,150);
  const signature = createHmac("sha256", secret).update(`${key}\n${expires}${download ? `\n${download}` : ""}`).digest("hex");
  const params = new URLSearchParams({key, expires, signature});
  if(download)params.set("download",download);
  return `${MEDIA_EDGE_PUBLIC_PATH}?${params}`;
}
