import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import type { TabEntry } from "../lib/tabs-model";
import { Icon } from "./ui/icon";
import { translate, type PluginLocale } from "../lib/plugin-locale";

const MAX_THREAD_TITLE_LENGTH = 300;

export interface RenameTabTarget {
  entry: TabEntry;
  title: string;
}

export function normalizeTabTitle(value: string): string | null {
  const title = value.trim();
  return title.length > 0 && title.length <= MAX_THREAD_TITLE_LENGTH
    ? title
    : null;
}

interface TabActionsContextMenuProps {
  children: ReactNode;
  locale?: PluginLocale;
  entry: TabEntry;
  isPinned: boolean;
  onArchive: (entry: TabEntry) => void;
  onCopyLink: (entry: TabEntry) => void;
  onMarkUnread: (entry: TabEntry) => void;
  onRename: (target: RenameTabTarget) => void;
  onSetPinned: (entry: TabEntry, pinned: boolean) => void;
  title: string;
}

/** Tab actions belong to a tab, while host mutations remain with the caller. */
export function TabActionsContextMenu({
  children,
  entry,
  isPinned,
  onArchive,
  onCopyLink,
  onMarkUnread,
  onRename,
  onSetPinned,
  title,
  locale = "en",
}: TabActionsContextMenuProps) {
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="bb-chat-tab-context-menu"
          aria-label={t("Actions for “{title}”", { title })}
        >
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            onSelect={() => onCopyLink(entry)}
          >
            <Icon name="Copy" aria-hidden />
            {t("Copy link")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            onSelect={() => onMarkUnread(entry)}
          >
            <Icon name="Mail" aria-hidden />
            {t("Mark as unread")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            onSelect={() => onSetPinned(entry, !isPinned)}
          >
            <Icon name={isPinned ? "PinOff" : "Pin"} aria-hidden />
            {isPinned ? t("Unpin") : t("Pin")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            onSelect={() => {
              // Let Radix restore focus to the trigger before the modal takes it.
              window.setTimeout(() => onRename({ entry, title }), 0);
            }}
          >
            <Icon name="Edit" aria-hidden />
            {t("Rename")}
          </ContextMenu.Item>
          <ContextMenu.Separator className="bb-chat-tab-context-menu-separator" />
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            onSelect={() => onArchive(entry)}
          >
            <Icon name="Archive" aria-hidden />
            {t("Archive")}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

interface RenameTabDialogProps {
  locale?: PluginLocale;
  onClose: () => void;
  onRename: (entry: TabEntry, title: string) => Promise<void>;
  target: RenameTabTarget | null;
}

/** Explicit modal rename path from the context menu. */
export function RenameTabDialog({
  onClose,
  onRename,
  target,
  locale = "en",
}: RenameTabDialogProps) {
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(target?.title ?? "");
    setError(null);
    setSaving(false);
  }, [target]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (target === null || saving) return;

    const title = normalizeTabTitle(value);
    if (title === null) {
      setError(t("Enter a title between 1 and 300 characters."));
      return;
    }
    if (title === target.title) {
      onClose();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onRename(target.entry, title);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not rename the chat."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="bb-chat-tab-rename-overlay" />
        <Dialog.Content className="bb-chat-tab-rename-dialog" lang={locale}>
          <Dialog.Title className="bb-chat-tab-rename-title">
            {t("Rename chat")}
          </Dialog.Title>
          <Dialog.Description className="bb-chat-tab-rename-description">
            {t("The new title will also be shown in the BB sidebar.")}
          </Dialog.Description>
          <form onSubmit={(event) => void submit(event)}>
            <input
              autoFocus
              className="bb-chat-tab-rename-input"
              aria-label={t("New chat title")}
              maxLength={MAX_THREAD_TITLE_LENGTH}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            {error === null ? null : (
              <p className="bb-chat-tab-rename-error" role="alert">
                {error}
              </p>
            )}
            <div className="bb-chat-tab-rename-actions">
              <button
                type="button"
                className="bb-chat-tab-dialog-button"
                disabled={saving}
                onClick={onClose}
              >
                {t("Cancel")}
              </button>
              <button
                type="submit"
                className="bb-chat-tab-dialog-button bb-chat-tab-dialog-button-primary"
                disabled={saving}
              >
                {saving ? t("Saving…") : t("Save")}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
