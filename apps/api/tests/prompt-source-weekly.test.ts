import { expect, it, vi } from "vitest";
import { createPromptSourceService, PROMPT_SOURCE_UPDATE_INTERVAL_MS } from "../src/services/promptSources.js";
it("reuses source content for seven days and refreshes once at expiry", async () => {
  let now = 0;
  const fetcher = vi.fn(async () => new Response("[]", {status:200}));
  const service = createPromptSourceService(fetcher as typeof fetch, () => now);
  await service.list();
  now = PROMPT_SOURCE_UPDATE_INTERVAL_MS - 1;
  await service.list();
  expect(fetcher).toHaveBeenCalledTimes(1);
  now++;
  await Promise.all([service.list(), service.list()]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
