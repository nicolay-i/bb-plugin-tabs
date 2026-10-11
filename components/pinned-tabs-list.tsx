import { Icon } from "./ui/icon";
import { SubthreadBadge } from "./subthread-badge";
import { chatStatusFor } from "../lib/chat-status";
import { translate, type PluginLocale, type TranslationKey } from "../lib/plugin-locale";

export interface PinnedTabsListItem {
  isUnread: boolean;
  isWorking: boolean;
  isWaiting?: boolean;
  isSubthread?: boolean;
  projectName: string;
  threadId: string;
  title: string;
}

interface PinnedTabsListProps {
  locale?: PluginLocale;
  onOpenThread: (threadId: string) => void;
  onRemoveThread?: (threadId: string) => void;
  removedThreadIds?: ReadonlySet<string>;
  pendingThreadIds?: ReadonlySet<string>;
  removeLabel?: TranslationKey;
  tabs: readonly PinnedTabsListItem[];
  visible: boolean;
  loading?: boolean;
  heading?: TranslationKey;
  emptyMessage?: TranslationKey;
}

/**
 * A quick route to pinned chats on the New chat home screen. Data and ordering
 * stay plugin-owned; live runtime statuses come from the parent homepage slot.
 */
export function PinnedTabsList({
  onOpenThread,
  onRemoveThread,
  removedThreadIds,
  pendingThreadIds,
  removeLabel = "Unpin",
  tabs,
  visible,
  loading = false,
  locale = "en",
  heading = "Tabs",
  emptyMessage = "No tabs yet. Open a chat and choose “Pin”.",
}: PinnedTabsListProps) {
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);
  if (!visible) {
    // Scoped CSS hides the parent host section. This marker also hides its
    // built-in heading, which the current slot API cannot hide declaratively.
    return (
      <div
        className="bb-chat-tabs-homepage-pinned-list"
        data-testid="bb-chat-tabs-homepage-pinned-list"
        data-visible="false"
        aria-hidden="true"
      />
    );
  }

  if (loading || tabs.length === 0) {
    return (
      <div
        className="bb-chat-tabs-homepage-pinned-list"
        lang={locale}
        data-testid="bb-chat-tabs-homepage-pinned-list"
        data-visible="true"
      >
        <h2 className="bb-chat-tabs-homepage-pinned-heading">{t(heading)}</h2>
        <p className="bb-chat-tabs-homepage-pinned-empty" role={loading ? "status" : undefined}>
          {loading ? t("Loading tabs…") : t(emptyMessage)}
        </p>
      </div>
    );
  }

  return (
    <div
      className="bb-chat-tabs-homepage-pinned-list"
      lang={locale}
      data-testid="bb-chat-tabs-homepage-pinned-list"
      data-visible="true"
    >
      <h2 className="bb-chat-tabs-homepage-pinned-heading">{t(heading)}</h2>
      <ul className="bb-chat-tabs-homepage-pinned-items" aria-label={t(heading)}>
        {tabs.map((tab) => {
          const status = chatStatusFor(tab, locale);
          const removed = removedThreadIds?.has(tab.threadId) ?? false;
          const isFavorite = removeLabel === "Remove from favorites";
          const action = removed ? (isFavorite ? "Add to favorites" : "Pin") : removeLabel;
          return (
            <li key={tab.threadId} className="bb-chat-tabs-homepage-pinned-item">
              <button
                type="button"
                className="bb-chat-tabs-homepage-pinned-button"
                aria-description={tab.isSubthread ? t("Subthread") : undefined}
                aria-label={
                  status === null
                    ? `${tab.title}. ${t("Project: {project}", { project: tab.projectName })}.`
                    : `${tab.title}. ${t("Project: {project}", { project: tab.projectName })}. ${status.text}.`
                }
                onClick={() => onOpenThread(tab.threadId)}
              >
                <span className="bb-chat-tabs-homepage-pinned-copy">
                  <span className="bb-chat-tabs-homepage-pinned-title" title={tab.title}>
                    {tab.title}
                  </span>
                  <span className="bb-chat-tabs-homepage-pinned-meta">
                    {tab.isSubthread ? <SubthreadBadge locale={locale} /> : null}
                    <span className="bb-chat-tabs-homepage-pinned-project" title={tab.projectName}>
                      {tab.projectName}
                    </span>
                    {status !== null ? (
                      <span
                        className="bb-chat-tabs-homepage-pinned-status"
                        data-status={status.kind}
                        title={status.text}
                      >
                        <span className="bb-chat-tabs-homepage-pinned-status-dot" aria-hidden />
                        {status.text}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
              {onRemoveThread !== undefined ? (
                <button
                  type="button"
                  className="bb-chat-tabs-homepage-remove"
                  aria-label={`${t(action)}: ${tab.title}`}
                  title={t(action)}
                  data-removed={removed}
                  disabled={pendingThreadIds?.has(tab.threadId)}
                  onClick={() => onRemoveThread(tab.threadId)}
                >
                  <Icon name={isFavorite ? "Star" : removed ? "Pin" : "PinOff"} aria-hidden />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
