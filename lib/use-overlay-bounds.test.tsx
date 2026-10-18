// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOverlayBounds } from "./use-overlay-bounds";

function Overlay({ enabled = true }: { enabled?: boolean }) {
  return (
    <aside
      id="bb-chat-tabs-overlay"
      data-testid="overlay"
      data-docked={String(enabled)}
      data-row-count="1"
      data-scrollable="false"
      ref={useOverlayBounds(enabled)}
    />
  );
}
function layout() {
  return document.body.getAttribute("data-bb-chat-tabs-layout")?.split(" ") ?? [];
}
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.removeAttribute("inert");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function content(left: number, right: number, attribute = "data-sidebar") {
  const element = document.createElement("div");
  element.setAttribute(attribute, attribute === "data-sidebar" ? "inset" : "");
  const bounds = vi.fn(() => ({ left, right }) as DOMRect);
  element.getBoundingClientRect = bounds;
  document.body.append(element);
  return { element, bounds };
}

describe("Shared overlay layout", () => {
  it.each([true, false])(
    "tracks any matching overlay with anchors=%s, not only the first id",
    async (anchors) => {
      vi.stubGlobal("CSS", { supports: () => anchors });
      const first = render(<Overlay enabled={false} />);
      const second = render(<Overlay />);
      expect(layout()).toEqual(["docked", "row-one", "no-overflow"]);
      await act(async () => {
        second.container.firstElementChild!.setAttribute("data-scrollable", "true");
        first.container.firstElementChild!.setAttribute("data-row-count", "2");
      });
      expect(layout()).toContain("no-overflow");
      second.unmount();
      await act(async () => {});
      expect(layout()).toEqual(["no-overflow"]);
      first.unmount();
      expect(document.body.hasAttribute("data-bb-chat-tabs-layout")).toBe(false);
    },
  );

  it("follows main/aside, inert, split and shelf attribute changes without reading layout", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const container = document.createElement("div");
    const main = content(280, 800, "data-thread-window");
    container.append(main.element);
    document.body.append(container);
    const view = render(<Overlay />);
    expect(layout()).toContain("main");
    await act(async () => {
      document.body.setAttribute("inert", "");
    });
    expect(layout()).not.toContain("inert");
    await act(async () => {
      document.body.removeAttribute("inert");
    });
    await act(async () => {
      container.setAttribute("inert", "");
    });
    expect(layout()).toContain("inert");
    await act(async () => {
      container.removeAttribute("inert");
    });
    expect(layout()).not.toContain("inert");
    for (const [attribute, value, token] of [
      ["data-split-resize-grid-boundary", "", "split"],
      ["data-sidebar-shelf", "open", "sidebar-open"],
      ["data-panel-shelf", "shelf", "panel-shelf"],
      ["data-panel-shelf", "full", "panel-full"],
    ] as const) {
      await act(async () => {
        container.setAttribute(attribute, value);
      });
      expect(layout()).toContain(token);
      await act(async () => {
        container.removeAttribute(attribute);
      });
      expect(layout()).not.toContain(token);
    }
    const aside = document.createElement("aside");
    await act(async () => {
      document.body.append(aside);
      aside.append(container);
    });
    expect(layout()).not.toContain("main");
    await act(async () => {
      container.setAttribute("inert", "");
    });
    expect(layout()).not.toContain("inert");
    await act(async () => {
      document.body.append(container);
    });
    expect(layout()).toContain("main");
    expect(layout()).toContain("inert");
    await act(async () => {
      main.element.removeAttribute("data-thread-window");
    });
    expect(layout()).not.toContain("main");
    expect(main.bounds).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => {
      container.remove();
    });
    expect(document.body.hasAttribute("data-bb-chat-tabs-layout")).toBe(false);
  });

  it("shares one observer, ignores its own writes, and disconnects only after the last consumer", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const NativeObserver = MutationObserver;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "MutationObserver",
      class extends NativeObserver {
        override observe(...args: Parameters<MutationObserver["observe"]>) {
          observe(...args);
          super.observe(...args);
        }
        override disconnect() {
          disconnect();
          super.disconnect();
        }
      },
    );
    const set = vi.spyOn(document.body, "setAttribute");
    const first = render(<Overlay />);
    const second = render(<Overlay />);
    expect(observe).toHaveBeenCalledTimes(1);
    const writes = () =>
      set.mock.calls.filter(([name]) => name === "data-bb-chat-tabs-layout").length;
    const before = writes();
    await act(async () => {
      document.body.append(document.createElement("div"));
    });
    expect(writes()).toBe(before);
    first.unmount();
    expect(disconnect).not.toHaveBeenCalled();
    second.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    set.mockRestore();
  });
});

describe("Overlay bounds without CSS anchors", () => {
  it("moves the strip out from under the sidebar and follows resizing", async () => {
    vi.stubGlobal("CSS", { supports: () => false });
    let resized = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const inset = content(280, window.innerWidth);
    const view = render(<Overlay />);
    const overlay = view.getByTestId("overlay");
    expect(overlay.style.left).toBe("280px");
    expect(overlay.style.right).toBe("0px");
    inset.bounds.mockReturnValue({ left: 340, right: window.innerWidth - 220 } as DOMRect);
    await act(async () => {
      resized();
      resized();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(inset.bounds).toHaveBeenCalledTimes(2);
    expect(overlay.style.left).toBe("340px");
    expect(overlay.style.right).toBe("220px");
    act(() => resized());
    view.rerender(<Overlay enabled={false} />);
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(inset.bounds).toHaveBeenCalledTimes(2);
    expect(overlay.style.left).toBe("");
    expect(disconnect).toHaveBeenCalled();
  });

  it("prefers the main chat bounds, excludes aside panes and follows replaced targets", async () => {
    vi.stubGlobal("CSS", { supports: () => false });
    content(260, window.innerWidth);
    const panel = document.createElement("aside");
    const excluded = content(900, 1000, "data-thread-window");
    panel.append(excluded.element);
    document.body.append(panel);
    const main = content(260, 800, "data-thread-window");
    const view = render(<Overlay />);
    expect(view.getByTestId("overlay").style.right).toBe(`${window.innerWidth - 800}px`);
    await act(async () => {
      main.element.remove();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(view.getByTestId("overlay").style.right).toBe("0px");
    expect(view.getByTestId("overlay").style.left).toBe("260px");
  });

  it("leaves native CSS anchor positioning untouched where supported", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const inset = content(280, 800);
    const view = render(<Overlay />);
    expect(inset.bounds).not.toHaveBeenCalled();
    expect(view.getByTestId("overlay").style.left).toBe("");
  });
});
