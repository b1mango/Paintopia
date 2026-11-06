import { useEffect, useRef } from "react";

/** Moves focus into a modal on mount, traps Tab inside it and restores focus on unmount. */
export function useModalFocus<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    const focusables = () => Array.from(root?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, summary, [tabindex="0"]') ?? []);
    (root?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = focusables();
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    root?.addEventListener("keydown", trap);
    return () => { root?.removeEventListener("keydown", trap); previous?.focus({ preventScroll: true }); };
  }, []);
  return ref;
}
