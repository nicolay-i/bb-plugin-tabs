import { describe, expect, it } from "vitest";
import { fuzzyChatSearch } from "./fuzzy-chat-search";

const chats = [
  { title: "Prepare the release" },
  { title: "Release notes" },
  { title: "Review migration plan" },
  { title: "Café checklist" },
];

describe("fuzzy chat search", () => {
  it("prioritizes prefix and word matches before subsequences", () => {
    expect(fuzzyChatSearch(chats, "release").map((chat) => chat.title)).toEqual([
      "Release notes", "Prepare the release",
    ]);
    expect(fuzzyChatSearch(chats, "rmp").map((chat) => chat.title)).toEqual([
      "Review migration plan",
    ]);
  });

  it("matches case-insensitively across multiple words and caps results", () => {
    expect(fuzzyChatSearch(chats, "RELEASE notes")[0]?.title).toBe("Release notes");
    expect(fuzzyChatSearch(chats, "CAFE")[0]?.title).toBe("Café checklist");
    expect(fuzzyChatSearch(chats, "release", 1)).toHaveLength(1);
    expect(fuzzyChatSearch(chats, "")).toEqual([]);
  });
});
