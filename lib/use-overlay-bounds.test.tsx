// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOverlayBounds } from "./use-overlay-bounds";

function Overlay({ enabled = true }: { enabled?: boolean }) {
  return <aside data-testid="overlay" ref={useOverlayBounds(enabled)} />;
}
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

function content(left: number, right: number, attribute = 'data-sidebar') {
  const element = document.createElement("div");
  element.setAttribute(attribute, attribute === "data-sidebar" ? "inset" : "");
  const bounds = vi.fn(() => ({ left, right }) as DOMRect);
  element.getBoundingClientRect = bounds;
  document.body.append(element);
  return { element, bounds };
}

describe("Overlay bounds without CSS anchors", () => {
  it("moves the strip out from under the sidebar and follows resizing", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    let resized = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const inset = content(280, window.innerWidth);
    const view = render(<Overlay />);
    const overlay = view.getByTestId("overlay");
    expect(overlay.style.left).toBe("280px");
    expect(overlay.style.right).toBe("0px");
    inset.bounds.mockReturnValue({ left: 340, right: window.innerWidth - 220 } as DOMRect);
    act(() => resized());
    expect(overlay.style.left).toBe("340px");
    expect(overlay.style.right).toBe("220px");
    view.rerender(<Overlay enabled={false} />);
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
    await act(async () => { main.element.remove(); });
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
