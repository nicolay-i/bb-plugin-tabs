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
 * Быстрый переход к закреплённым чатам на root-экране «Новый чат».
 * Данные и порядок остаются plugin-owned, а текущие runtime-статусы приходят
 * из live sidebar snapshot родительского homepage slot.
 */
export function PinnedTabsList({
  onOpenThread,
  tabs,
  visible,
}: PinnedTabsListProps) {
  if (!visible) {
    // Родительский host-section скрывается scoped CSS-правилом. Этот marker
    // позволяет убрать также его штатный заголовок, которого slot API пока
    // не умеет скрывать декларативно.
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
          Пока нет закреплённых чатов. Откройте нужный чат и нажмите
          «Закрепить».
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
        aria-label="Закреплённые чаты"
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
                    ? `${tab.title}. Проект: ${tab.projectName}.`
                    : `${tab.title}. Проект: ${tab.projectName}. ${status.text}.`
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
