import { expect, it } from "vitest";
import { feedThumbnail, feedThumbnailFallback } from "../src/lib/thumbnail";

const item = (id: string, edge: string | null, expiresIn: number) => ({
  id, imageUrl: `/api/assets/${id}/original`, thumbnailUrl: `/api/assets/${id}/thumbnail`,
  thumbnailEdgeUrl: edge, thumbnailEdgeExpiresAt: Date.now() + expiresIn
});

it("keeps the first valid edge URL when a refreshed list re-signs it, so images are not downloaded twice", () => {
  expect(feedThumbnail(item("a", "https://media/a?sig=1", 60_000))).toBe("https://media/a?sig=1");
  expect(feedThumbnail(item("a", "https://media/a?sig=2", 60_000))).toBe("https://media/a?sig=1");
  expect(feedThumbnail(item("a", "https://media/a?sig=1", -1))).toBe("https://media/a?sig=1");
});

it("uses the API thumbnail for expired edge URLs without pinning it, then adopts a fresh edge URL", () => {
  expect(feedThumbnail(item("b", "https://media/b?old", -1))).toBe("/api/assets/b/thumbnail");
  expect(feedThumbnail(item("b", "https://media/b?new", 60_000))).toBe("https://media/b?new");
});

it("remembers the API fallback after an edge failure", () => {
  const failing = item("c", "https://media/c?sig", 60_000);
  const img = document.createElement("img");
  img.setAttribute("src", feedThumbnail(failing));
  feedThumbnailFallback(failing)({ currentTarget: img } as never);
  expect(img.getAttribute("src")).toBe("/api/assets/c/thumbnail");
  expect(feedThumbnail(item("c", "https://media/c?sig2", 60_000))).toBe("/api/assets/c/thumbnail");
});

it("falls back to the original image when the API thumbnail also fails, then stops", () => {
  const failing = item("d", "https://media/d?sig", 60_000);
  const img = document.createElement("img");
  img.setAttribute("src", feedThumbnail(failing));
  const onError = feedThumbnailFallback(failing);
  onError({ currentTarget: img } as never);
  onError({ currentTarget: img } as never);
  expect(img.getAttribute("src")).toBe("/api/assets/d/original");
  onError({ currentTarget: img } as never);
  expect(img.getAttribute("src")).toBe("/api/assets/d/original");
  expect(feedThumbnail(failing)).toBe("/api/assets/d/original");
});
