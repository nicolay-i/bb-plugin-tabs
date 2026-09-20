import { describe, expect, it } from "vitest";
import { chatStatusFor } from "./chat-status";

describe("короткий статус чата", () => {
  it("не создаёт декоративный статус для спокойного чата", () => {
    expect(chatStatusFor({ isWorking: false, isUnread: false })).toBeNull();
  });

  it("обозначает выполняющуюся работу коротким названием", () => {
    expect(chatStatusFor({ isWorking: true, isUnread: false })).toEqual({
      kind: "working",
      text: "Работает",
    });
  });

  it("сохраняет непрочитанность и объединяет её с работой", () => {
    expect(chatStatusFor({ isWorking: false, isUnread: true })).toEqual({
      kind: "unread",
      text: "Непрочитанное",
    });
    expect(chatStatusFor({ isWorking: true, isUnread: true })).toEqual({
      kind: "working",
      text: "Работает · Непрочитанное",
    });
  });
});
