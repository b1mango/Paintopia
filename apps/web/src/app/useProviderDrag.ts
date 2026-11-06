import { useEffect, useRef, type PointerEvent } from "react";

/** Pointer sorting keeps the grabbed card under the pointer and animates its neighbors. */
export function useProviderDrag(onDrop: (from: string, to: string, after: boolean) => void) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    const row = event.currentTarget.closest<HTMLElement>('[data-provider-id]');
    if (!row?.parentElement) return;
    event.preventDefault();
    cleanup.current?.();
    const rows = Array.from(row.parentElement.querySelectorAll<HTMLElement>('[data-provider-id]'));
    const rects = rows.map(node => node.getBoundingClientRect());
    const original = rows.indexOf(row);
    const start = event.clientY;
    let destination = original;
    const gap = rows.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 8;
    row.dataset.lifted = 'true';
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      const delta = e.clientY - start;
      const center = rects[original].top + rects[original].height / 2 + delta;
      destination = rows.filter((_, index) => index !== original && center > rects[index].top + rects[index].height / 2).length;
      rows.forEach((node, index) => {
        const shift = index === original ? delta : original < destination && index > original && index <= destination ? -(rects[original].height + gap) : original > destination && index >= destination && index < original ? rects[original].height + gap : 0;
        node.style.transform = `translateY(${shift}px)`;
      });
    };
    const clear = () => {
      rows.forEach(node => { node.style.transform = ''; delete node.dataset.lifted; });
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key);
      cleanup.current = null;
    };
    const finish = (e: globalThis.PointerEvent) => { if (e.pointerId !== event.pointerId) return; const target = rows[destination]?.dataset.providerId; clear(); if (target && destination !== original) onDrop(id, target, destination > original); };
    const cancel = () => clear();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') clear(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key);
    cleanup.current = clear;
  };
}
