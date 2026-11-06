/** Preserve reference order while limiting simultaneous large uploads. */
export async function mapUploads<T, R>(items: T[], upload: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await upload(items[index]); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  }));
  if (failed) throw failure;
  return results;
}

/** Retry only the idempotent object PUT; never repeat intent creation or generation. */
export async function putUpload(url: string, init: RequestInit, fetcher = fetch,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetcher(url, init);
      if (attempt >= 2 || (response.status !== 429 && response.status < 500)) return response;
      const retryAfter = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      await sleep(Math.min(5000, Math.max(500 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
    } catch (error) {
      if (attempt >= 2 || !(error instanceof TypeError)) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
}
