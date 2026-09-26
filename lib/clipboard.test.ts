// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

const initialClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const initialExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  vi.restoreAllMocks();
  if (initialClipboard === undefined) {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  } else {
    Object.defineProperty(navigator, "clipboard", initialClipboard);
  }
  if (initialExecCommand === undefined) {
    delete (document as { execCommand?: Document["execCommand"] }).execCommand;
  } else {
    Object.defineProperty(document, "execCommand", initialExecCommand);
  }
});

describe("copyTextToClipboard", () => {
  it("handles behavior 1", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyTextToClipboard("https://bb.test/thread")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://bb.test/thread");
  });

  it("handles behavior 2", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    await expect(copyTextToClipboard("https://bb.test/thread")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("handles behavior 3", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    await expect(copyTextToClipboard("https://bb.test/thread")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
