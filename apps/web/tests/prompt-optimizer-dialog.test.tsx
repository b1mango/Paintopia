import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptOptimizerDialog } from '../src/features/promptTools/PromptOptimizerDialog';
import { apiClient, type PromptToolResponse } from '../src/lib/apiClient';

vi.mock('../src/lib/apiClient', () => ({ apiClient: { optimize: vi.fn(), listOptimizeTemplates: vi.fn() } }));
const optimize = vi.mocked(apiClient.optimize);
const listTemplates = vi.mocked(apiClient.listOptimizeTemplates);
const result: PromptToolResponse = { text: '晨光中的山谷', providerConfigured: true, systemPrompt: '' };
const props = () => ({ initialPrompt: '山谷', targetModel: 'exact-image-model', onApply: vi.fn(), onClose: vi.fn() });
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); }) });
  optimize.mockReset();
  listTemplates.mockReset().mockResolvedValue([]);
});
afterEach(() => { cleanup();
  vi.restoreAllMocks();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

describe('PromptOptimizerDialog', () => {
  it('sends the chosen output language and remembers it for next time', async () => {
    localStorage.removeItem('paintopia-optimize-language');
    optimize.mockResolvedValue({ ...result, text: 'A valley at dawn' });
    const first = render(<PromptOptimizerDialog {...props()} />);
    expect(screen.getByRole('radiogroup', { name: '输出语言' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '中文' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect(screen.getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'true');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始优化' })); });
    expect(optimize).toHaveBeenCalledWith({ inputPrompt: '山谷', targetModel: 'exact-image-model', outputLanguage: 'en' });
    first.unmount();
    render(<PromptOptimizerDialog {...props()} />);
    expect(screen.getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'true');
    localStorage.removeItem('paintopia-optimize-language');
  });
  it('lists template names only, sends the chosen template and remembers it', async () => {
    localStorage.removeItem('paintopia-optimize-template');
    listTemplates.mockResolvedValue([{ id: 'optimize', name: '通用优化', isDefault: true }, { id: 'portrait', name: '真实人像', isDefault: false }]);
    optimize.mockResolvedValue(result);
    const first = render(<PromptOptimizerDialog {...props()} />);
    expect(screen.queryByText('目标图像模型')).not.toBeInTheDocument();
    const group = await screen.findByRole('radiogroup', { name: '优化模板' });
    expect(group).toHaveTextContent('通用优化真实人像');
    expect(screen.getByRole('radio', { name: '通用优化' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: '真实人像' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始优化' })); });
    expect(optimize).toHaveBeenCalledWith({ inputPrompt: '山谷', targetModel: 'exact-image-model', outputLanguage: 'zh', templateId: 'portrait' });
    first.unmount();
    render(<PromptOptimizerDialog {...props()} />);
    expect(await screen.findByRole('radio', { name: '真实人像' })).toHaveAttribute('aria-checked', 'true');
    localStorage.removeItem('paintopia-optimize-template');
  });
  it('opens a native modal with editable original, then copies/applies only edited real output', async () => {
    const callbacks = props();
    optimize.mockResolvedValue(result);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<PromptOptimizerDialog {...callbacks} />);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog', { name: '优化提示词' })).toHaveAttribute('open');
    expect(screen.getByLabelText('原始提示词')).toHaveFocus();
    expect(optimize).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '应用到提示词' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('原始提示词'), { target: { value: '  山谷与飞鸟  ' } });
    fireEvent.click(screen.getByRole('button', { name: '开始优化' }));
    expect(optimize).toHaveBeenCalledWith({ inputPrompt: '山谷与飞鸟', targetModel: 'exact-image-model', outputLanguage: 'zh' });
    expect(await screen.findByLabelText('优化结果')).toHaveValue(result.text);
    fireEvent.change(screen.getByLabelText('优化结果'), { target: { value: '自己修改后的结果' } });
    fireEvent.click(screen.getByRole('button', { name: '复制结果' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已复制');
    expect(writeText).toHaveBeenCalledWith('自己修改后的结果');
    fireEvent.click(screen.getByRole('button', { name: '应用到提示词' }));
    expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith('自己修改后的结果');
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it.each(['取消', '关闭优化提示词', 'escape'])('closes via %s without applying and restores focus on unmount', (action) => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const callbacks = props();
    const { unmount } = render(<PromptOptimizerDialog {...callbacks} />);
    fireEvent.change(screen.getByLabelText('原始提示词'), { target: { value: '未应用的改动' } });
    if (action === 'escape') fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
    else fireEvent.click(screen.getByRole('button', { name: action }));
    expect(callbacks.onClose).toHaveBeenCalledOnce();
    expect(callbacks.onApply).not.toHaveBeenCalled();
    unmount(); expect(trigger).toHaveFocus(); trigger.remove();
  });

  it('blocks duplicate submits and ignores results after closing', async () => {
    let resolve!: (value: PromptToolResponse) => void;
    optimize.mockReturnValue(new Promise((done) => { resolve = done; }));
    const callbacks = props();
    render(<PromptOptimizerDialog {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: '开始优化' }));
    expect(screen.getByRole('status')).toHaveTextContent('正在等待文本模型');
    fireEvent.click(screen.getByRole('button', { name: '正在优化…' }));
    expect(optimize).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await act(async () => resolve(result));
    expect(screen.queryByLabelText('优化结果')).not.toBeInTheDocument();
    expect(callbacks.onApply).not.toHaveBeenCalled();
  });

  it.each(['unconfigured', 'empty', 'network'])('rejects %s output with retry and no fake result', async (kind) => {
    if (kind === 'network') optimize.mockRejectedValueOnce(new Error('网络错误'));
    else optimize.mockResolvedValueOnce({ ...result, providerConfigured: kind !== 'unconfigured', text: kind === 'empty' ? ' ' : '伪预览' });
    render(<PromptOptimizerDialog {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始优化' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(kind === 'unconfigured' ? '尚未配置' : kind === 'empty' ? '未返回优化内容' : '网络错误');
    expect(screen.queryByLabelText('优化结果')).not.toBeInTheDocument();
    expect(screen.queryByText('伪预览')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '应用到提示词' })).toBeDisabled();
    optimize.mockResolvedValueOnce(result);
    fireEvent.click(screen.getByRole('button', { name: '开始优化' }));
    expect(await screen.findByLabelText('优化结果')).toHaveValue(result.text);
  });

  it.each(['unavailable', 'rejected'])('shows clipboard %s feedback', async (kind) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: kind === 'unavailable' ? undefined : { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    optimize.mockResolvedValue(result);
    render(<PromptOptimizerDialog {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始优化' }));
    await screen.findByLabelText('优化结果');
    fireEvent.click(screen.getByRole('button', { name: '复制结果' }));
    expect(await screen.findByRole('status')).toHaveTextContent('请手动选择文本复制');
  });

  it('invalidates old-model responses and results when the original changes', async () => {
    let resolve!: (value: PromptToolResponse) => void;
    optimize.mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValueOnce(result);
    const callbacks = props();
    const { rerender } = render(<PromptOptimizerDialog {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: '开始优化' }));
    rerender(<PromptOptimizerDialog {...callbacks} targetModel="new-model" />);
    await act(async () => resolve(result));
    expect(screen.queryByLabelText('优化结果')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '开始优化' }));
    await screen.findByLabelText('优化结果');
    fireEvent.change(screen.getByLabelText('原始提示词'), { target: { value: '新的原文' } });
    expect(screen.queryByLabelText('优化结果')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '应用到提示词' })).toBeDisabled();
  });

  it('does not request with blank input', () => {
    render(<PromptOptimizerDialog {...props()} initialPrompt=" " />);
    expect(screen.getByRole('button', { name: '开始优化' })).toBeDisabled();
    expect(optimize).not.toHaveBeenCalled();
  });
});
