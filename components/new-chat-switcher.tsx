import { useCallback, useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { Icon } from "./ui/icon";

const HOVER_DELAY_MS = 300;
const LEAVE_DELAY_MS = 120;
const PROJECT_PAGE_SIZE = 15;

interface NewChatSwitcherProps {
  projects: readonly PluginSidebarProject[];
  openNewThread: (options?: { projectId?: string; focusPrompt?: boolean }) => void;
}

export function NewChatSwitcher({ projects, openNewThread }: NewChatSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PROJECT_PAGE_SIZE);
  const [morePending, setMorePending] = useState(false);
  const moreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedByHover = useRef(false);

  const clearMoreTimer = useCallback(() => {
    if (moreTimer.current !== null) clearTimeout(moreTimer.current);
    moreTimer.current = null;
    setMorePending(false);
  }, []);
  const clearTimers = useCallback(() => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    hoverTimer.current = null;
    leaveTimer.current = null;
  }, []);
  useEffect(() => () => {
    clearTimers();
    if (moreTimer.current !== null) clearTimeout(moreTimer.current);
  }, [clearTimers]);
  useEffect(() => {
    if (!open) {
      clearMoreTimer();
      setVisibleCount(PROJECT_PAGE_SIZE);
    }
  }, [open, clearMoreTimer]);

  const loadMore = () => {
    clearMoreTimer();
    setVisibleCount((current) => Math.min(current + PROJECT_PAGE_SIZE, projects.length));
  };
  const scheduleMore = () => {
    clearMoreTimer();
    setMorePending(true);
    moreTimer.current = setTimeout(loadMore, HOVER_DELAY_MS);
  };

  const enter = (pointerType: string) => {
    if (pointerType !== "mouse") return;
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    if (open || hoverTimer.current !== null || projects.length === 0) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      openedByHover.current = true;
      setOpen(true);
    }, HOVER_DELAY_MS);
  };

  const leave = (pointerType: string) => {
    if (pointerType !== "mouse") return;
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (!open) return;
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      setOpen(false);
    }, LEAVE_DELAY_MS);
  };

  const navigate = (projectId?: string) => {
    clearTimers();
    clearMoreTimer();
    setOpen(false);
    openNewThread({ ...(projectId ? { projectId } : {}), focusPrompt: true });
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => {
      if (!next) {
        clearTimers();
        clearMoreTimer();
      }
      setOpen(next);
    }}>
      <div className="bb-chat-tabs-new-switcher">
        <Popover.Anchor asChild>
          <button
            type="button"
            className="bb-chat-tabs-new-trigger"
            aria-label="New chat"
            aria-haspopup={projects.length > 0 ? "menu" : undefined}
            aria-expanded={projects.length > 0 ? open : undefined}
            onClick={() => navigate()}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" || projects.length === 0) return;
              event.preventDefault();
              openedByHover.current = false;
              clearTimers();
              setOpen(true);
            }}
            onPointerEnter={(event) => enter(event.pointerType)}
            onPointerLeave={(event) => leave(event.pointerType)}
            onPointerCancel={clearTimers}
          >
            <Icon name="Plus" className="bb-chat-tabs-new-icon" aria-hidden />
          </button>
        </Popover.Anchor>
      </div>
      {projects.length > 0 ? (
        <Popover.Portal>
          <Popover.Content
            className="bb-chat-tabs-new-menu"
            aria-label="Recent projects"
            role="menu"
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            onOpenAutoFocus={(event) => {
              if (openedByHover.current) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerEnter={(event) => enter(event.pointerType)}
            onPointerLeave={(event) => leave(event.pointerType)}
          >
            <div className="bb-chat-tabs-new-menu-heading">New chat in project</div>
            {projects.slice(0, visibleCount).map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitem"
                className="bb-chat-tabs-new-menu-item"
                onClick={() => navigate(project.id)}
                title={project.name}
              >
                <Icon name="Folder" className="bb-chat-tabs-new-menu-icon" aria-hidden />
                <span>{project.name}</span>
              </button>
            ))}
            {visibleCount < projects.length ? (
              <button
                type="button"
                role="menuitem"
                className="bb-chat-tabs-new-menu-more"
                aria-label={`Show ${Math.min(PROJECT_PAGE_SIZE, projects.length - visibleCount)} more projects`}
                data-pending={morePending ? "true" : "false"}
                onClick={loadMore}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") scheduleMore();
                }}
                onPointerLeave={clearMoreTimer}
                onPointerCancel={clearMoreTimer}
              >
                <span>More</span>
                <span>{projects.length - visibleCount}</span>
              </button>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      ) : null}
    </Popover.Root>
  );
}
