// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewChatSwitcher } from "./new-chat-switcher";

const projects = [
  { id: "p1", name: "First project", isPersonal: false },
  { id: "p2", name: "Second project", isPersonal: false },
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("New chat switcher", () => {
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
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(screen.queryByRole("menu", { name: "Recent projects" })).toBeNull();
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.queryByRole("menu", { name: "Recent projects" })).toBeNull();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.getByRole("menu", { name: "Recent projects" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Second project" }));
    expect(openNewThread).toHaveBeenCalledWith({ projectId: "p2", focusPrompt: true });
  });

  it("shows fifteen projects and reveals the next page after 300ms or click", async () => {
    vi.useFakeTimers();
    const manyProjects = Array.from({ length: 33 }, (_, index) => ({
      id: `project-${index}`, name: `Project ${index}`, isPersonal: false,
    }));
    render(<NewChatSwitcher projects={manyProjects} openNewThread={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "New chat" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.getAllByRole("menuitem")).toHaveLength(16);
    const more = screen.getByRole("menuitem", { name: "Show 15 more projects" });
    fireEvent.pointerEnter(more, { pointerType: "mouse" });
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(screen.getAllByRole("menuitem")).toHaveLength(16);
    fireEvent.pointerLeave(more, { pointerType: "mouse", relatedTarget: screen.getByRole("menu") });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.getAllByRole("menuitem")).toHaveLength(16);
    fireEvent.pointerEnter(more, { pointerType: "mouse" });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.getAllByRole("menuitem")).toHaveLength(31);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show 3 more projects" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(33);
  });

  it("does not open on touch hover and supports keyboard discovery", async () => {
    vi.useFakeTimers();
    render(<NewChatSwitcher projects={projects} openNewThread={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "New chat" });
    fireEvent.pointerEnter(trigger, { pointerType: "touch" });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.queryByRole("menu", { name: "Recent projects" })).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menu", { name: "Recent projects" })).toBeTruthy();
  });
});
