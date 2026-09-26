/**
 * Copies text through the Clipboard API, with a short-lived textarea fallback
 * when the browser denies access. Returns a result so the UI can show a clear
 * toast instead of surfacing an exception.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (text.length === 0) return false;

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Electron, webviews, or insecure origins can deny the Clipboard API.
    }
  }

  if (
    typeof document === "undefined" ||
    document.body === null ||
    typeof document.execCommand !== "function"
  ) {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    height: "1px",
    left: "0",
    opacity: "0",
    padding: "0",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: "1px",
  });

  document.body.append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
