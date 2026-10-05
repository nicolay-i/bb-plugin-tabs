// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const styles = await readFile(`${process.cwd()}/tabs.css`, "utf8");

describe("Chat Tabs", () => {
  it("limits replacement settings checks to the host form panel", () => {
    const selector = styles.match(
      /\[data-testid="plugin-detail-tabs"\]:has\(\.bb-chat-tabs-settings\)\s*>\s*([^{}]+)\{/u,
    )?.[1]?.trim();
    expect(selector).toBe(
      ".overflow-hidden:first-child:not(:has(.bb-chat-tabs-settings))",
    );
  });
  it.each([
    {
      name: "hides the host panel while replacement settings are mounted",
      html: '<div data-testid="plugin-detail-tabs"><div class="overflow-hidden" id="host"></div><div class="bb-chat-tabs-settings"></div></div>',
      expected: ["host"],
    },
    {
      name: "keeps the fallback visible without replacement settings",
      html: '<div data-testid="plugin-detail-tabs"><div class="overflow-hidden" id="host"></div></div>',
      expected: [],
    },
    {
      name: "does not hide a panel containing replacement settings",
      html: '<div data-testid="plugin-detail-tabs"><div class="overflow-hidden" id="host"><div class="bb-chat-tabs-settings"></div></div></div>',
      expected: [],
    },
    {
      name: "does not affect another plugin",
      html: '<div data-testid="plugin-detail-other"><div class="overflow-hidden" id="host"></div><div class="bb-chat-tabs-settings"></div></div>',
      expected: [],
    },
    {
      name: "does not match generic first children or later panels",
      html: '<div data-testid="plugin-detail-tabs"><div id="generic"></div><div class="overflow-hidden" id="later"></div><div class="bb-chat-tabs-settings"></div></div>',
      expected: [],
    },
  ])("$name", ({ html, expected }) => {
    const selector = styles.match(
      /(\[data-testid="plugin-detail-tabs"\]:has\(\.bb-chat-tabs-settings\)\s*>\s*[^{}]+)\{/u,
    )?.[1]?.trim();
    expect(selector).toBeDefined();
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(Array.from(root.querySelectorAll(selector!), (element) => element.id)).toEqual(expected);
  });
  it("highlights pointer hover independently of menu item focus", () => {
    expect(styles).toContain('.bb-chat-tabs-list-menu-item:not([data-disabled]):hover,');
    expect(styles).toContain('.bb-chat-tabs-list-menu-more:hover,');
    expect(styles).toMatch(/\.bb-chat-tabs-list-menu-item\[data-selected="true"\]\s*\{[^}]*background: var\(--muted\);/u);
  });
  it("handles behavior 1", () => {
    const strip = styles.match(
      /\.bb-chat-tabs-strip\s*\{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(strip).toContain("display: flex;");
    expect(strip).toContain("gap: 0.375rem;");
    expect(strip).toContain("overflow-x: auto;");
    expect(strip).toContain("overflow-y: hidden;");
    expect(styles).not.toContain(".bb-chat-tabs-project-tabs");
    expect(styles).not.toContain(".bb-chat-tabs-project {");
    expect(styles).toContain("flex: 0 0 9rem;");
    expect(styles).not.toContain('#bb-chat-tabs-overlay[data-row-count="3"]');
  });

  it("handles behavior 2", () => {
    expect(styles).toMatch(
      /\.bb-chat-tab-action\s*\{[\s\S]*?margin-inline-end: 0\.25rem;/u,
    );
  });

  it("handles behavior 3", () => {
    expect(styles).toContain('.bb-chat-tab[data-dragging="true"]');
    expect(styles).toContain("opacity: 0.52;");
    expect(styles).toContain(".bb-chat-tab-drop-slot {");
    expect(styles).toContain(
      '.bb-chat-tabs-strip[data-dragging="true"] .bb-chat-tab-drop-slot',
    );
    expect(styles).toContain("flex: 0 0 0;");
    expect(styles).toContain("margin-inline: -0.1875rem;");
    expect(styles).not.toContain("gap: 0;");
    expect(styles).toContain(
      '.bb-chat-tab-drop-slot[data-active="true"] .bb-chat-tab-drop-slot-hit::before',
    );
    expect(styles).not.toContain('.bb-chat-tab[data-drop-position]');
    expect(styles).toContain("background: var(--ring, var(--primary));");
  });

  it("handles behavior 4", () => {
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(styles).toContain("var(--background)");
    expect(styles).toContain("var(--foreground)");
    expect(styles).toContain("var(--muted)");
    expect(styles).toContain("var(--border)");
    expect(styles).toContain("var(--primary)");
    expect(styles).toContain("var(--popover");
    expect(styles).toContain("--bb-chat-tabs-status-working: var(--foreground);");
    expect(styles).toContain("--bb-chat-tabs-status-working-dot: color-mix(");
    expect(styles).toContain("var(--primary) 45%");
    expect(styles).toContain("--bb-chat-tabs-status-unread");
    expect(styles).toContain("color-mix(in oklch");
  });

  it("handles behavior 5", () => {
    expect(styles).toContain("--bb-chat-tabs-active-background: color-mix(");
    expect(styles).toContain("var(--foreground) 20%");
    expect(styles).toContain("--bb-chat-tabs-active-border:");
    expect(styles).toContain(".dark {");
    expect(styles).toMatch(
      /\.dark\s*\{[\s\S]*?--bb-chat-tabs-active-background:\s*color-mix\([\s\S]*?var\(--foreground\) 12%/u,
    );
    expect(styles).not.toContain(
      "--bb-chat-tabs-active-background: var(--foreground);",
    );
  });

  it("handles behavior 6", () => {
    expect(styles).toMatch(
      /\.bb-chat-tabs-top-scrollbar\s*\{[\s\S]*?overflow-x: scroll;/u,
    );
    expect(styles).toMatch(
      /\.bb-chat-tabs-top-scrollbar\s*\{[\s\S]*?scrollbar-width: thin;/u,
    );
    expect(styles).toContain("--bb-chat-tabs-scrollbar-track:");
    expect(styles).toContain("--bb-chat-tabs-scrollbar-thumb:");
    expect(styles).toMatch(
      /\.bb-chat-tabs-top-scrollbar::-webkit-scrollbar\s*\{[\s\S]*?height: 0\.5rem;/u,
    );
    expect(styles).toContain(".bb-chat-tabs-strip::-webkit-scrollbar {");
    expect(styles).toContain("display: none;");
    expect(styles).toContain(
      '.bb-chat-tabs-shell[data-scrollable="false"] .bb-chat-tabs-top-scrollbar',
    );
    expect(styles).toContain("--bb-chat-tabs-strip-height: 38px;");
    expect(styles).toContain("--bb-chat-tabs-strip-height: 48px;");
    expect(styles).toMatch(/\.bb-chat-tabs-strip\s*\{[^}]*padding: 0\.25rem 0\.5rem;/u);
    expect(styles).not.toMatch(/\.bb-chat-tabs-shell\s*\{[^}]*border-bottom:/u);
    expect(styles).toContain("background: var(--bb-chat-tabs-scrollbar-track);");
    expect(styles).toContain("background: var(--bb-chat-tabs-scrollbar-thumb);");
  });

  it("handles behavior 7", () => {
    expect(styles).toContain(".bb-chat-tabs-homepage-pinned-list");
    expect(styles).toContain("section:has(");
    expect(styles).toContain('[data-bb-plugin="tabs"]');
    expect(styles).toContain('data-visible="false"');
    expect(styles).toContain(".bb-chat-tabs-homepage-pinned-items {");
    expect(styles).toContain("grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));");
    expect(styles).toContain("max-height: 18rem;");
    expect(styles).toContain(".bb-chat-tabs-homepage-pinned-meta {");
    expect(styles).toMatch(
      /\.bb-chat-tabs-homepage-pinned-project\s*\{[\s\S]*?min-width: 0;[\s\S]*?flex: 1 1 auto;/u,
    );
    expect(styles).toContain("max-width: 68%;");
    expect(styles).toContain(
      ".bb-chat-tabs-homepage-pinned-status[data-status=\"working\"]",
    );
    expect(styles).toContain(
      ".bb-chat-tabs-homepage-pinned-status[data-status=\"unread\"]",
    );
    expect(styles).not.toContain(".bb-chat-tabs-pinned-list-trigger {");
    expect(styles).not.toContain(".bb-chat-tabs-pinned-list-menu {");
  });

  it("handles behavior 8", () => {
    expect(styles).toMatch(
      /\.bb-chat-tab-context-menu\s*\{[\s\S]*?min-width: 7rem;/u,
    );
    expect(styles).toMatch(
      /\.bb-chat-tab-context-menu\s*\{[\s\S]*?border-radius: 0\.375rem;/u,
    );
    expect(styles).not.toContain("min-width: 14rem;");
    expect(styles).toMatch(
      /\.bb-chat-tab-context-menu-item\s*\{[\s\S]*?padding: 0\.3125rem 0\.5rem;/u,
    );
    expect(styles).toMatch(
      /\.bb-chat-tab-context-menu-item\s*\{[\s\S]*?font-size: 0\.75rem;/u,
    );
    expect(styles).toContain(".bb-chat-tab-context-menu-item > svg {");
    expect(styles).toContain("width: 1rem;");
    expect(styles).toContain("margin: 0.25rem -0.25rem;");
  });

  it("handles behavior 9", () => {
    expect(styles).toContain(".bb-chat-tab-inline-rename {");
    expect(styles).toContain(".bb-chat-tab-title {\n  cursor: pointer;\n}");
    expect(styles).toMatch(
      /\.bb-chat-tab-inline-rename\s*\{[\s\S]*?cursor: text;/u,
    );
    expect(styles).toContain(".bb-chat-tab-context-menu {");
    expect(styles).toContain("background: var(--popover, var(--background));");
    expect(styles).toContain(".bb-chat-tab-rename-dialog {");
    expect(styles).toContain(".bb-chat-tab-rename-overlay {");
  });

  it("handles behavior 10", () => {
    expect(styles).toContain(".bb-chat-tab-unread {");
    expect(styles).toContain("background: var(--bb-chat-tabs-status-unread);");
    expect(styles).toContain(
      '.bb-chat-tab[data-active="true"] .bb-chat-tab-unread',
    );
  });

  it("handles behavior 11", () => {
    expect(styles).toContain(
      "[data-thread-window]:not(aside [data-thread-window])",
    );
    expect(styles).toContain("position-anchor: --bb-chat-tabs-thread-window");
  });

  it("handles behavior 12", () => {
    expect(styles).toContain(
      ":not(:has([data-split-resize-grid-boundary]))",
    );
    expect(styles).not.toContain(":not(:has([data-split-pane-id]))");
    expect(styles).toContain(
      "padding-block-start: var(--bb-chat-tabs-strip-height);",
    );
  });

  it("handles behavior 13", () => {
    expect(styles).toContain(".bb-chat-tabs-list-switcher {");
    expect(styles).toContain('.bb-chat-tabs-list-switcher[data-position="right"]');
    expect(styles).toContain("padding: 0.25rem 0.5rem 0.25rem 0;");
    expect(styles).toContain(".bb-chat-tabs-list-trigger {");
    expect(styles).toContain(".bb-chat-tabs-new-trigger {");
    expect(styles).toMatch(/\.bb-chat-tabs-new-trigger\s*\{[^}]*background: transparent;[^}]*border: 0;/u);
    expect(styles).toMatch(/\.bb-chat-tabs-new-switcher\s*\{[^}]*align-items: center;\s*\}/u);
    expect(styles).toContain('.bb-chat-tabs-list-menu[data-state="closed"]');
    expect(styles).toContain('.bb-chat-tabs-new-menu[data-state="closed"]');
    expect(styles).toContain('.bb-chat-tabs-new-menu-more[data-pending="true"]::after');
    expect(styles).toContain('.bb-chat-tabs-list-menu-search-input {');
    expect(styles).toContain('.bb-chat-tabs-list-menu-item[data-selected="true"]');
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toMatch(/\.bb-chat-tabs-list-trigger\s*\{[^}]*width: var\(--bb-chat-tabs-tab-height\);[^}]*height: var\(--bb-chat-tabs-tab-height\);/u);
    expect(styles).toMatch(/\.bb-chat-tab\s*\{[^}]*height: var\(--bb-chat-tabs-tab-height\);/u);
    expect(styles).toContain(".bb-chat-tabs-list-menu {");
    expect(styles).toContain(".bb-chat-tabs-list-menu-meta {");
    expect(styles).toMatch(
      /\.bb-chat-tabs-list-menu-project\s*\{[\s\S]*?min-width: 0;[\s\S]*?flex: 1 1 auto;/u,
    );
    expect(styles).toContain(".bb-chat-tabs-list-menu-status-dot {");
    expect(styles).toContain(".bb-chat-tabs-list-menu-item[data-disabled] {");
    expect(styles).toContain("cursor: not-allowed;");
    expect(styles).not.toContain(".bb-chat-tabs-list-menu-unavailable-icon");
    expect(styles).toMatch(/\.bb-chat-tabs-list-menu-item\[data-disabled\]\s*\{[^}]*background: transparent;/u);
    expect(styles).toContain(".bb-chat-tabs-list-menu-title[data-unavailable] {");
    expect(styles).toContain("text-decoration-line: line-through;");
    expect(styles).toContain(".bb-chat-tabs-list-menu-unavailable-label {");
    expect(styles).toContain("max-height: min(\n    44rem,");
    expect(styles).toContain("--radix-dropdown-menu-content-available-height");
    expect(styles).not.toContain(".bb-chat-tabs-mobile-switcher");
    expect(styles).not.toContain(".bb-chat-tabs-mobile-switcher-select");
    expect(styles).toContain("@media (max-width: 767px), (pointer: coarse)");
    expect(styles).toContain(
      '#bb-chat-tabs-overlay[data-docked="true"] {\n    z-index: 31;\n    display: block;',
    );
    expect(styles).toContain('[data-sidebar-shelf="open"]');
    expect(styles).toContain('[data-panel-shelf="shelf"]');
    expect(styles).toContain('[data-panel-shelf="full"]');
    expect(styles).toContain("--bb-chat-tabs-strip-height: 3.5rem;");
    expect(styles).toContain("padding: 0.375rem 0.5rem;");
    expect(styles).toContain("--bb-chat-tabs-tab-height: 2.75rem;");
    expect(styles).toContain("scroll-snap-type: x proximity;");
    expect(styles).toContain("-webkit-overflow-scrolling: touch;");
    expect(styles).toContain("width: 2.75rem;");
    expect(styles).toContain("min-height: 2.75rem;");
    expect(styles).toMatch(
      /\.bb-chat-tabs-list-menu-more\s*\{[^}]*font-size: 0\.75rem;[^}]*font-weight: 500;[^}]*line-height: 1rem;/u,
    );
    expect(styles).toContain(
      ".bb-chat-tabs-list-menu-history-page-separator {",
    );
    expect(styles).toContain(
      "background: color-mix(in oklch, var(--foreground) 20%, var(--border));",
    );
    expect(styles).toContain('data-pending="true"');
    expect(styles).toContain("bb-chat-tabs-history-more-progress 300ms linear forwards");
    expect(styles).toContain(".bb-chat-tab-drop-slot {\n    display: none !important;");
  });
});
