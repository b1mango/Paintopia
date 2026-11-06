import { expect, it, vi } from 'vitest';
import { mapUploads, putUpload } from '../src/lib/uploadQueue';

it('bounds concurrency to two and preserves input order despite completion order', async () => {
  let active = 0, peak = 0;
  const result = await mapUploads([0, 1, 2, 3], async value => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, value === 0 ? 20 : 1));
    active--;
    return value * 2;
  });
  expect(peak).toBe(2);
  expect(result).toEqual([0, 2, 4, 6]);
});

it('stops scheduling after failure and waits for already-started uploads', async () => {
  const started: number[] = [];
  let finished = false;
  await expect(mapUploads([0, 1, 2, 3], async value => {
    started.push(value);
    if (!value) throw new Error('failed');
    await new Promise(resolve => setTimeout(resolve, 5));
    finished = true;
  })).rejects.toThrow('failed');
  expect(started).toEqual([0, 1]);
  expect(finished).toBe(true);
});

it('retries network and transient PUT failures with the same body, capped at three attempts', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response(null, {status:503})).mockResolvedValue(new Response(null, {status:204}));
  const init = {method:'PUT', body:'file'};
  const sleep = vi.fn(async () => {});
  expect((await putUpload('/upload', init, fetcher, sleep)).status).toBe(204);
  expect(fetcher.mock.calls).toEqual(Array.from({length:3}, () => ['/upload', init]));
  expect(sleep.mock.calls.flat()).toEqual([500,1000]);
  fetcher.mockReset().mockResolvedValue(new Response(null, {status:503}));
  expect((await putUpload('/upload', init, fetcher, sleep)).status).toBe(503);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('does not retry authentication or validation errors', async () => {
  const fetcher = vi.fn(async () => new Response(null, {status:403}));
  const sleep = vi.fn(async () => {});
  expect((await putUpload('/upload', {method:'PUT'}, fetcher, sleep)).status).toBe(403);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});
