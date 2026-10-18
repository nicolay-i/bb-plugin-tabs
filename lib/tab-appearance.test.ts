import { describe, expect, it } from "vitest";
import {
  appearanceSettingSchema,
  appearanceUpdateSchema,
  defaultTabAppearance,
  readTabAppearance,
  tabAppearanceColor,
  tabAppearanceTitle,
  updateTabAppearance,
} from "./tab-appearance";

describe("tab appearance", () => {
  it("adds empty project rows idempotently and removes only the chosen project's metadata", () => {
    let appearance = updateTabAppearance(defaultTabAppearance(), {
      kind: "project-add",
      projectId: "p",
    });
    expect(appearance.projects.p).toEqual({ alias: "", color: null });
    appearance = updateTabAppearance(appearance, {
      kind: "project",
      projectId: "p",
      alias: "API",
      color: 2,
    });
    appearance = updateTabAppearance(appearance, { kind: "project-add", projectId: "p" });
    expect(appearance.projects.p).toEqual({ alias: "API", color: 2 });
    appearance = updateTabAppearance(appearance, { kind: "project-add", projectId: "other" });
    appearance = updateTabAppearance(appearance, { kind: "tab", threadId: "t", color: 1 });
    const removed = updateTabAppearance(appearance, { kind: "project-remove", projectId: "p" });
    expect(removed.projects).toEqual({ other: { alias: "", color: null } });
    expect(removed.tabs).toEqual({ t: 1 });
    expect(removed.palette).toEqual(appearance.palette);
    expect(appearance.projects.p).toEqual({ alias: "API", color: 2 });
    expect(
      appearanceUpdateSchema.safeParse({ kind: "project-remove", projectId: "p", alias: "bad" })
        .success,
    ).toBe(false);
  });
  it("keeps legacy defaults and rejects malformed, unbounded and prototype settings", () => {
    expect(readTabAppearance(undefined)).toEqual(defaultTabAppearance());
    expect(readTabAppearance("broken")).toBeNull();
    for (const value of [
      { ...defaultTabAppearance(), palette: ["red"] },
      { ...defaultTabAppearance(), tabs: { t: 6 } },
      { ...defaultTabAppearance(), projects: { p: { alias: "x".repeat(33), color: null } } },
      { ...defaultTabAppearance(), projects: JSON.parse('{"__proto__":{"alias":"x","color":0}}') },
    ])
      expect(appearanceSettingSchema.safeParse(JSON.stringify(value)).success).toBe(false);
    expect(readTabAppearance(" ".repeat(128 * 1024 + 1))).toBeNull();
    for (const patch of [
      { kind: "tab", threadId: "t", color: 6 },
      { kind: "project", projectId: "p", alias: "a\nb" },
      { kind: "project", projectId: "constructor", alias: "x" },
      { kind: "palette", colors: [{ index: 0, color: "url(evil)" }] },
      {
        kind: "palette",
        colors: [
          { index: 0, color: "#ffffff" },
          { index: 0, color: "#000000" },
        ],
      },
    ])
      expect(appearanceUpdateSchema.safeParse(patch).success).toBe(false);
  });

  it("merges independent fields, inherits project colors and removes overrides without renaming chats", () => {
    const original = defaultTabAppearance();
    let appearance = updateTabAppearance(original, {
      kind: "project",
      projectId: "p",
      alias: "API",
      color: 0,
    });
    appearance = updateTabAppearance(appearance, { kind: "tab", threadId: "t", color: 1 });
    appearance = updateTabAppearance(appearance, { kind: "project", projectId: "p", alias: "NEW" });
    appearance = updateTabAppearance(appearance, {
      kind: "palette",
      colors: [{ index: 1, color: "#123456" }],
    });
    expect(appearance.projects.p).toEqual({ alias: "NEW", color: 0 });
    expect(tabAppearanceTitle(appearance, "p", "Real title")).toBe("[NEW] Real title");
    expect(tabAppearanceColor(appearance, "t", "p")).toBe("#123456");
    appearance = updateTabAppearance(appearance, { kind: "tab", threadId: "t", color: null });
    expect(tabAppearanceColor(appearance, "t", "p")).toBe(original.palette[0]);
    appearance = updateTabAppearance(appearance, {
      kind: "project",
      projectId: "p",
      alias: "",
      color: null,
    });
    expect(appearance.projects.p).toEqual({ alias: "", color: null });
    appearance = updateTabAppearance(appearance, { kind: "project-remove", projectId: "p" });
    expect(appearance.projects).toEqual({});
    expect(tabAppearanceColor(appearance, "t", "p")).toBeUndefined();
    expect(tabAppearanceTitle(appearance, "p", "Real title")).toBe("Real title");
    expect(original).toEqual(defaultTabAppearance());
  });
});
