// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadChildrenMenu } from "./thread-children-menu";
import type { ChildThreadNode } from "../lib/thread-children";

const child = (threadId: string, children: ChildThreadNode[] = []): ChildThreadNode => ({
  threadId,
  projectId: "proj_api",
  title: threadId,
  isWorking: false,
  isWaiting: false,
  isUnread: false,
  workingCount: 0,
  hasUnread: false,
  children,
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const openMenu = () =>
  fireEvent.pointerDown(screen.getByRole("button"), { button: 0, ctrlKey: false });

describe("Subthread menu", () => {
  it("hides the counter on leaf tabs and exposes all calm children when the count is zero", async () => {
    const onOpen = vi.fn();
    const view = render(
      <ThreadChildrenMenu title="Root" children={[]} workingCount={0} onOpen={onOpen} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(
      <ThreadChildrenMenu
        title="Root"
        children={[child("Calm")]}
        workingCount={0}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByRole("button", { name: "Subthreads of “Root”" })).toBeTruthy();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Calm" }));
    expect(onOpen).toHaveBeenCalledWith({ threadId: "Calm", projectId: "proj_api", title: "Calm" });
  });

  it("opens recursive side menus by keyboard and selects the grandchild", async () => {
    const onOpen = vi.fn();
    render(
      <ThreadChildrenMenu
        title="Root"
        children={[child("Parent", [child("Grandchild")])]}
        workingCount={0}
        onOpen={onOpen}
      />,
    );
    openMenu();
    const parent = await screen.findByRole("menuitem", { name: /Parent/ });
    fireEvent.keyDown(parent, { key: "ArrowRight" });
    const grandchild = await screen.findByRole("menuitem", { name: "Grandchild" });
    expect(screen.getByRole("menu", { name: "Subthreads of “Parent”" })).toBeTruthy();
    fireEvent.click(grandchild);
    expect(onOpen).toHaveBeenCalledWith({
      threadId: "Grandchild",
      projectId: "proj_api",
      title: "Grandchild",
    });
  });

  it("allows opening a subthread even when it has its own children", async () => {
    const onOpen = vi.fn();
    render(
      <ThreadChildrenMenu
        title="Root"
        children={[child("Parent", [child("Grandchild")])]}
        workingCount={1}
        onOpen={onOpen}
      />,
    );
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Parent/ }));
    expect(onOpen).toHaveBeenCalledWith({
      threadId: "Parent",
      projectId: "proj_api",
      title: "Parent",
    });
  });

  it("lets touch users expand a parent through its arrow without navigating", async () => {
    const onOpen = vi.fn();
    render(
      <ThreadChildrenMenu
        title="Root"
        children={[child("Parent", [child("Grandchild")])]}
        workingCount={0}
        onOpen={onOpen}
      />,
    );
    openMenu();
    const parent = await screen.findByRole("menuitem", { name: /Parent/ });
    fireEvent.click(parent.querySelector(".bb-chat-tabs-child-expand")!);
    expect(await screen.findByRole("menuitem", { name: "Grandchild" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens after hover delay, preserves the menu across the gap and cleans up timers", async () => {
    vi.useFakeTimers();
    const view = render(
      <ThreadChildrenMenu
        title="Root"
        children={[child("Child")]}
        workingCount={0}
        onOpen={vi.fn()}
      />,
    );
    fireEvent.pointerEnter(screen.getByRole("button"), { pointerType: "mouse" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(screen.queryByRole("menu")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("menuitem", { name: "Child" })).toBeTruthy();
    fireEvent.pointerLeave(screen.getByRole("button"));
    fireEvent.pointerEnter(screen.getByRole("menu"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByRole("menu")).toBeTruthy();
    view.unmount();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
  });

  it("shows working and unread markers before the subthread title", async () => {
    const busy = { ...child("Busy"), isWorking: true, isUnread: true };
    render(
      <ThreadChildrenMenu
        title="Root"
        children={[busy, child("Calm")]}
        workingCount={1}
        onOpen={vi.fn()}
      />,
    );
    openMenu();
    const item = await screen.findByRole("menuitem", { name: "Busy. Working · Unread." });
    const indicators = item.querySelector(".bb-chat-tabs-child-indicators")!;
    expect(item.firstElementChild).toBe(indicators);
    expect(indicators.querySelector(".bb-chat-tab-working")).not.toBeNull();
    expect(indicators.querySelector(".bb-chat-tabs-child-unread")).not.toBeNull();
    expect(
      indicators.nextElementSibling?.querySelector(".bb-chat-tabs-child-title")?.textContent,
    ).toBe("Busy");
    expect(
      screen
        .getByRole("menuitem", { name: "Calm" })
        .querySelector(".bb-chat-tabs-child-indicators"),
    ).toBeNull();
  });

  it("keeps unread dots inside the tree without a badge or work accent on idle tabs", async () => {
    const unread = { ...child("Unread"), isUnread: true };
    const parent = { ...child("Parent", [unread]), hasUnread: true };
    const view = render(
      <ThreadChildrenMenu
        locale="ru"
        title="Root"
        children={[parent]}
        workingCount={0}
        hasUnread
        onOpen={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Сабтреды «Root»: есть непрочитанные",
    });
    expect(trigger.textContent).toBe("");
    expect(trigger.getAttribute("title")).toBe(trigger.getAttribute("aria-label"));
    expect(trigger.hasAttribute("data-attention")).toBe(false);
    expect(trigger.querySelector(".bb-chat-tabs-child-unread")).toBeNull();
    openMenu();
    const item = await screen.findByRole("menuitem", { name: "Parent" });
    expect(item.querySelector(".bb-chat-tabs-child-count")).toBeNull();
    expect(item.querySelector(".bb-chat-tabs-child-unread")).not.toBeNull();
    fireEvent.keyDown(item, { key: "ArrowRight" });
    const leaf = await screen.findByRole("menuitem", { name: "Unread. Непрочитанное." });
    expect(leaf.querySelector(".bb-chat-tabs-child-unread")).not.toBeNull();
    expect(view.container.querySelector(".bb-chat-tab-working")).toBeNull();
    view.rerender(
      <ThreadChildrenMenu
        title="Root"
        children={[parent]}
        workingCount={2}
        hasUnread
        onOpen={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Subthreads of “Root”: 2 working" }).textContent,
    ).toBe("2");
  });

  it("localizes the badge and statuses while preserving user titles", async () => {
    const waiting = { ...child("User title"), isWaiting: true, isWorking: true, isUnread: true };
    render(
      <ThreadChildrenMenu
        locale="ru"
        title="Root"
        children={[waiting]}
        workingCount={1}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Сабтреды «Root»: работают 1" })).toBeTruthy();
    openMenu();
    const item = await screen.findByRole("menuitem", {
      name: "User title. Нужен ответ · Непрочитанное.",
    });
    const indicators = item.querySelector(".bb-chat-tabs-child-indicators")!;
    expect(indicators.getAttribute("title")).toBe("Нужен ответ · Непрочитанное");
    expect(indicators.querySelector(".bb-chat-tab-waiting")?.textContent).toBe("?");
    expect(indicators.querySelector(".bb-chat-tabs-child-unread")).not.toBeNull();
    expect(indicators.querySelector(".bb-chat-tab-working")).toBeNull();
    expect(screen.getByText("User title")).toBeTruthy();
  });
});
