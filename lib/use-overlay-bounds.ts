import { useLayoutEffect, useRef } from "react";

/** Safari versions without CSS anchors must follow the content, not the viewport. */
export function useOverlayBounds(enabled: boolean) {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const overlay = ref.current;
    if (!enabled || !overlay || globalThis.CSS?.supports?.("left", "anchor(left)")) return;
    let target: Element | null = null;
    const update = () => {
      const next = document.querySelector('[data-thread-window]:not(aside [data-thread-window])')
        ?? document.querySelector('[data-sidebar="inset"]');
      if (next !== target) {
        resize?.disconnect();
        target = next;
        if (target) resize?.observe(target);
      }
      if (!target) {
        overlay.style.removeProperty("left");
        overlay.style.removeProperty("right");
        return;
      }
      const rect = target.getBoundingClientRect();
      overlay.style.left = `${Math.max(0, rect.left)}px`;
      overlay.style.right = `${Math.max(0, window.innerWidth - rect.right)}px`;
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    // Route/panel changes can replace the element being measured.
    const mutations = new MutationObserver(update);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", update);
      overlay.style.removeProperty("left");
      overlay.style.removeProperty("right");
    };
  }, [enabled]);
  return ref;
}
