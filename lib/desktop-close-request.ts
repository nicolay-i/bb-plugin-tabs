/**
 * Минимальная публично экспонированная Desktop capability BB.
 *
 * Plugin SDK пока не оборачивает этот callback, поэтому не импортируем
 * внутренний desktop-contract: в web-клиенте bridge отсутствует, а в Desktop
 * используем только проверяемую структурную возможность contextBridge.
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
 * Нативный BrowserView не посылает DOM keydown в renderer. Эта capability
 * сообщает именно о фокусе WebContents встроенного браузера, а не его chrome.
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
