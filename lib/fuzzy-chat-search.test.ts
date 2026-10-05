import { describe, expect, it } from "vitest";
import { fuzzyChatSearch } from "./fuzzy-chat-search";

const chats = [
  { title: "Prepare the release" },
  { title: "Release notes" },
  { title: "Review migration plan" },
  { title: "Café checklist" },
];

describe("fuzzy chat search", () => {
  it("finds chats by project name without requiring a title match", () => {
    const items = [
      { title: "Prepare deployment", projectName: "Office CRM" },
      { title: "Fix login", projectName: "Office CRM" },
      { title: "Prepare deployment", projectName: "Personal tools" },
    ];
    expect(fuzzyChatSearch(items, "office")).toEqual(items.slice(0, 2));
    expect(fuzzyChatSearch(items, "OFFICE login")).toEqual([items[1]]);
    expect(fuzzyChatSearch(items, "deployment")).toEqual([items[0], items[2]]);
  });

  it("supports Cyrillic and accent-insensitive project matches without joining fields", () => {
    const items = [{ title: "Обновить сервер", projectName: "Офис Café" }];
    expect(fuzzyChatSearch(items, "офис сервер")).toEqual(items);
    expect(fuzzyChatSearch(items, "cafe")).toEqual(items);
    expect(fuzzyChatSearch([{ title: "ab", projectName: "cd" }], "abcd")).toEqual([]);
  });

  it("matches full Cyrillic titles, version fragments, and punctuation", () => {
    const title = "Обновить систему до версии 0.43.3 — office";
    const items = [{ title }];
    for (const query of [title, "43", "0.43.3", "обновить office"]) {
      expect(fuzzyChatSearch(items, query), query).toEqual(items);
    }
  });
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
