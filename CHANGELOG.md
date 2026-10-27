# Changelog

All notable changes to Chat Tabs are documented here.

## Unreleased

### Added

- Register Chat Tabs commands in the BB palette with rebindable defaults: `Mod+Alt+1…8`/`9` select a tab or the last one, `Mod+Alt+P` pins, `Mod+Alt+S` toggles a favorite, `Mod+Alt+W` cycles workspaces, and `F2` renames. Letter defaults match the physical key in Russian and Option layouts. Parent chat, subthread tree, tab list, copy link, close others, move, cycle, and restore are palette-only.

### Fixed

- Open the chat list only after two clean Shift presses; any other key, pointer press, window blur, IME composition, or key repeat in between cancels the gesture.
- Count only working descendants on the subthread button; unread subthread dots stay inside the tree menu instead of looking like activity on the tab.

## 0.1.15

### Added

- Show nested chats in side-opening submenus of the chat list by default, with a setting to return to a flat list. Search results remain directly accessible as a flat list; known ancestors preserve access to nested pins and history.
- Search all available recent projects by name or alias from the New chat menu, including keyboard selection and automatic reveal of the selected result without moving search focus.
- Restore the last explicitly selected workspace on the same browser/device after reopening BB, while keeping existing windows independent. Catalog refreshes and old-window reloads do not overwrite another window's choice.

### Changed

- Keep New chat immediately beside the tabs and inside the available window bounds. Desktop tabs expand up to 1.5 times their previous width, shrink back as space fills, and then scroll horizontally; compact surfaces keep their touch-layout minimum.

### Security

- Update Zod, Vitest/mocker, Hono, Vite, Undici and their required transitive dependencies within the existing version ranges to address reported advisories. Keep the BB SDK pin unchanged.

## 0.1.14

### Added

- Manage project aliases/colors in a modal with a searchable list, autocomplete addition, editing, and confirmed removal from the list only. Empty project rows persist until explicitly removed; native BB projects/chats and individual tab colors are untouched. Pending saves lock portalled controls/dismissal, errors stay inside the modal, and unsaved drafts survive closing/reopening.
- Split settings into keyboard-accessible General/Appearance tabs without losing unsaved drafts. Add a single project autocomplete with local name/alias search, keyboard/touch selection and recent-activity ordering to the appearance editor, keeping inactive and personal projects available. Typing alone never changes the edited project or saves its draft.
- Local appearance prototype: a six-color settings palette, project alias prefixes and inherited colors in the strip, with individual tab overrides in the context menu. Field patches merge across windows without renaming native projects/chats or changing workspace memberships.

### Fixed

- Keep mobile language and tab-list-position selects at least 44px high, matching the existing appearance controls without changing desktop sizes.
- Keep all 15 language autonyms in one stable alphabetical list after Auto, with no pinned locale and unchanged stored values. Keep publication descriptions and README screenshots English; update the overview for the appearance preview and internal language settings.
- Avoid document-wide style invalidation when switching chats: replace global `body:has(...)` conditions with one shared, event-driven layout observer, preserving CSS priority, any-overlay semantics, panel/modal/split visibility, and anchor positioning with a coalesced fallback.
- Keep New chat outside the horizontal scroller and give projects with open tabs in the current workspace priority in its menu, preserving activity order within each group and the existing pagination.
- Keep the active tab visible when switching chats or resizing the available strip, including opening or closing BB's right panel, without moving chat focus or resetting manual scroll on status updates.
- Keep the chat menu's Pinned section scoped to the selected Chat Tabs workspace; include pins from other workspaces in the general list below, deduplicated against history and active pins, without changing memberships or recording visits.

### Documentation

- Add linked, self-contained Russian notes for every plugin screen and feature, with current desktop/mobile screenshots and documented state, focus, and failure boundaries.

## 0.1.13

### Changed

- Move workspace selection into the native thread header: show the workspace name on desktop and its first complete Unicode character on compact/mobile, without duplicating it in the tab strip. Keep header controls available when the strip is hidden.
- Restyle workspace management with compact grouped rows, a current-workspace badge, inline rename/delete confirmation, and a separate add form and Done action.
- Animate workspace dialog opening/closing and backdrop fading, respecting reduced-motion preferences.
- Creating a workspace keeps the current workspace, chat, and management dialog open; the new name can be corrected immediately.
- Remove redundant tests and use scope-specific CSS assertions, retaining storage, lifecycle, selection, and focus regressions.

### Fixed

- Workspace deletion buttons use the trash icon instead of the fallback lightning bolt.

## 0.1.12

### Added

- Idle main-chat tabs show a subdued grey activity dot when a sidechat is working, including hidden sidechat forks linked by `sourceThreadId`. Main-chat work retains its regular indicator; lifecycle updates and revision guards keep parallel sidechats and delayed snapshots correct.
- Workspaces can be disabled in settings (enabled by default), temporarily using Work or the first remaining set without deleting other sets or the window’s saved selection.
- Reopen explicitly closed tabs with `Ctrl+Shift+T` / `⌘⇧T`, including from New chat: window-local workspace-scoped LIFO undo, session reload persistence, original position/pin restoration and safe availability/capacity/write-failure handling.
- Configurable Work / Home / Other workspaces with independent pins, manual order, preview, favorites, and closed-tab protection. Create, rename, or confirm deletion of 1–20 sets without deleting chats or shared history. System labels and management controls support all 15 languages; custom names remain unchanged.
- Window-local selection shared by the strip and New chat, restored with session storage and backed by an in-memory fallback. Matching sets synchronize across windows; switching restores the window’s last active tab, falling back to the first tab or New chat for an empty set, without inserting the previous chat into the new preview. Last-active IDs survive reload with a memory fallback; stale switch/route responses cannot navigate.
- Tab context menu **Show in workspaces**: independent checkboxes add the same chat as a pinned tab to several sets or remove it from selected ones without navigation, switching workspace, or removing favorites. Open menus synchronize across windows and preserve pending/error handling.
- Atomic SQLite envelope storage with one-time migration into Work, preserving legacy KV keys. Failed writes and damaged storage do not overwrite the source; the full 20 × (100 tabs + 100 favorites) capacity avoids KV limits.

