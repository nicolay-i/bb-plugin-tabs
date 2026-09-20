import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import type { TabEntry } from "../lib/tabs-model";
import { Icon } from "./ui/icon";

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
  entry: TabEntry;
  isPinned: boolean;
  onArchive: (entry: TabEntry) => void;
  onCopyLink: (entry: TabEntry) => void;
  onMarkUnread: (entry: TabEntry) => void;
  onRename: (target: RenameTabTarget) => void;
  onSetPinned: (entry: TabEntry, pinned: boolean) => void;
  title: string;
}

/** Контекстные действия принадлежат вкладке, а host-мутации — caller'у. */
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
}: TabActionsContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="bb-chat-tab-context-menu"
          aria-label={`Действия для «${title}»`}
        >
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            onSelect={() => onCopyLink(entry)}
          >
            <Icon name="Copy" aria-hidden />
            Скопировать ссылку
          </ContextMenu.Item>
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            onSelect={() => onMarkUnread(entry)}
          >
            <Icon name="Mail" aria-hidden />
            Пометить непрочитанным
          </ContextMenu.Item>
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            onSelect={() => onSetPinned(entry, !isPinned)}
          >
            <Icon name={isPinned ? "PinOff" : "Pin"} aria-hidden />
            {isPinned ? "Открепить" : "Закрепить"}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            onSelect={() => {
              // Сначала Radix должен вернуть focus trigger'у, затем modal
              // заберёт его по своим правилам.
              window.setTimeout(() => onRename({ entry, title }), 0);
            }}
          >
            <Icon name="Edit" aria-hidden />
            Переименовать
          </ContextMenu.Item>
          <ContextMenu.Separator className="bb-chat-tab-context-menu-separator" />
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            onSelect={() => onArchive(entry)}
          >
            <Icon name="Archive" aria-hidden />
            Архивировать
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

interface RenameTabDialogProps {
  onClose: () => void;
  onRename: (entry: TabEntry, title: string) => Promise<void>;
  target: RenameTabTarget | null;
}

/** Явный modal-путь переименования из контекстного меню. */
export function RenameTabDialog({
  onClose,
  onRename,
  target,
}: RenameTabDialogProps) {
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
      setError("Введите название от 1 до 300 символов.");
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
      setError(
        cause instanceof Error ? cause.message : "Не удалось переименовать чат.",
      );
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
        <Dialog.Content className="bb-chat-tab-rename-dialog">
          <Dialog.Title className="bb-chat-tab-rename-title">
            Переименовать чат
          </Dialog.Title>
          <Dialog.Description className="bb-chat-tab-rename-description">
            Новое название будет видно и в sidebar BB.
          </Dialog.Description>
          <form onSubmit={(event) => void submit(event)}>
            <input
              autoFocus
              className="bb-chat-tab-rename-input"
              aria-label="Новое название чата"
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
                Отмена
              </button>
              <button
                type="submit"
                className="bb-chat-tab-dialog-button bb-chat-tab-dialog-button-primary"
                disabled={saving}
              >
                {saving ? "Сохранение…" : "Сохранить"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
