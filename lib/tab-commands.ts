import { useLayoutEffect, useRef } from "react";
import type { PluginCommandContext, PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import { translate, type PluginLocale } from "./plugin-locale";

export type TabCommandAction =
  | { kind: "select"; index: number }
  | {
      kind:
        | "last"
        | "toggle-pin"
        | "toggle-favorite"
        | "next-workspace"
        | "parent"
        | "children"
        | "rename"
        | "list"
        | "copy-link"
        | "close-others"
        | "move-left"
        | "move-right"
        | "next"
        | "previous"
        | "restore";
    };

export interface TabCommandTarget {
  threadId: string | null;
  isAvailable(action: TabCommandAction): boolean;
  run(action: TabCommandAction): Promise<void>;
}

const targets = new WeakMap<Window, () => TabCommandTarget | null>();

/** Registrations stay static; only this window's committed action snapshot changes. */
export function useTabCommandTarget(target: TabCommandTarget | null) {
  const latest = useRef(target);
  useLayoutEffect(() => {
    latest.current = target;
  });
  useLayoutEffect(() => {
    const read = () => latest.current;
    targets.set(window, read);
    return () => {
      if (targets.get(window) === read) targets.delete(window);
    };
  }, []);
}

export function createTabCommands(locale: PluginLocale): PluginCommandRegistration[] {
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);
  const definitions: Array<{
    id: string;
    title: string;
    action: TabCommandAction;
    defaultShortcut?: PluginCommandRegistration["defaultShortcut"];
  }> = [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `select-${index + 1}`,
      title: t("Open tab {number}", { number: index + 1 }),
      action: { kind: "select" as const, index },
      defaultShortcut: { key: String(index + 1), mod: true, alt: true },
    })),
    {
      id: "last",
      title: t("Open last tab"),
      action: { kind: "last" },
      defaultShortcut: { key: "9", mod: true, alt: true },
    },
    {
      id: "toggle-pin",
      title: `${t("Pin")} / ${t("Unpin")}`,
      action: { kind: "toggle-pin" },
      defaultShortcut: { key: "p", mod: true, alt: true },
    },
    {
      id: "toggle-favorite",
      title: `${t("Add to favorites")} / ${t("Remove from favorites")}`,
      action: { kind: "toggle-favorite" },
      defaultShortcut: { key: "s", mod: true, alt: true },
    },
    {
      id: "next-workspace",
      title: t("Next workspace"),
      action: { kind: "next-workspace" },
      defaultShortcut: { key: "w", mod: true, alt: true },
    },
    {
      id: "parent",
      title: t("Go to parent chat"),
      // No default: Ctrl+Alt+arrows switch GNOME workspaces and rotate some Windows displays.
      action: { kind: "parent" },
    },
    {
      id: "children",
      title: t("Open subthread tree"),
      action: { kind: "children" },
    },
    {
      id: "rename",
      title: t("Rename chat"),
      action: { kind: "rename" },
      defaultShortcut: { key: "F2" },
    },
    { id: "list", title: t("Open tab list"), action: { kind: "list" } },
    { id: "copy-link", title: t("Copy link"), action: { kind: "copy-link" } },
    { id: "close-others", title: t("Close other tabs"), action: { kind: "close-others" } },
    { id: "move-left", title: t("Move tab left"), action: { kind: "move-left" } },
    { id: "move-right", title: t("Move tab right"), action: { kind: "move-right" } },
    { id: "next", title: t("Next tab"), action: { kind: "next" } },
    { id: "previous", title: t("Previous tab"), action: { kind: "previous" } },
    { id: "restore", title: t("Restore closed tab"), action: { kind: "restore" } },
  ];
  const targetFor = (context: PluginCommandContext) => {
    const target = targets.get(window)?.();
    return target?.threadId === context.threadId ? target : null;
  };
  return definitions.map(({ action, ...registration }) => ({
    ...registration,
    isAvailable(context) {
      if (!targetFor(context)?.isAvailable(action)) return false;
      // The palette is itself a dialog input. Its run restores the original focus;
      // the host checks availability before keyboard invocation, not after it.
      return (
        action.kind !== "rename" ||
        !(
          document.activeElement?.closest(
            'input, textarea, select, [contenteditable="true"], [role="textbox"]',
          ) && !document.activeElement.closest('[role="dialog"], [role="alertdialog"]')
        )
      );
    },
    async run(context) {
      const target = targetFor(context);
      if (target?.isAvailable(action)) await target.run(action);
    },
  }));
}
