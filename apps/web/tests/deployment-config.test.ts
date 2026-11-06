import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const productionR2Origin = "https://paintopia-assets.61b93e66612871bc76330dd843bc592c.r2.cloudflarestorage.com";

describe("web deployment configuration", () => {
  it("allows direct uploads only to the production R2 endpoint", async () => {
    const config = JSON.parse(await readFile(path.resolve(process.cwd(), "vercel.json"), "utf8")) as {
      headers: Array<{
        headers: Array<{ key: string; value: string }>;
      }>;
    };
    const contentSecurityPolicy = config.headers
      .flatMap((entry) => entry.headers)
      .find((header) => header.key === "Content-Security-Policy")?.value;

    expect(contentSecurityPolicy).toContain(`connect-src 'self' ${productionR2Origin}`);
    expect(contentSecurityPolicy).not.toContain("https://*.r2.cloudflarestorage.com");
  });
});
