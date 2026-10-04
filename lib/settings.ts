import { LANGUAGE_OPTIONS } from "./languages";

/** Shared labels/defaults: English for the CLI, translated in the settings slot. */
export const SETTINGS = {
  language: { type: "select", label: "Language", description: "Choose the language for Chat Tabs, including these settings. Auto uses the BB page or browser language.", options: [...LANGUAGE_OPTIONS], default: "Auto" },
  searchArchivedChats: { type: "boolean", label: "Include archived chats in search", description: "Adds archived chats to title search results. They have struck-through titles and cannot be opened here. Deleted chats are excluded.", default: false },
  showPinnedTabsList: { type: "boolean", label: "Show tabs on New chat", description: "Shows your pinned tabs below the message input on the New chat screen.", default: true },
  showTabsOnDesktop: { type: "boolean", label: "Show top tabs on desktop", description: "Shows the chat tab strip below the BB header on desktop. Turning it off keeps your pins and history.", default: true },
  showTabsOnMobile: { type: "boolean", label: "Show top tabs on mobile", description: "Shows the chat tab strip below the BB header on mobile. Turning it off keeps your pins and history.", default: true },
  showTabListButton: { type: "boolean", label: "Show the tab list button", description: "Adds a button to the tab strip that opens a menu with chat search, pinned chats, and history.", default: true },
  showTabListPinned: { type: "boolean", label: "Show pinned chats in the tab list", description: "Shows the Pinned section in the tab list menu. Turning it off does not unpin chats.", default: true },
  showTabListHistory: { type: "boolean", label: "Show history in the tab list", description: "Shows recently visited chats in the tab list menu. Turning it off hides the section but keeps recording visits.", default: true },
  tabListButtonPosition: { type: "select", label: "Tab list button position", description: "Places the tab list button on the left or right of the chat tab strip.", options: ["Left", "Right"], default: "Left" },
} as const;
export type SettingKey = keyof typeof SETTINGS;
