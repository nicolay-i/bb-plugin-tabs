/**
 * The smallest publicly exposed BB Desktop capability.
 *
 * The Plugin SDK does not wrap this callback yet, so this module does not
 * import an internal desktop contract. The bridge is absent in web BB, while
 * Desktop uses only a feature-detected contextBridge shape.
 */
type DesktopUnsubscribe = () => void;
type DesktopBrowserFocusListener = (tabId: string) => void;

interface DesktopBrowserFocusBridge {
  onFocus?(listener: DesktopBrowserFocusListener): DesktopUnsubscribe;
}

interface DesktopCloseWindowBridge {
  browser?: DesktopBrowserFocusBridge;
  onCloseWindowRequest?(listener: () => boolean): DesktopUnsubscribe;
}

type DesktopGlobal = typeof globalThis & {
  bbDesktop?: unknown;
};

export function subscribeToDesktopCloseWindowRequest(
  listener: () => boolean,
): DesktopUnsubscribe | null {
  const desktop = (globalThis as DesktopGlobal).bbDesktop;
  if (typeof desktop !== "object" || desktop === null) return null;

  const bridge = desktop as DesktopCloseWindowBridge;
  if (typeof bridge.onCloseWindowRequest !== "function") return null;
  return bridge.onCloseWindowRequest(listener);
}

/**
 * A native BrowserView does not dispatch DOM keydown events to the renderer.
 * This capability reports focus in the embedded browser WebContents, not its
 * renderer-side chrome.
 */
export function subscribeToDesktopBrowserViewFocus(
  listener: DesktopBrowserFocusListener,
): DesktopUnsubscribe | null {
  const desktop = (globalThis as DesktopGlobal).bbDesktop;
  if (typeof desktop !== "object" || desktop === null) return null;

  const browser = (desktop as DesktopCloseWindowBridge).browser;
  if (typeof browser?.onFocus !== "function") return null;
  return browser.onFocus(listener);
}
