Keep the conversations you return to in a manually ordered strip beneath BB's header. The sidebar stays available. See the [screenshots and setup guide](https://github.com/nicolay-i/bb-plugin-tabs#readme).

## Chats within reach

- One italic preview follows the unpinned chat you open. Opening another unpinned chat replaces it; creating a new chat shows its preview immediately. Closing a preview stays closed across reloads and other windows until you open that chat again. Background work never opens a preview.
- Double-click a preview to pin it. Drag pinned tabs across projects into one shared order, with an insertion marker and edge autoscroll. Double-click a pinned title to rename it inline. The context menu provides Copy link, Mark as unread, Pin/Unpin, Rename, and Archive.
- A compact **?** marker tells you when BB is waiting for an answer or approval instead of showing an endless working dot. Hover for an explanation. Pending input in a nested chat also marks its parent tab. Working and unread states remain distinct; lists and home cards show the full **Needs input** status.
- An optional **Tabs** list appears below the **New chat** composer, showing your pinned tabs. It loads on the first visit without opening a chat and shares the strip's ordering and shows the project and useful status below each title. Calm chats have no filler status.

## Navigation

- A subthread counter on each tab with children counts distinct working, waiting-for-input, or unread descendants. Hover or click it to see direct children and recursively expand side menus. Click any title to open that subthread as the normal preview tab. Zero still lets you explore calm children; archived branches are excluded. Keyboard navigation and separate touch expansion arrows are supported.

- Search chat titles and project names across available BB chats from the list menu, including older chats outside the last 100 visits. Enter a project name to find its chats, or combine project and title words such as `Office login` to narrow the results. Enable **Include archived chats in search** to find archived chats as disabled results with struck-through titles; deleted and hidden chats remain excluded. Open the menu by click, a 300 ms hover, or a double Shift press. Arrow keys select an available result and Enter opens it. Pinned chats precede history; **More** reveals another eight of the last 100 visits.
- The plus after the last tab opens BB's native new-chat composer. Hover for 300 ms to choose from the 15 most recently active projects; **More** reveals the next group. Selecting a project preselects it in the composer.
- Desktop supports horizontal wheel scrolling, a conditional top scrollbar, middle-click close, `Ctrl+Tab` / `Ctrl+Shift+Tab`, and BB Desktop `Ctrl+W` / `⌘W`. An embedded browser with focus keeps its native close behavior. Compact and touch layouts use horizontal swipe, 44×44 targets, and explicit close buttons.

## Language and presentation

Choose from 15 interface languages: English, Russian, Spanish, Brazilian Portuguese, French, German, Simplified Chinese, Hindi, Arabic, Japanese, Indonesian, Turkish, Korean, Vietnamese, and Italian. **Auto** follows a supported BB page language, then the browser language, then English. Chat titles and project names are not translated. The settings panel follows the selected language immediately, with concrete descriptions of what each option shows and where. Setting keys and stored values stay compatible with the CLI; the static English form remains a fallback if the localized section cannot mount. Additional translations are machine-assisted first drafts.

The plugin includes a theme-aware SVG icon. Controls and status markers follow BB theme colors; animations respect reduced-motion preferences. The strip follows the main chat width around a right panel and hides in true split, full-panel, and drawer layouts.

## State and requirements

Tabs, order, and history live in plugin-owned storage and synchronize across windows. Archive or delete removes a chat from tabs and pins while retaining a disabled history record. Unarchiving re-enables history navigation without restoring the old pin or preview. Live sidebar state supplies activity; durable workflow status uses the built-in workflows plugin's public RPC as a bounded fallback.

Requires BB 0.43 or later. No external service or account is required, and no chat content is sent for runtime translation: language strings are bundled with the plugin.
