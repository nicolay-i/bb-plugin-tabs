import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { Icon } from "./ui/icon";
import { translate, type PluginLocale } from "../lib/plugin-locale";
import { tabAppearanceTitle, type TabAppearance } from "../lib/tab-appearance";
import { fuzzyChatSearch } from "../lib/fuzzy-chat-search";

const HOVER_DELAY_MS = 300;
const LEAVE_DELAY_MS = 120;
const PROJECT_PAGE_SIZE = 15;

interface NewChatSwitcherProps {
  locale?: PluginLocale;
  projects: readonly PluginSidebarProject[];
  preferredProjectIds?: ReadonlySet<string>;
  appearance?: TabAppearance;
  openNewThread: (options?: { projectId?: string; focusPrompt?: boolean }) => void;
}

export function NewChatSwitcher({
  projects,
  preferredProjectIds,
  appearance,
  openNewThread,
  locale = "en",
}: NewChatSwitcherProps) {
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);
  const [open, setOpen] = useState(false);
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const matches = useMemo(
    () =>
      query.trim()
        ? fuzzyChatSearch(
            projects.map((project) => ({
              project,
              title: project.name,
              projectName: appearance?.projects[project.id]?.alias ?? "",
            })),
            query,
            projects.length,
          ).map(({ project }) => project)
        : projects,
    [projects, appearance, query],
  );
  useEffect(() => {
    if (open) selectedItemRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [open, selectedIndex, matches]);
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
  useEffect(
    () => () => {
      clearTimers();
      if (moreTimer.current !== null) clearTimeout(moreTimer.current);
    },
    [clearTimers],
  );
  useEffect(() => {
    if (!open) {
      clearMoreTimer();
      setVisibleCount(PROJECT_PAGE_SIZE);
      setQuery("");
      setSelectedIndex(-1);
    }
  }, [open, clearMoreTimer]);

  const loadMore = () => {
    clearMoreTimer();
    setVisibleCount((current) => Math.min(current + PROJECT_PAGE_SIZE, matches.length));
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
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          clearTimers();
          clearMoreTimer();
        }
        setOpen(next);
      }}
    >
      <div className="bb-chat-tabs-new-switcher">
        <Popover.Anchor asChild>
          <button
            type="button"
            className="bb-chat-tabs-new-trigger"
            aria-label={t("New chat")}
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
            lang={locale}
            className="bb-chat-tabs-new-menu"
            id={searchId}
            aria-label={t("Recent projects")}
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
            <div className="bb-chat-tabs-list-menu-search">
              <Icon name="Search" className="bb-chat-tabs-list-menu-search-icon" aria-hidden />
              <input
                type="search"
                className="bb-chat-tabs-list-menu-search-input"
                aria-label={t("Search projects")}
                aria-controls={searchId}
                aria-activedescendant={
                  selectedIndex < 0 ? undefined : `${searchId}-${selectedIndex}`
                }
                placeholder={t("Search projects")}
                value={query}
                maxLength={300}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedIndex(-1);
                  setVisibleCount(PROJECT_PAGE_SIZE);
                  clearMoreTimer();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" || event.nativeEvent.isComposing) return;
                  event.stopPropagation();
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const count = Math.min(visibleCount, matches.length);
                    setSelectedIndex((current) =>
                      count === 0
                        ? -1
                        : event.key === "ArrowDown"
                          ? (current + 1) % count
                          : (current <= 0 ? count : current) - 1,
                    );
                  } else if (event.key === "Enter" && matches.length > 0) {
                    event.preventDefault();
                    navigate((matches[selectedIndex] ?? matches[0])!.id);
                  }
                }}
              />
            </div>
            <div className="bb-chat-tabs-new-menu-heading">{t("New chat in project")}</div>
            {matches.length === 0 ? (
              <span className="bb-chat-tabs-list-menu-search-empty">{t("No projects found")}</span>
            ) : null}
            {matches.slice(0, visibleCount).map((project, index) => (
              <Fragment key={project.id}>
                {preferredProjectIds &&
                preferredProjectIds.size > 0 &&
                (index === 0 ||
                  preferredProjectIds.has(matches[index - 1]!.id) !==
                    preferredProjectIds.has(project.id)) ? (
                  <div className="bb-chat-tabs-new-menu-heading">
                    {t(
                      preferredProjectIds.has(project.id)
                        ? "Projects in this workspace"
                        : "Other projects",
                    )}
                  </div>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="bb-chat-tabs-new-menu-item"
                  data-selected={index === selectedIndex ? "true" : undefined}
                  id={`${searchId}-${index}`}
                  ref={index === selectedIndex ? selectedItemRef : undefined}
                  onClick={() => navigate(project.id)}
                  title={project.name}
                >
                  <Icon name="Folder" className="bb-chat-tabs-new-menu-icon" aria-hidden />
                  <span>
                    {appearance
                      ? tabAppearanceTitle(appearance, project.id, project.name)
                      : project.name}
                  </span>
                </button>
              </Fragment>
            ))}
            {visibleCount < matches.length ? (
              <button
                type="button"
                role="menuitem"
                className="bb-chat-tabs-new-menu-more"
                aria-label={t("Show {count} more projects", {
                  count: Math.min(PROJECT_PAGE_SIZE, matches.length - visibleCount),
                })}
                data-pending={morePending ? "true" : "false"}
                onClick={loadMore}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") scheduleMore();
                }}
                onPointerLeave={clearMoreTimer}
                onPointerCancel={clearMoreTimer}
              >
                <span>{t("More")}</span>
                <span>{matches.length - visibleCount}</span>
              </button>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      ) : null}
    </Popover.Root>
  );
}
