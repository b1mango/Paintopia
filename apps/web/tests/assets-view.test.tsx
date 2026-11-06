import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssetsView } from '../src/app/AssetsView';
import { apiClient, type GeneratedAsset, type GalleryItem } from '../src/lib/apiClient';
import { clearMediaCache } from '../src/lib/useMediaFeed';
import { promptLibraryApi } from '../src/features/prompts/promptLibraryApi';

const asset = (id: string): GeneratedAsset => ({ id, imageUrl: '/' + id, prompt: '作品 ' + id, createdAt: '2026-10-23T00:00:00Z', expiresAt: null });
const gallery = (id: string): GalleryItem => ({ id: 'gallery-' + id, assetId: id, userId: 'u', imageUrl: '/' + id, title: id, prompt: id, status: 'pending', tags: [], createdAt: '2026-10-23T00:00:00Z' });
afterEach(() => { vi.restoreAllMocks(); clearMediaCache(); });
const card = (id: string) => within(screen.getByText('作品 ' + id).closest('article')!);

it('isolates pending, success and failure across concurrent card submissions and reloads', async () => {
  const rows = [asset('a'), asset('b'), asset('c')];
  vi.spyOn(apiClient, 'listMediaFeed').mockImplementation(async () => ({ items: rows, nextCursor: null }));
  let resolveA!: (value: GalleryItem) => void;
  let rejectB!: (reason: Error) => void;
  const share = vi.spyOn(apiClient, 'syncAssetToGallery').mockImplementation(id => id === 'a'
    ? new Promise(resolve => { resolveA = resolve; })
    : new Promise((_resolve, reject) => { rejectB = reject; }));
  const view = render(<AssetsView account="owner" refreshKey={0} showOwner={false} />);
  await screen.findByText('作品 a');
  fireEvent.click(card('a').getByRole('button', { name: '同步到画廊' }));
  expect(card('a').getByRole('button', { name: '同步到画廊' })).toBeDisabled();
  expect(card('b').getByRole('button', { name: '同步到画廊' })).toBeEnabled();
  fireEvent.click(card('b').getByRole('button', { name: '同步到画廊' }));
  rows[0] = { ...rows[0]!, gallerySynced: true, galleryItemId: 'gallery-a', galleryStatus: 'pending' };
  await act(async () => resolveA(gallery('a')));
  expect(card('a').getByText('待审核')).toBeInTheDocument();
  expect(card('b').getByRole('button', { name: '同步到画廊' })).toBeDisabled();
  expect(card('c').getByRole('button', { name: '同步到画廊' })).toBeEnabled();
  await act(async () => rejectB(new Error('提交失败，请重试')));
  expect(card('b').getByRole('alert')).toHaveTextContent('提交失败');
  expect(card('a').queryByRole('alert')).not.toBeInTheDocument();
  expect(card('c').queryByText('待审核')).not.toBeInTheDocument();
  expect(share).toHaveBeenCalledTimes(2);
  view.unmount();
  render(<AssetsView account="owner" refreshKey={0} showOwner={false} />);
  await waitFor(() => expect(card('a').getByText('待审核')).toBeInTheDocument());
  expect(card('b').getByRole('button', { name: '同步到画廊' })).toBeEnabled();
});

it('withdraws only the selected card and displays server retention', async () => {
  vi.spyOn(apiClient, 'listMediaFeed').mockResolvedValue({ items: [
    { ...asset('a'), gallerySynced: true, galleryItemId: 'ga', galleryStatus: 'pending', expiresAt: '2026-10-30T00:00:00Z' },
    { ...asset('b'), gallerySynced: true, galleryItemId: 'gb', galleryStatus: 'approved' }
  ], nextCursor: null });
  const withdraw = vi.spyOn(apiClient, 'unsyncAssetFromGallery').mockResolvedValue({ expiresAt: '2026-10-30T00:00:00Z' });
  render(<AssetsView account="member" refreshKey={0} showOwner={false} />);
  await screen.findByText('作品 a');
  expect(card('a').getByText('2026-10-30 到期')).toBeInTheDocument();
  expect(card('b').getByText('永久保留')).toBeInTheDocument();
  fireEvent.click(card('a').getByRole('button', { name: '取消同步到画廊' }));
  await waitFor(() => expect(card('a').getByText('仅自己可见')).toBeInTheDocument());
  expect(card('b').getByText('已发布')).toBeInTheDocument();
  expect(withdraw).toHaveBeenCalledExactlyOnceWith('a');
});

it('lets admins curate an asset once and hides the action from regular users', async () => {
  vi.spyOn(apiClient, 'listMediaFeed').mockResolvedValue({ items: [
    { ...asset('a'), curatedPromptId: null },
    { ...asset('b'), curatedPromptId: 'c-b' },
    { ...asset('c'), curatedPromptId: null }
  ], nextCursor: null });
  const curate = vi.spyOn(promptLibraryApi, 'curate').mockImplementation(async id => {
    if (id === 'c') throw new Error('这张图已在站主推荐中');
    return { id: 'c-' + id } as Awaited<ReturnType<typeof promptLibraryApi.curate>>;
  });
  const view = render(<AssetsView account="admin" refreshKey={0} showOwner={false} canCurate />);
  await screen.findByText('作品 a');
  expect(card('b').getByRole('button', { name: '已在站主推荐' })).toBeDisabled();
  fireEvent.click(card('a').getByRole('button', { name: '加入站主推荐' }));
  expect(await card('a').findByRole('button', { name: '已在站主推荐' })).toBeDisabled();
  expect(curate).toHaveBeenCalledExactlyOnceWith('a');
  fireEvent.click(card('c').getByRole('button', { name: '加入站主推荐' }));
  expect(await card('c').findByRole('alert')).toHaveTextContent('这张图已在站主推荐中');
  expect(card('c').getByRole('button', { name: '加入站主推荐' })).toBeEnabled();
  view.unmount();
  render(<AssetsView account="member" refreshKey={0} showOwner={false} />);
  await screen.findByText('作品 a');
  expect(screen.queryByRole('button', { name: /站主推荐/ })).not.toBeInTheDocument();
});
