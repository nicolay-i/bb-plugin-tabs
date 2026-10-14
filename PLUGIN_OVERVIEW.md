Keep chats in a manually ordered strip beneath BB's header. See the [setup guide](https://github.com/nicolay-i/bb-plugin-tabs#readme).

## Workspaces

Work, Home, Other, and custom sets keep independent pins, order, preview, and favorites. The thread-header selector shows the name on desktop or a letter/emoji on mobile, even with the strip hidden. It opens on click or hover; New chat retains its selector. Switching restores this window's last active tab, then the first member, or New chat for an empty set, without inserting the previous chat. Sets synchronize; selections remain window-local.

Manage up to 20 sets with 1–80-character Unicode names, inline rename/delete confirmation, and reduced-motion-aware dialog animations. Creation keeps the current chat, selection, and dialog open. Default labels follow the interface language; custom names stay unchanged. Deletion never removes chats or history. Existing tabs and favorites migrate once into Work. Disabling workspaces uses Work or the first remaining set, preserving other sets and the window's previous selection.

Choose **Show in workspaces** in a tab menu to add one chat to several sets or remove it from selected sets. Favorites remain independent; membership edits do not navigate or switch your workspace.

## Tabs and favorites

- One italic preview follows the unpinned chat you open. Another unpinned chat replaces it; background work never creates a preview. Explicitly closed tabs stay closed until reopened.
- Double-click a preview to pin it. Drag pins across projects into a manual order, or double-click a pinned title to rename it. Menus also offer Copy link, Mark unread, Favorite, and Archive.
- Optional **Tabs** and **Favorites** lists appear on New chat. Favorites survive closing a tab or replacing its preview. Compact cards let you toggle pins/favorites with visit-local undo.
- `Ctrl+Shift+T` / `⌘⇧T` restores explicit closes in the current workspace, including from New chat. Up to 100 window-local undo records survive reload. Restore keeps position/pin without displacing another chat; unavailable chats are skipped and failures stay retryable. Browsers may reserve the shortcut instead of forwarding it.

## Navigation and activity

- Search chat titles and project names across available chats, beyond the last 100 visits. Open the list by click, hover, or double Shift; use arrows and Enter. Pinned chats precede history, with **More** revealing eight additional visits. Optional archived results are disabled; deleted/hidden chats are excluded.
- The plus opens BB's native New chat composer. Hover to select from recently active projects before composing.
- A **?** signals pending input instead of endless work. Working and unread states remain distinct. An idle main chat shows a grey dot while its sidechat runs; its own work keeps the regular indicator.
- Branch icons distinguish subthreads. Hover/click descendant counters to explore nested chats, including calm children; attention counts include work, input, and unread states.
- Desktop supports drag, wheel scrolling, middle-click close, `Ctrl+Tab`, and BB Desktop close shortcuts. Touch uses swipe and 44px targets. Embedded browsers keep native close behavior.

## Language, state, and requirements

Choose from 15 interface languages. **Auto** follows BB's page language, then the browser, then English. Titles and custom names are not translated. Bundled strings need no chat content for translation. Additional translations are machine-assisted first drafts.

Controls follow BB theme colors and reduced-motion preferences. The strip follows the main chat width and hides in split/full-panel/drawer layouts.

SQLite stores workspaces; history stays separate. Archive/delete removes memberships but keeps disabled history records. Unarchive restores history navigation, not tabs or favorites. Stale snapshots cannot override newer visits or lifecycle events.

Requires BB 0.43 or later. No external service or account is required.
