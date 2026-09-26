import { describe, expect, it } from "vitest";
import { chatStatusFor } from "./chat-status";

describe("Chat Tabs", () => {
  it("handles behavior 1", () => {
    expect(chatStatusFor({ isWorking: false, isUnread: false })).toBeNull();
  });

  it("handles behavior 2", () => {
    expect(chatStatusFor({ isWorking: true, isUnread: false })).toEqual({
      kind: "working",
      text: "Working",
    });
  });

  it("handles behavior 3", () => {
    expect(chatStatusFor({ isWorking: false, isUnread: true })).toEqual({
      kind: "unread",
      text: "Unread",
    });
    expect(chatStatusFor({ isWorking: true, isUnread: true })).toEqual({
      kind: "working",
      text: "Working · Unread",
    });
  });
});
