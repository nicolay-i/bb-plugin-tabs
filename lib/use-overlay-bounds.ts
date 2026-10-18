import { useLayoutEffect, useRef } from "react";

const mainChat = "[data-thread-window]:not(aside [data-thread-window])";
const layoutAttribute = "data-bb-chat-tabs-layout";
const layouts = new WeakMap<
  Document,
  {
    listeners: Set<(main: Element | null) => void>;
    update: () => void;
    observer: MutationObserver;
  }
>();

/** One predicate bridge per document, including anchor-capable browsers and hidden overlays. */
function observeLayout(document: Document, listener: (main: Element | null) => void) {
  let layout = layouts.get(document);
  if (!layout) {
    const body = document.body;
    const listeners = new Set<(main: Element | null) => void>();
    // ponytail: rescan per mutation batch; index predicates only if streaming DOM scans become measurable.
    const update = () => {
      const main = body.querySelector(mainChat);
      const overlays = Array.from(body.querySelectorAll("#bb-chat-tabs-overlay"));
      const states = [
        main && "main",
        body.querySelector(`:scope [inert] ${mainChat}`) && "inert",
        overlays.some((node) => node.getAttribute("data-docked") === "true") && "docked",
        overlays.some((node) => node.getAttribute("data-row-count") === "1") && "row-one",
        overlays.some((node) => node.getAttribute("data-scrollable") === "false") && "no-overflow",
        body.querySelector("[data-split-resize-grid-boundary]") && "split",
        body.querySelector('[data-sidebar-shelf="open"]') && "sidebar-open",
        body.querySelector('[data-panel-shelf="shelf"]') && "panel-shelf",
        body.querySelector('[data-panel-shelf="full"]') && "panel-full",
      ]
        .filter(Boolean)
        .join(" ");
      if (body.getAttribute(layoutAttribute) !== states) body.setAttribute(layoutAttribute, states);
      for (const notify of listeners) notify(main);
    };
    const observer = new MutationObserver(update);
    observer.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "id",
        "data-thread-window",
        "inert",
        "data-docked",
        "data-row-count",
        "data-scrollable",
        "data-split-resize-grid-boundary",
        "data-sidebar-shelf",
        "data-panel-shelf",
        "data-sidebar",
      ],
    });
    layout = { listeners, update, observer };
    layouts.set(document, layout);
  }
  const current = layout;
  current.listeners.add(listener);
  current.update();
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.observer.disconnect();
      document.body.removeAttribute(layoutAttribute);
      layouts.delete(document);
    }
  };
}

/** Safari versions without CSS anchors must follow the content, not the viewport. */
export function useOverlayBounds(enabled: boolean) {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const overlay = ref.current;
    const window = overlay?.ownerDocument.defaultView;
    if (!overlay || !window) return;
    const document = overlay.ownerDocument;
    const fallback = enabled && !window.CSS?.supports?.("left", "anchor(left)");
    let main: Element | null = null;
    let target: Element | null = null;
    let frame: number | null = null;
    const setBound = (name: "left" | "right", value: string) => {
      if (overlay.style[name] !== value) overlay.style[name] = value;
    };
    const update = () => {
      if (!fallback) return;
      const next = main ?? document.querySelector('[data-sidebar="inset"]');
      if (next !== target) {
        resize?.disconnect();
        target = next;
        if (target) resize?.observe(target);
      }
      const rect = target?.getBoundingClientRect();
      const left = rect ? `${Math.max(0, rect.left)}px` : "";
      const right = rect ? `${Math.max(0, window.innerWidth - rect.right)}px` : "";
      setBound("left", left);
      setBound("right", right);
    };
    const schedule = () => {
      if (!fallback || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        update();
      });
    };
    const resize =
      !fallback || typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const unsubscribe = observeLayout(document, (nextMain) => {
      main = nextMain;
      schedule();
    });
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    update();
    if (fallback) window.addEventListener("resize", schedule);
    return () => {
      unsubscribe();
      resize?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
      overlay.style.removeProperty("left");
      overlay.style.removeProperty("right");
    };
  }, [enabled]);
  return ref;
}
