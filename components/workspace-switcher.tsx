import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRpc, experimental_useSidebarThreadActions } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { MAX_WORKSPACES, validateWorkspaceName, type WorkspaceInfo } from "../lib/workspaces";
import { useWorkspaceSelection, workspaceSelectionStore } from "../lib/workspace-selection";
import { translate, type PluginLocale } from "../lib/plugin-locale";
import { Icon } from "./ui/icon";

const errorKeys = [
  "Use a workspace name of 1–80 characters.",
  "A workspace with this name already exists.",
  "Workspace limit reached (20).",
  "Keep at least one workspace.",
  "Workspace no longer exists.",
  "Workspace storage is damaged. Restore a backup before continuing.",
] as const;
export function workspaceErrorMessage(locale: PluginLocale, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const key = errorKeys.find((key) => message.includes(key));
  return key ? translate(locale, key) : message;
}

export function WorkspaceSwitcher({
  locale,
  currentThreadId,
  compact = false,
}: {
  locale: PluginLocale;
  currentThreadId: string | null;
  compact?: boolean;
}) {
  const selection = useWorkspaceSelection();
  const store = workspaceSelectionStore();
  const rpc = useRpc<typeof rpcContract>();
  const threadActions = experimental_useSidebarThreadActions();
  const nameId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const openedByHover = useRef(false);
  const hoverFocus = useRef<HTMLElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceInfo | null>(null);
  const [value, setValue] = useState("");
  const [newValue, setNewValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);
  const label = (workspace: WorkspaceInfo) =>
    workspace.defaultName ? t(workspace.defaultName) : workspace.name;

  const selected = selection.workspaces.find((workspace) => workspace.id === selection.workspaceId);
  const selectedLabel = selected ? label(selected) : t("Workspace");
  const segmenter = new Intl.Segmenter(locale, { granularity: "grapheme" });
  const initialFor = (name: string) => {
    const [first] = segmenter.segment(name);
    return first?.segment ?? "…";
  };

  const clearHoverTimers = useCallback(() => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    hoverTimer.current = null;
    leaveTimer.current = null;
  }, []);
  useEffect(() => clearHoverTimers, [clearHoverTimers]);

  const enterMenu = (pointerType: string) => {
    if (pointerType !== "mouse") return;
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    if (
      menuOpen ||
      open ||
      pending ||
      selection.workspaces.length === 0 ||
      hoverTimer.current !== null
    )
      return;
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      openedByHover.current = true;
      hoverFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMenuOpen(true);
    }, 300);
  };
  const leaveMenu = (pointerType: string) => {
    if (pointerType !== "mouse") return;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (!menuOpen || !openedByHover.current) return;
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      if (openedByHover.current) setMenuOpen(false);
    }, 120);
  };

  const changeDialogOpen = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (next) {
      setEditingId(null);
      setDeleteTarget(null);
      setValue("");
      setNewValue("");
      setError(null);
    }
  };

  const switchWorkspace = async (workspaceId: string, select = true) => {
    if (select) {
      if (store.getSnapshot().workspaceId === workspaceId) return;
      // The homepage can mount before the old overlay has observed its null route.
      store.observeRoute(currentThreadId);
      store.select(workspaceId);
    }
    const visit = store.getSnapshot();
    const routeRevision = store.getRouteRevision();
    const routeUrl = window.location.href;
    const current = () =>
      store.getSnapshot().workspaceId === workspaceId &&
      store.getSnapshot().generation === visit.generation &&
      store.getRouteRevision() === routeRevision &&
      window.location.href === routeUrl;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await rpc.call("tabs_list", { workspaceId, workflowThreadIds: [] });
        if (!current()) return;
        if (!store.acceptStateRevision(workspaceId, result.stateRevision)) continue;
        const remembered = store.lastActiveThreadId(workspaceId);
        const target =
          result.state.entries.find((entry) => entry.threadId === remembered) ??
          result.state.entries[0];
        if (target) {
          store.rememberActive(workspaceId, target.threadId);
          store.unparkRoute(target.threadId);
          if (target.threadId !== currentThreadId) threadActions.open(target.threadId);
        } else {
          store.unparkRoute(null);
          threadActions.openNewThread({ focusPrompt: true });
        }
        return;
      }
      throw new Error(t("Could not update the chat."));
    } catch (cause) {
      if (current()) toast.error(workspaceErrorMessage(locale, cause));
    }
  };

  const captureNavigation = () => {
    store.observeRoute(currentThreadId);
    const routeRevision = store.getRouteRevision();
    const selectionRevision = store.getSelectionRevision();
    const url = window.location.href;
    return () =>
      store.getRouteRevision() === routeRevision &&
      store.getSelectionRevision() === selectionRevision &&
      window.location.href === url;
  };

  const submit = async (
    event: FormEvent<HTMLFormElement>,
    workspaceId: string | null,
    inputValue: string,
  ) => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    try {
      const name = validateWorkspaceName(
        { workspaces: selection.workspaces },
        inputValue,
        workspaceId ?? undefined,
      );
      const revision = store.getSnapshot().revision;
      setPending(true);
      if (workspaceId !== null) {
        const result = await rpc.call("tabs_workspace_rename", { workspaceId, name });
        store.acceptCatalog(result.workspaces, revision, result.stateRevision);
      } else {
        const result = await rpc.call("tabs_workspace_create", { name });
        store.acceptCatalog(result.workspaces, revision, result.stateRevision);
      }
      setEditingId(null);
      setValue("");
      if (workspaceId === null) setNewValue("");
    } catch (cause) {
      setError(
        t("Could not update the workspace: {error}", {
          error: workspaceErrorMessage(locale, cause),
        }),
      );
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (pending || deleteTarget === null) return;
    const revision = store.getSnapshot().revision;
    const deletingCurrent = store.getSnapshot().workspaceId === deleteTarget.id;
    const current = captureNavigation();
    setError(null);
    setPending(true);
    try {
      const result = await rpc.call("tabs_workspace_delete", { workspaceId: deleteTarget.id });
      store.acceptCatalog(result.workspaces, revision, result.stateRevision);
      if (editingId === deleteTarget.id) {
        setEditingId(null);
        setValue("");
      }
      setDeleteTarget(null);
      const fallbackId = store.getSnapshot().workspaceId;
      if (deletingCurrent && fallbackId !== null && current())
        await switchWorkspace(fallbackId, false);
    } catch (cause) {
      setError(
        t("Could not update the workspace: {error}", {
          error: workspaceErrorMessage(locale, cause),
        }),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="bb-chat-tabs-workspace-switcher"
      data-compact={compact ? "true" : undefined}
      lang={locale}
      dir={locale === "ar" ? "rtl" : undefined}
    >
      <DropdownMenu.Root
        dir={locale === "ar" ? "rtl" : "ltr"}
        modal={false}
        open={menuOpen}
        onOpenChange={(next) => {
          if (next) openedByHover.current = false;
          clearHoverTimers();
          setMenuOpen(next);
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="bb-chat-tabs-workspace-trigger"
            aria-label={t("Workspace")}
            aria-description={selectedLabel}
            title={selectedLabel}
            disabled={selection.workspaces.length === 0 || pending}
            onPointerEnter={(event) => enterMenu(event.pointerType)}
            onPointerLeave={(event) => leaveMenu(event.pointerType)}
            onPointerCancel={clearHoverTimers}
            onKeyDown={(event) => {
              if (!menuOpen || event.key !== "ArrowDown") return;
              event.preventDefault();
              openedByHover.current = false;
              clearHoverTimers();
              menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || event.ctrlKey) return;
              // First click latches a hover-open menu, as in the chat list.
              if (menuOpen && openedByHover.current) {
                event.preventDefault();
                triggerRef.current?.focus();
              }
              openedByHover.current = false;
              clearHoverTimers();
            }}
          >
            <span className="bb-chat-tabs-workspace-initial" aria-hidden="true">
              {initialFor(selectedLabel)}
            </span>
            <span className="bb-chat-tabs-workspace-label" aria-hidden="true">
              {selectedLabel}
            </span>
            <Icon name="ChevronDown" className="bb-chat-tabs-workspace-chevron" aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            ref={menuRef}
            className="bb-chat-tabs-workspace-menu"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            aria-label={t("Workspace")}
            lang={locale}
            onFocus={(event) => {
              // Dropdown auto-focuses its container; hover is only a preview.
              if (openedByHover.current && event.target === event.currentTarget)
                hoverFocus.current?.focus({ preventScroll: true });
            }}
            onFocusOutside={(event) => {
              if (openedByHover.current && document.activeElement === hoverFocus.current)
                event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              if (openedByHover.current) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest(".bb-chat-tabs-workspace-trigger")
              )
                event.preventDefault();
            }}
            onPointerEnter={(event) => enterMenu(event.pointerType)}
            onPointerLeave={(event) => leaveMenu(event.pointerType)}
            onPointerDown={() => {
              openedByHover.current = false;
              clearHoverTimers();
            }}
          >
            <DropdownMenu.Label className="bb-chat-tabs-workspace-menu-label">
              {t("Workspace")}
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              className="bb-chat-tabs-workspace-menu-list"
              value={selection.workspaceId ?? ""}
              onValueChange={(id) => {
                if (store.getSnapshot().workspaces.some((item) => item.id === id))
                  void switchWorkspace(id);
              }}
            >
              {selection.workspaces.map((workspace) => {
                const name = label(workspace);
                return (
                  <DropdownMenu.RadioItem
                    key={workspace.id}
                    value={workspace.id}
                    className="bb-chat-tabs-workspace-menu-item"
                    aria-label={name}
                    onPointerMove={(event) => {
                      if (openedByHover.current) event.preventDefault();
                    }}
                  >
                    <span className="bb-chat-tabs-workspace-menu-badge" aria-hidden="true">
                      {initialFor(name)}
                    </span>
                    <span className="bb-chat-tabs-workspace-menu-name" title={name}>
                      {name}
                    </span>
                    <DropdownMenu.ItemIndicator className="bb-chat-tabs-workspace-menu-check">
                      <Icon name="Check" aria-hidden />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                );
              })}
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator className="bb-chat-tabs-workspace-menu-separator" />
            <DropdownMenu.Item
              className="bb-chat-tabs-workspace-menu-item"
              onPointerMove={(event) => {
                if (openedByHover.current) event.preventDefault();
              }}
              onSelect={() => {
                // Restore menu focus before the dialog takes it, as in tab rename.
                window.setTimeout(() => changeDialogOpen(true), 0);
              }}
            >
              <Icon name="Settings" className="bb-chat-tabs-workspace-menu-settings" aria-hidden />
              <span className="bb-chat-tabs-workspace-menu-name">{t("Manage workspaces")}…</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Dialog.Root open={open} onOpenChange={changeDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="bb-chat-tab-rename-overlay bb-chat-tabs-workspace-overlay" />
          <Dialog.Content
            className="bb-chat-tab-rename-dialog bb-chat-tabs-workspace-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              triggerRef.current?.focus();
            }}
            lang={locale}
            dir={locale === "ar" ? "rtl" : undefined}
          >
            <div className="bb-chat-tabs-workspace-dialog-header">
              <Dialog.Title className="bb-chat-tab-rename-title">{t("Workspaces")}</Dialog.Title>
              <Dialog.Description className="bb-chat-tab-rename-description">
                {t(
                  "A workspace is a set of tabs you can switch to in one click. Selection applies to this window only.",
                )}
              </Dialog.Description>
            </div>
            {error ? (
              <p role="alert" className="bb-chat-tab-rename-error">
                {error}
              </p>
            ) : null}
            <div className="bb-chat-tabs-workspace-dialog-body">
              <ul className="bb-chat-tabs-workspace-list">
                {selection.workspaces.map((workspace) => (
                  <li
                    key={workspace.id}
                    data-editing={editingId === workspace.id ? "true" : undefined}
                    data-confirming={deleteTarget?.id === workspace.id ? "true" : undefined}
                  >
                    {deleteTarget?.id === workspace.id ? (
                      <div
                        className="bb-chat-tabs-workspace-confirm"
                        role="group"
                        aria-label={t("Delete workspace")}
                      >
                        <p>
                          {t("Delete workspace “{name}”? Tabs will stay in history.", {
                            name: label(workspace),
                          })}
                          <span className="bb-chat-tabs-workspace-sr-only">
                            {t(
                              "Delete workspace “{name}”? Only its tabs and favorites will be removed. Chats and shared history will stay.",
                              { name: label(workspace) },
                            )}
                          </span>
                        </p>
                        <div className="bb-chat-tabs-workspace-confirm-actions">
                          <button
                            type="button"
                            className="bb-chat-tab-dialog-button"
                            autoFocus
                            disabled={pending}
                            onClick={() => {
                              setDeleteTarget(null);
                              setError(null);
                            }}
                          >
                            {t("Cancel")}
                          </button>
                          <button
                            type="button"
                            className="bb-chat-tab-dialog-button bb-chat-tab-dialog-button-primary"
                            disabled={pending}
                            onClick={() => void remove()}
                          >
                            {t("Delete")}
                          </button>
                        </div>
                      </div>
                    ) : editingId === workspace.id ? (
                      <form
                        className="bb-chat-tabs-workspace-edit"
                        onSubmit={(event) => void submit(event, workspace.id, value)}
                      >
                        <label
                          className="bb-chat-tabs-workspace-sr-only"
                          htmlFor={`${nameId}-rename`}
                        >
                          {t("Rename workspace")}: {label(workspace)}
                        </label>
                        <input
                          id={`${nameId}-rename`}
                          className="bb-chat-tab-rename-input"
                          value={value}
                          maxLength={160}
                          autoFocus
                          disabled={pending}
                          onChange={(event) => setValue(event.target.value)}
                        />
                        <button
                          type="submit"
                          className="bb-chat-tabs-workspace-action bb-chat-tabs-workspace-action-primary"
                          aria-label={t("Save")}
                          title={t("Save")}
                          disabled={pending}
                        >
                          <Icon name="Check" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="bb-chat-tabs-workspace-action"
                          aria-label={t("Cancel")}
                          title={t("Cancel")}
                          disabled={pending}
                          onClick={() => {
                            setEditingId(null);
                            setValue("");
                            setError(null);
                          }}
                        >
                          <Icon name="X" aria-hidden />
                        </button>
                      </form>
                    ) : (
                      <>
                        <span className="bb-chat-tabs-workspace-row-name" title={label(workspace)}>
                          {label(workspace)}
                        </span>
                        {workspace.id === selection.workspaceId ? (
                          <span className="bb-chat-tabs-workspace-current">{t("Current")}</span>
                        ) : null}
                        <button
                          type="button"
                          className="bb-chat-tabs-workspace-action"
                          aria-label={`${t("Rename workspace")}: ${label(workspace)}`}
                          title={t("Rename workspace")}
                          disabled={pending}
                          onClick={() => {
                            setEditingId(workspace.id);
                            setDeleteTarget(null);
                            setValue(label(workspace));
                            setError(null);
                          }}
                        >
                          <Icon name="Edit" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="bb-chat-tabs-workspace-action"
                          aria-label={`${t("Delete workspace")}: ${label(workspace)}`}
                          title={t("Delete workspace")}
                          disabled={pending || selection.workspaces.length === 1}
                          onClick={() => {
                            setDeleteTarget(workspace);
                            setEditingId(null);
                            setValue("");
                            setError(null);
                          }}
                        >
                          <Icon name="Trash2" aria-hidden />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <form
                className="bb-chat-tabs-workspace-add"
                onSubmit={(event) => void submit(event, null, newValue)}
              >
                <label className="bb-chat-tabs-workspace-sr-only" htmlFor={nameId}>
                  {t("Workspace name")}
                </label>
                <input
                  id={nameId}
                  className="bb-chat-tab-rename-input"
                  placeholder={t("New workspace")}
                  value={newValue}
                  maxLength={160}
                  disabled={pending || selection.workspaces.length >= MAX_WORKSPACES}
                  onChange={(event) => setNewValue(event.target.value)}
                />
                <button
                  type="submit"
                  className="bb-chat-tab-dialog-button"
                  disabled={pending || selection.workspaces.length >= MAX_WORKSPACES}
                >
                  <Icon name="Plus" aria-hidden />
                  {t("Add")}
                </button>
              </form>
              {selection.workspaces.length >= MAX_WORKSPACES ? (
                <p role="status">{t("Workspace limit reached (20).")}</p>
              ) : null}
            </div>
            <div className="bb-chat-tabs-workspace-dialog-footer">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="bb-chat-tab-dialog-button bb-chat-tab-dialog-button-primary"
                  disabled={pending}
                >
                  {t("Done")}
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
