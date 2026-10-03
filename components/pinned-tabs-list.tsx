import { chatStatusFor } from "../lib/chat-status";
import { translate, type PluginLocale } from "../lib/plugin-locale";

export interface PinnedTabsListItem {
  isUnread: boolean;
  isWorking: boolean;
  isWaiting?: boolean;
  projectName: string;
  threadId: string;
  title: string;
}

interface PinnedTabsListProps {
  locale?: PluginLocale;
  onOpenThread: (threadId: string) => void;
  tabs: readonly PinnedTabsListItem[];
  visible: boolean;
}

/**
 * A quick route to pinned chats on the New chat home screen. Data and ordering
 * stay plugin-owned; live runtime statuses come from the parent homepage slot.
 */
export function PinnedTabsList({
  onOpenThread,
  tabs,
  visible,
  locale = "en",
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

  if (tabs.length === 0) {
    return (
      <div
        className="bb-chat-tabs-homepage-pinned-list"
        lang={locale}
        data-testid="bb-chat-tabs-homepage-pinned-list"
        data-visible="true"
      >
        <h2 className="bb-chat-tabs-homepage-pinned-heading">{t("Pinned chats")}</h2>
        <p className="bb-chat-tabs-homepage-pinned-empty">
          {t("No pinned chats yet. Open a chat and choose “Pin”.")}
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
      <h2 className="bb-chat-tabs-homepage-pinned-heading">{t("Pinned chats")}</h2>
      <ul
        className="bb-chat-tabs-homepage-pinned-items"
        aria-label={t("Pinned chats")}
      >
        {tabs.map((tab) => {
          const status = chatStatusFor(tab, locale);
          return (
            <li key={tab.threadId} className="bb-chat-tabs-homepage-pinned-item">
              <button
                type="button"
                className="bb-chat-tabs-homepage-pinned-button"
                aria-label={
                  status === null
                    ? `${tab.title}. ${t("Project: {project}", { project: tab.projectName })}.`
                    : `${tab.title}. ${t("Project: {project}", { project: tab.projectName })}. ${status.text}.`
                }
                onClick={() => onOpenThread(tab.threadId)}
              >
                <span className="bb-chat-tabs-homepage-pinned-copy">
                  <span
                    className="bb-chat-tabs-homepage-pinned-title"
                    title={tab.title}
                  >
                    {tab.title}
                  </span>
                  <span className="bb-chat-tabs-homepage-pinned-meta">
                    <span
                      className="bb-chat-tabs-homepage-pinned-project"
                      title={tab.projectName}
                    >
                      {tab.projectName}
                    </span>
                    {status !== null ? (
                      <span
                        className="bb-chat-tabs-homepage-pinned-status"
                        data-status={status.kind}
                        title={status.text}
                      >
                        <span
                          className="bb-chat-tabs-homepage-pinned-status-dot"
                          aria-hidden
                        />
                        {status.text}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
