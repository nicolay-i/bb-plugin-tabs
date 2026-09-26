import { chatStatusFor } from "../lib/chat-status";

export interface PinnedTabsListItem {
  isUnread: boolean;
  isWorking: boolean;
  projectName: string;
  threadId: string;
  title: string;
}

interface PinnedTabsListProps {
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
}: PinnedTabsListProps) {
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
        data-testid="bb-chat-tabs-homepage-pinned-list"
        data-visible="true"
      >
        <p className="bb-chat-tabs-homepage-pinned-empty">
          No pinned chats yet. Open a chat and choose “Pin”.
        </p>
      </div>
    );
  }

  return (
    <div
      className="bb-chat-tabs-homepage-pinned-list"
      data-testid="bb-chat-tabs-homepage-pinned-list"
      data-visible="true"
    >
      <ul
        className="bb-chat-tabs-homepage-pinned-items"
        aria-label="Pinned chats"
      >
        {tabs.map((tab) => {
          const status = chatStatusFor(tab);
          return (
            <li key={tab.threadId} className="bb-chat-tabs-homepage-pinned-item">
              <button
                type="button"
                className="bb-chat-tabs-homepage-pinned-button"
                aria-label={
                  status === null
                    ? `${tab.title}. Project: ${tab.projectName}.`
                    : `${tab.title}. Project: ${tab.projectName}. ${status.text}.`
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
