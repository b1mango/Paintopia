import { expect, it, vi } from "vitest";
import { FREESTYLEFLY_SOURCE, ZEROLU_SOURCE, parsePromptSource, createPromptSourceService } from "../src/services/promptSources.js";

it.each([FREESTYLEFLY_SOURCE, ZEROLU_SOURCE])("parses $id with source-specific ids and model validation", async source => {
  const row = { id: source.id + ":test", sourceId: source.id, title: "Title", prompt: "Exact prompt", imageModel: source.model, sourceUrl: "https://mp.weixin.qq.com/s/example", coverUrl: "https://raw.githubusercontent.com/owner/repo/main/data/image.jpg" };
  const items = parsePromptSource([row, row, { ...row, id: "unknown:test" }, { ...row, sourceId: "unknown" }, { ...row, id: source.id + ":bad-model", imageModel: "unknown" }], source);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: row.id, text: row.prompt, sourceId: source.id, sourceUrl: row.sourceUrl, coverUrl: "https://cdn.jsdelivr.net/gh/owner/repo@main/data/image.jpg" });
  const fetcher = vi.fn(async () => new Response(JSON.stringify([row])));
  expect((await createPromptSourceService(fetcher, Date.now, source.id).list()).items).toEqual(items);
  expect(fetcher).toHaveBeenCalledWith(source.feedUrl, expect.objectContaining({ redirect: "error" }));
});
it("accepts only approved image hosts and GitHub attachment paths", () => {
  const row = { id: ZEROLU_SOURCE.id + ":test", title: "Title", prompt: "Text", imageModel: "gpt-image-2", sourceUrl: "https://opennana.com/prompt/1" };
  for (const cover of ["https://github.com/user-attachments/assets/abc-123", "https://pbs.twimg.com/media/abc.jpg", "https://cms-assets.youmind.com/abc.jpg"]) {
    expect(parsePromptSource([{ ...row, coverUrl: cover }], ZEROLU_SOURCE)[0].coverUrl).toBe(cover);
  }
  for (const cover of ["https://github.com/owner/repo/image.png", "https://github.com/user-attachments/assets/../private", "http://pbs.twimg.com/abc", "https://user:pass@pbs.twimg.com/abc", "https://pbs.twimg.com:8443/abc", "https://raw.githubusercontent.com/short", "https://evil.test/image.png"]) {
    expect(parsePromptSource([{ ...row, coverUrl: cover }], ZEROLU_SOURCE)[0].coverUrl).toBeUndefined();
  }
});
