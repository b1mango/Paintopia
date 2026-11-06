import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptApplyDialog } from './PromptApplyDialog';

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
const props = () => ({ currentPrompt: '原来的山谷', incomingPrompt: '晨光与飞鸟', onApply: vi.fn(), onClose: vi.fn() });

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); }) });
});
afterEach(() => {
  cleanup();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

describe('PromptApplyDialog', () => {
  it('opens a native modal with read-only previews and safe initial focus', () => {
    const callbacks = props();
    render(<PromptApplyDialog {...callbacks} />);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog', { name: '使用所选提示词' })).toHaveAttribute('open');
    expect(screen.getByLabelText('当前提示词')).toHaveValue(callbacks.currentPrompt);
    expect(screen.getByLabelText('所选提示词')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    expect(callbacks.onApply).not.toHaveBeenCalled();
  });

  it('replaces with exact selected text and closes only once', () => {
    const callbacks = { ...props(), incomingPrompt: '  晨光与飞鸟  ' };
    render(<PromptApplyDialog {...callbacks} />);
    const element = screen.getByRole('dialog');
    const button = screen.getByRole('button', { name: '替换当前内容' });
    fireEvent.click(button); fireEvent.click(button); fireEvent(element, new Event('close'));
    expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith(callbacks.incomingPrompt);
    expect(callbacks.onClose).toHaveBeenCalledOnce();
    expect(callbacks.onApply.mock.invocationCallOrder[0]).toBeLessThan(callbacks.onClose.mock.invocationCallOrder[0]!);
  });

  it.each([
    ['原文', '选文', '原文\n\n选文'],
    ['  原文\n\n', '\n选文  ', '  原文\n\n选文  '],
    ['  ', '选文', '选文']
  ])('appends %j and %j with one blank line', (currentPrompt, incomingPrompt, expected) => {
    const callbacks = props();
    render(<PromptApplyDialog {...callbacks} currentPrompt={currentPrompt} incomingPrompt={incomingPrompt} />);
    fireEvent.click(screen.getByRole('button', { name: '追加到末尾' }));
    expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith(expected);
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'escape', 'native-close'])('closes via %s without applying and returns focus', (mode) => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const callbacks = props();
    const { unmount } = render(<PromptApplyDialog {...callbacks} />);
    if (mode === 'cancel') fireEvent.click(screen.getByRole('button', { name: '取消' }));
    else {
      const element = screen.getByRole('dialog');
      if (mode === 'native-close') element.removeAttribute('open');
      fireEvent(element, new Event(mode === 'escape' ? 'cancel' : 'close', { cancelable: true }));
    }
    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(callbacks.onClose).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
    unmount(); trigger.remove();
  });

  it('blocks empty selections and uses the latest props', () => {
    const callbacks = props();
    const { rerender } = render(<PromptApplyDialog {...callbacks} incomingPrompt=" " />);
    expect(screen.getByRole('button', { name: '替换当前内容' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '追加到末尾' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('所选提示词为空');
    rerender(<PromptApplyDialog {...callbacks} currentPrompt="最新原文" incomingPrompt="最新选文" />);
    fireEvent.click(screen.getByRole('button', { name: '追加到末尾' }));
    expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith('最新原文\n\n最新选文');
  });

  it('survives StrictMode without notifying callbacks during cleanup', () => {
    const callbacks = props();
    const { unmount } = render(<StrictMode><PromptApplyDialog {...callbacks} /></StrictMode>);
    expect(screen.getByRole('dialog')).toHaveAttribute('open');
    // Native close events may arrive after StrictMode reopens the dialog.
    fireEvent(screen.getByRole('dialog'), new Event('close'));
    expect(callbacks.onClose).not.toHaveBeenCalled();
    unmount();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(callbacks.onApply).not.toHaveBeenCalled();
  });
});
