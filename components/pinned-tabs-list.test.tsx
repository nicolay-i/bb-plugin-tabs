// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinnedTabsList } from "./pinned-tabs-list";

afterEach(cleanup);

describe("Pinned tabs localization", () => {
  it("shows Russian empty state", () => {
    render(<PinnedTabsList locale="ru" visible tabs={[]} onOpenThread={vi.fn()} />);
    expect(screen.getByText("Вкладок пока нет. Откройте чат и выберите «Закрепить».")).toBeTruthy();
  });

  it("calls the homepage section Tabs in Russian", () => {
    render(<PinnedTabsList locale="ru" visible tabs={[]} onOpenThread={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Вкладки" })).toBeTruthy();
    expect(screen.queryByText("Закреплённые чаты")).toBeNull();
  });

  it("shows a waiting-for-input status instead of working on pinned cards", () => {
    render(<PinnedTabsList locale="ru" visible onOpenThread={vi.fn()} tabs={[{
      threadId: "thr_waiting", title: "Question", projectName: "Project Alpha",
      isWorking: true, isWaiting: true, isUnread: true,
    }]} />);
    expect(screen.getByRole("button", { name: "Question. Проект: Project Alpha. Нужен ответ · Непрочитанное." })).toBeTruthy();
    expect(document.querySelector('.bb-chat-tabs-homepage-pinned-status[data-status="waiting"]')).not.toBeNull();
  });

  it("translates status and accessibility text, not user titles", () => {
    render(<PinnedTabsList locale="ru" visible onOpenThread={vi.fn()} tabs={[{
      threadId: "thr_1", title: "My thread", projectName: "Project Alpha", isWorking: true, isUnread: true,
    }]} />);
    expect(screen.getByRole("button", { name: "My thread. Проект: Project Alpha. Работает · Непрочитанное." })).toBeTruthy();
  });
});