### Changed

- Coalesce scrollbar measurements into one animation frame, skip search computation while its menu is closed, and avoid redundant navigation to a chat already on screen.

### Fixed

- Lifecycle events take precedence over delayed availability lookups and queued reconciliation, so stale snapshots cannot restore archived tabs or clear newer history tombstones.
- Delayed workspace creation/deletion does not override a newer route, explicit workspace selection, or settings change; deletion still restores its own catalog fallback.
- Tab shortcuts, native desktop close requests, and double-Shift search no longer act behind modal dialogs.
- The left chat-list button now precedes the workspace selector, closer to the strip edge, while retaining the right-position option.
- Workspace trigger has an inset from the strip edge and mouse-hover opening, preserving keyboard/touch operation and chat focus, with gap-safe dismissal and click latching.
- Workspace-addressed request queues, selection generations, tagged realtime events, and persistent snapshot revisions reject delayed or out-of-order responses. Homepage undo cards, pending actions, errors, and delayed navigation stay within their original visit.
- Lifecycle and startup reconciliation inspect inactive sets, deduplicate thread lookups, preserve transient failures, and prevent unarchiving from automatically recreating old preview memberships.

## 0.1.11

### Added

- Subthreads now have a small icon-only branch marker in tabs, homepage cards, pinned lists, history, and search, with a localized tooltip and accessible label. Root chats keep their existing appearance. Parent metadata persists outside the loaded sidebar; legacy history and favorites are enriched by the existing availability lookup.
- New chat cards can now toggle pins and favorites directly, including restoring an accidentally removed chat before leaving the homepage. Changes save immediately while the card stays in place and remains openable until the homepage is reopened. The button is disabled only while saving; failed saves leave the action available and show an error.
- Favorite chats: add or remove a chat through its tab context menu. A separate **Favorites** list on New chat uses the existing project/status cards and explicitly reopens closed chats. Favorites persist independently of pins and preview tabs, synchronize across windows, and disappear when the chat is archived or deleted. All 15 interface languages are supported.

### Changed

- More compact homepage cards, with smaller icons, text, and padding while preserving 44px touch targets on coarse-pointer devices.
- Local development checks now run formatting, ESLint, TypeScript, and the full test suite through `npm run check`. Typed RPC test adapters preserve missing-handler failures. No CI/CD is required.

### Fixed

- On first overlay mount, the viewed chat becomes the preview even after delayed provisioning or client/server clock skew. Removed the two-minute creation-time heuristic; persisted closed-thread IDs still reject automatic reopening, while explicit navigation can reopen a closed tab. Current chats resolved outside the sidebar also work without creation-time metadata.

## 0.1.10

### Added

- A subthread counter on tabs with descendants: distinct working, waiting-for-input, or unread descendants count once across all levels. Hover or click opens all available direct children, including calm ones; nested side menus expose deeper descendants. Selecting any level explicitly opens its preview tab. Work/waiting and unread markers appear before each subthread title, matching the tab strip, with localized status tooltips and accessible labels. Keyboard navigation, touch expansion arrows, zero-count access, and 15-language labels are included. Archived branches are excluded.

### Fixed

- In browsers without CSS Anchor Positioning, including older Safari versions, the tab strip follows the measured main-chat bounds instead of starting under the left sidebar. Bounds update during sidebar resizing, window resizing, and route/panel replacement; native CSS anchors remain unchanged where supported.
- Closing the last active tab returns to the native New chat screen and focuses the message input. Closing via the X button, middle-click, or the supported close shortcut uses the same navigation; the closed tab is not reopened.

## 0.1.9

### Added

- Chat search matches project names as well as chat titles, including projects outside the loaded sidebar. Queries can combine project and title words, such as `Office login`. Both fields use the existing case/accent-insensitive fuzzy ranking; archived, deleted, and hidden chat rules are unchanged. The search prompt is updated in all 15 interface languages.

## 0.1.8

### Fixed

- Reduce style recalculation during chat switching by restricting the localized-settings suppression selector to BB's native form panel instead of testing arbitrary first-child elements. The native settings form remains available when the localized replacement is absent.

## 0.1.7

### Fixed

- Homepage tabs recover from a failed cold-start request and load when an initially hidden page becomes visible, without requiring a visit to a chat. Reconnecting also refreshes the snapshot. Initial failures retry with capped exponential backoff; timers are cleaned up when hidden, disabled, or unmounted.
- The homepage shows a localized loading status until the first snapshot arrives instead of incorrectly reporting an empty list.

### Changed

- The New chat homepage section is now called **Tabs** rather than **Pinned chats**, including its accessible name, empty state, and setting. It still lists pinned tabs in their existing order.

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
