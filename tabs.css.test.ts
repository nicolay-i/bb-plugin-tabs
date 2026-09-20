import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const styles = await readFile(new URL("./tabs.css", import.meta.url), "utf8");

describe("CSS-геометрия верхних вкладок", () => {
  it("оставляет вручную отсортированные вкладки в одной горизонтальной линии", () => {
    const strip = styles.match(
      /\.bb-chat-tabs-strip\s*\{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(strip).toContain("display: flex;");
    expect(strip).toContain("gap: 0.375rem;");
    expect(strip).toContain("overflow-x: auto;");
    expect(strip).toContain("overflow-y: hidden;");
    expect(styles).not.toContain(".bb-chat-tabs-project-tabs");
    expect(styles).not.toContain(".bb-chat-tabs-project {");
    expect(styles).toContain("flex: 0 0 11rem;");
    expect(styles).not.toContain('#bb-chat-tabs-overlay[data-row-count="3"]');
  });

  it("оставляет у Close безопасный правый отступ внутри tab", () => {
    expect(styles).toMatch(
      /\.bb-chat-tab-action\s*\{[\s\S]*?margin-inline-end: 0\.25rem;/u,
    );
  });

  it("показывает одну активную щель, а не две половины tab при drag-and-drop", () => {
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

  it("не содержит жёстких цветов и опирается на токены BB темы", () => {
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

  it("делает активную поверхность нейтрально-серой из токенов темы", () => {
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

  it("показывает theme-aware горизонтальную scrollbar сверху", () => {
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
    expect(styles).toContain("--bb-chat-tabs-strip-height: 46px;");
    expect(styles).toContain("background: var(--bb-chat-tabs-scrollbar-track);");
    expect(styles).toContain("background: var(--bb-chat-tabs-scrollbar-thumb);");
  });

  it("выводит быстрый список закреплённых чатов под root composer", () => {
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

  it("повторяет компактную геометрию context menu из native sidebar", () => {
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

  it("стилизует inline rename, context menu и rename modal токенами темы", () => {
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

  it("рисует отдельную theme-derived точку для непрочитанных сообщений", () => {
    expect(styles).toContain(".bb-chat-tab-unread {");
    expect(styles).toContain("background: var(--bb-chat-tabs-status-unread);");
    expect(styles).toContain(
      '.bb-chat-tab[data-active="true"] .bb-chat-tab-unread',
    );
  });

  it("привязывает overlay к main chat pane, а не к правому aside", () => {
    expect(styles).toContain(
      "[data-thread-window]:not(aside [data-thread-window])",
    );
    expect(styles).toContain("position-anchor: --bb-chat-tabs-thread-window");
    expect(styles).toContain("Правый `<aside>` намеренно исключён");
  });

  it("оставляет место под overlay при одиночном leaf правой панели", () => {
    expect(styles).toContain(
      ":not(:has([data-split-resize-grid-boundary]))",
    );
    expect(styles).not.toContain(":not(:has([data-split-pane-id]))");
    expect(styles).toContain(
      "padding-block-start: var(--bb-chat-tabs-strip-height);",
    );
    expect(styles).toContain(
      "Одиночный leaf правой панели тоже несёт `[data-split-pane-id]`",
    );
  });

  it("даёт единый icon-trigger и подменю списка на desktop и compact/mobile", () => {
    expect(styles).toContain(".bb-chat-tabs-list-switcher {");
    expect(styles).toContain('.bb-chat-tabs-list-switcher[data-position="right"]');
    expect(styles).toContain("padding: 0.125rem 0.5rem 0.25rem 0;");
    expect(styles).toContain(".bb-chat-tabs-list-trigger {");
    expect(styles).toContain(".bb-chat-tabs-list-menu {");
    expect(styles).toContain(".bb-chat-tabs-list-menu-meta {");
    expect(styles).toMatch(
      /\.bb-chat-tabs-list-menu-project\s*\{[\s\S]*?min-width: 0;[\s\S]*?flex: 1 1 auto;/u,
    );
    expect(styles).toContain(".bb-chat-tabs-list-menu-status-dot {");
    expect(styles).toContain(".bb-chat-tabs-list-menu-item[data-disabled] {");
    expect(styles).toContain("cursor: not-allowed;");
    expect(styles).toContain(".bb-chat-tabs-list-menu-unavailable-icon {");
    expect(styles).toContain(".bb-chat-tabs-list-menu-title[data-unavailable] {");
    expect(styles).toContain("text-decoration-line: line-through;");
    expect(styles).toContain(".bb-chat-tabs-list-menu-unavailable-label {");
    expect(styles).toContain("max-height: min(\n    44rem,");
    expect(styles).toContain("--radix-dropdown-menu-content-available-height");
    expect(styles).toContain("Radix portal: подменю остаётся одним и тем же");
    expect(styles).not.toContain(".bb-chat-tabs-mobile-switcher");
    expect(styles).not.toContain(".bb-chat-tabs-mobile-switcher-select");
    expect(styles).toContain("@media (max-width: 767px), (pointer: coarse)");
    expect(styles).toContain(
      '#bb-chat-tabs-overlay[data-docked="true"] {\n    z-index: 31;\n    display: block;',
    );
    expect(styles).toContain("main page inset поднимается в свой слой `z-30`");
    expect(styles).toContain('[data-sidebar-shelf="open"]');
    expect(styles).toContain('[data-panel-shelf="shelf"]');
    expect(styles).toContain('[data-panel-shelf="full"]');
    expect(styles).toContain("--bb-chat-tabs-strip-height: 3.25rem;");
    expect(styles).toContain("scroll-snap-type: x proximity;");
    expect(styles).toContain("-webkit-overflow-scrolling: touch;");
    expect(styles).toContain("width: 2.75rem;");
    expect(styles).toContain("min-height: 2.75rem;");
    expect(styles).toContain(".bb-chat-tabs-list-menu-more {");
    expect(styles).toContain(
      ".bb-chat-tabs-list-menu-history-page-separator {",
    );
    expect(styles).toContain(
      "background: color-mix(in oklch, var(--foreground) 20%, var(--border));",
    );
    expect(styles).toContain('data-pending="true"');
    expect(styles).toContain("bb-chat-tabs-history-more-progress 1s linear forwards");
    expect(styles).toContain(".bb-chat-tab-drop-slot {\n    display: none !important;");
  });
});
