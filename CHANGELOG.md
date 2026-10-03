# Changelog

All notable changes to Chat Tabs are documented here.

## Unreleased

## 0.1.6

### Added

- A localized settings panel in all 15 interface languages. Labels, descriptions, Auto, and position choices update immediately. Validated setting patches preserve existing keys, values, and CLI compatibility; the native English form remains a fallback when the custom section is absent.
- An **Include archived chats in search** checkbox, disabled by default. Archived matches keep struck-through titles and an Archived status without an icon or selection background; deleted and hidden chats remain excluded.

### Fixed

- Setting labels and descriptions now explain what enabling each option shows, where it appears, and what remains when disabled. The language setting explicitly describes Auto mode, and archived-search help explains that archived results cannot be opened here.
- Chat-title search now includes all available BB chats (optionally including archived chats), not just pins and the last 100 plugin-history entries. Older chats and numeric version fragments such as `43` in `0.43.3` are searchable through a paginated metadata lookup with a 250 ms debounce and 30-second cache.
- Archived and deleted history entries no longer receive an accidental selection background or a separate icon. Their struck-through titles and second-line status remain, and the entries stay disabled.

## 0.1.5

### Added

- Fifteen interface languages: English, Russian, Spanish, Brazilian Portuguese, French, German, Simplified Chinese, Hindi, Arabic, Japanese, Indonesian, Turkish, Korean, Vietnamese, and Italian. Auto follows the supported BB page language, then the browser language, with English as fallback.
- A compact **?** indicator when BB is waiting for a question answer or approval, including in nested chats. A tooltip explains the pending input; lists and pinned cards show the full **Needs input** status instead of **Working**.
- A theme-aware SVG icon for the plugin settings and catalog.

### Fixed

- A newly created chat immediately receives its preview tab, even before it reaches the sidebar. Explicitly closed previews still stay closed.
- Static plugin setting labels and descriptions remain in English, without bilingual duplicates.
- The pending-input marker no longer truncates to an unreadable text badge or crowds the chat title.

### Notes

- Additional language packs are machine-assisted first drafts; native-speaker review is recommended.

## 0.1.4

### Fixed

- Hover-open chat lists dismiss when the pointer leaves; clicking the trigger keeps the list open until another trigger click, an outside click, or normal selection/dismissal.
- Moving the pointer over chat items no longer steals focus from the search input; hover highlighting remains visible independently of focus.
- Arrow-key navigation works in both the unfiltered chat list and search results while preserving input focus; Enter opens the selected chat.
- The history **More** label now uses the same font size as ordinary chat titles.

## 0.1.3 — 2026-09-28

### Fixed

- Closing a temporary preview now persists across page reloads and other windows. Stale clients can no longer recreate a closed tab through automatic sync; explicitly opening the chat still restores it.
- Background activity no longer opens temporary tabs; only navigation to an unpinned chat does.

## 0.1.2 — 2026-09-27

### Fixed

- Pinning the current preview no longer causes background activity in another chat to open a new temporary tab. Only opening an unpinned chat creates or replaces the preview; background work remains visible in history and working indicators.

## 0.1.1 — 2026-09-27

### Added

- A borderless **New chat** button after the last tab. Hover to choose a recently active project; groups of 15 projects load through **More**.
- A searchable chat list with fuzzy title matching, arrow-key selection, Enter to open, and a double-Shift shortcut that also works while the chat composer has focus.
- Plugin-owned recent chat history, with pagination and clear Archived/Deleted entries.
- Real BB screenshots showing the tab strip, project picker, chat list, and optional pinned-chat home section.

### Improved

- More compact, theme-aware tabs and menus with reduced-motion support; hover-to-open and **More** use a 300 ms delay.
- The current conversation retains or recovers its temporary preview tab when sidebar data is incomplete or plugin state changes.
- Working and unread indicators, nested-chat activity handling, tab navigation, drag and drop, touch behavior, and lifecycle reconciliation.
- Refined interface text, documentation, and examples.

## 0.1.0 — initial public release

- Introduced pinned chats and a single temporary preview tab in a BB plugin.
- Published the first immutable `v0.1.0` Git tag. Its commit and history are unchanged.
