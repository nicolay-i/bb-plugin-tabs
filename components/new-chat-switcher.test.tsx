// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewChatSwitcher } from "./new-chat-switcher";
import { defaultTabAppearance, updateTabAppearance } from "../lib/tab-appearance";

const projects = [
  { id: "p1", name: "First project", isPersonal: false },
  { id: "p2", name: "Second project", isPersonal: false },
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("New chat switcher", () => {
  it("searches every project by name or alias, supports keyboard choice and clears on close", () => {
    const manyProjects = Array.from({ length: 33 }, (_, index) => ({
      id: `p${index}`,
      name: `Project ${index}`,
      isPersonal: false,
    }));
    const appearance = updateTabAppearance(defaultTabAppearance(), {
      kind: "project",
      projectId: "p32",
      alias: "Backend",
    });
    const openNewThread = vi.fn();
    render(
      <NewChatSwitcher
        projects={manyProjects}
        appearance={appearance}
        openNewThread={openNewThread}
      />,
    );
    const trigger = screen.getByRole("button", { name: "New chat" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const search = screen.getByRole("searchbox", { name: "Search projects" });
    fireEvent.change(search, { target: { value: "Backend" } });
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "[Backend] Project 32" })).toBeTruthy();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByRole("menuitem").id);
    expect(openNewThread).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    expect(openNewThread).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(openNewThread).toHaveBeenCalledWith({ projectId: "p32", focusPrompt: true });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzzzzzz" } });
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(screen.getByText("No projects found")).toBeTruthy();
  });
  it("reveals keyboard-selected projects without moving focus from the search", () => {
    const manyProjects = Array.from({ length: 20 }, (_, index) => ({
      id: `p${index}`,
      name: `Project ${index}`,
      isPersonal: false,
    }));
    render(<NewChatSwitcher projects={manyProjects} openNewThread={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "New chat" }), { key: "ArrowDown" });
    const search = screen.getByRole("searchbox");
    search.focus();
    const first = screen.getByRole("menuitem", { name: "Project 0" });
    const last = screen.getByRole("menuitem", { name: "Project 14" });
    first.scrollIntoView = vi.fn();
    last.scrollIntoView = vi.fn();
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(last.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(first.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(document.activeElement).toBe(search);
  });

  it("shows Russian labels without translating project names", () => {
    render(<NewChatSwitcher projects={projects} locale="ru" openNewThread={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Новый чат" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menu", { name: "Недавние проекты" })).toBeTruthy();
    expect(screen.getByText("Новый чат в проекте")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "First project" })).toBeTruthy();
  });

  it("opens the native new-thread screen on click", () => {
    const openNewThread = vi.fn();
    render(<NewChatSwitcher projects={projects} openNewThread={openNewThread} />);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(openNewThread).toHaveBeenCalledWith({ focusPrompt: true });
    expect(screen.queryByRole("menu", { name: "Recent projects" })).toBeNull();
  });

  it("waits 300ms, cancels an abandoned hover, and chooses a project", async () => {
    vi.useFakeTimers();
    const openNewThread = vi.fn();
    render(<NewChatSwitcher projects={projects} openNewThread={openNewThread} />);
    const trigger = screen.getByRole("button", { name: "New chat" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.queryByRole("menu", { name: "Recent projects" })).toBeNull();
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole("menu", { name: "Recent projects" })).toBeNull();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole("menu", { name: "Recent projects" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Second project" }));
    expect(openNewThread).toHaveBeenCalledWith({ projectId: "p2", focusPrompt: true });
  });

  it("shows fifteen projects and reveals the next page after 300ms or click", async () => {
    vi.useFakeTimers();
    const manyProjects = Array.from({ length: 33 }, (_, index) => ({
      id: `project-${index}`,
      name: `Project ${index}`,
      isPersonal: false,
    }));
    render(<NewChatSwitcher projects={manyProjects} openNewThread={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "New chat" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getAllByRole("menuitem")).toHaveLength(16);
    const more = screen.getByRole("menuitem", { name: "Show 15 more projects" });
    fireEvent.pointerEnter(more, { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.getAllByRole("menuitem")).toHaveLength(16);
    fireEvent.pointerLeave(more, { pointerType: "mouse", relatedTarget: screen.getByRole("menu") });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getAllByRole("menuitem")).toHaveLength(16);
    fireEvent.pointerEnter(more, { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getAllByRole("menuitem")).toHaveLength(31);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show 3 more projects" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(33);
  });

  it("does not open on touch hover and supports keyboard discovery", async () => {
    vi.useFakeTimers();
    render(<NewChatSwitcher projects={projects} openNewThread={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "New chat" });
    fireEvent.pointerEnter(trigger, { pointerType: "touch" });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("menu", { name: "Recent projects" })).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menu", { name: "Recent projects" })).toBeTruthy();
  });
});
