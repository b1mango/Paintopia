import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryGallery } from '../src/features/history/HistoryGallery';
import type { GeneratedAsset } from '../src/lib/apiClient';

const asset = (n: number): GeneratedAsset => ({ id: String(n), imageUrl: '/original/' + n, thumbnailUrl: '/thumb/' + n, prompt: '创作 ' + n, params: { model: 'image-model', jobId: 'job-' + n }, createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString() });
const response = (items: GeneratedAsset[], total = items.length, page = 1) => new Response(JSON.stringify({ items, total, page, pageSize: 20 }), { status: 200 });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('HistoryGallery', () => {
  it('reads personal server assets, sorts across jobs, selects the complete asset without generating or persisting it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([asset(1), asset(3), asset(2)]));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(Storage.prototype, 'setItem');
    const onSelect = vi.fn();
    const { container } = render(<HistoryGallery refreshKey={0} onSelect={onSelect} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载');
    const buttons = await screen.findAllByRole('button', { name: /^回填参数/ });
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['回填参数：创作 3', '回填参数：创作 2', '回填参数：创作 1']);
    expect(fetchMock).toHaveBeenCalledWith('/api/assets?scope=mine&page=1&pageSize=20', expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }));
    expect(container.querySelector('img')).toHaveAttribute('src', '/thumb/3?size=320');
    fireEvent.click(buttons[0]!);
    expect(onSelect).toHaveBeenCalledWith(asset(3));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByText('预览暂不可用')).toBeInTheDocument();
  });

  it('loads the next page on intersection, deduplicates and stops at total', async () => {
    let intersect!: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { intersect = callback; } observe = vi.fn(); disconnect = disconnect; });
    const fetchMock = vi.fn().mockResolvedValueOnce(response(Array.from({ length: 20 }, (_, i) => asset(i + 2)), 22))
      .mockResolvedValueOnce(response([asset(2), asset(1)], 22, 2));
    vi.stubGlobal('fetch', fetchMock);
    render(<HistoryGallery refreshKey={0} onSelect={vi.fn()} />);
    await screen.findAllByRole('button', { name: /^回填参数/ });
    await waitFor(() => expect(intersect).toBeTypeOf('function'));
    act(() => { intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); });
    await screen.findByText('已显示全部创作');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/assets?scope=mine&page=2&pageSize=20');
    expect(screen.getAllByRole('button', { name: /^回填参数/ })).toHaveLength(21);
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
    expect(disconnect).toHaveBeenCalled();
  });

  it('keeps the loaded window and scroll position while refreshKey reloads all loaded pages', async () => {
    const pending = deferred<Response>();
    const first = Array.from({ length: 20 }, (_, i) => asset(30 - i));
    const fetchMock = vi.fn().mockResolvedValueOnce(response(first, 21)).mockResolvedValueOnce(response([asset(10)], 21, 2))
      .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response([asset(11), asset(10)], 22, 2));
    vi.stubGlobal('fetch', fetchMock);
    const onSelect = vi.fn();
    const { rerender, unmount } = render(<HistoryGallery refreshKey={0} onSelect={onSelect} />);
    await screen.findByRole('button', { name: '加载更多' });
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByRole('button', { name: '回填参数：创作 10' });
    screen.getByLabelText('最近创作列表').scrollTop = 250;
    rerender(<HistoryGallery refreshKey={1} onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: '回填参数：创作 10' })).toBeInTheDocument();
    await act(async () => { pending.resolve(response([asset(31), ...first.slice(0, 19)], 22)); });
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^回填参数/ })).toHaveLength(22));
    expect(screen.getByLabelText('最近创作列表').scrollTop).toBe(250);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([1, 2, 1, 2].map((page) => '/api/assets?scope=mine&page=' + page + '&pageSize=20'));
    unmount();
    fetchMock.mockResolvedValueOnce(response([asset(31)]));
    render(<HistoryGallery refreshKey={0} onSelect={onSelect} />);
    expect(await screen.findByRole('button', { name: '回填参数：创作 31' })).toBeInTheDocument();
  });

  it('retries a failed next page without discarding loaded assets', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response([asset(2)], 21)).mockRejectedValueOnce(new Error('网络断开')).mockResolvedValueOnce(response([asset(1)], 21, 2));
    vi.stubGlobal('fetch', fetchMock);
    render(<HistoryGallery refreshKey={0} onSelect={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络断开');
    expect(screen.getByRole('button', { name: '回填参数：创作 2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('button', { name: '回填参数：创作 1' });
    expect(fetchMock.mock.calls[2]![0]).toContain('page=2');
  });

  it('aborts stale refreshes and ignores late responses', async () => {
    const old = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response([asset(2)]));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender, unmount } = render(<HistoryGallery refreshKey={0} onSelect={vi.fn()} />);
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    rerender(<HistoryGallery refreshKey={1} onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: '回填参数：创作 2' });
    expect(signal.aborted).toBe(true);
    await act(async () => { old.resolve(response([asset(1)])); });
    expect(screen.queryByRole('button', { name: '回填参数：创作 1' })).not.toBeInTheDocument();
    unmount();
    expect(fetchMock.mock.calls[1]![1].signal.aborted).toBe(true);
  });

  it.each(['legacy', 'unauthorized', 'empty'])('renders honest %s state', async (state) => {
    const result = state === 'legacy' ? new Response(JSON.stringify([asset(1)])) : state === 'unauthorized' ? new Response(JSON.stringify({ error: '请重新登录' }), { status: 401 }) : response([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result));
    render(<HistoryGallery refreshKey={0} onSelect={vi.fn()} />);
    if (state === 'empty') expect(await screen.findByText('还没有创作，完成的图片会保留在这里。')).toBeInTheDocument();
    else expect(await screen.findByRole('alert')).toHaveTextContent(state === 'legacy' ? '分页响应不符合约定' : '请重新登录');
  });
});
