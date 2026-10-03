import { translate, type PluginLocale } from "./plugin-locale";

export type ChatStatusKind = "unread" | "working" | "waiting";

export interface ChatStatusInput {
  isUnread: boolean;
  isWorking: boolean;
  isWaiting?: boolean;
}

export interface ChatStatus {
  /** Waiting for user input takes precedence over background work and unread. */
  kind: ChatStatusKind;
  text: string;
}

/**
 * A shared, concise status vocabulary for home cards and the tabs menu. Calm
 * chats intentionally receive neither a decorative status nor a dot.
 */
export function chatStatusFor(input: ChatStatusInput, locale: PluginLocale = "en"): ChatStatus | null {
  const parts: string[] = [];
  if (input.isWaiting) parts.push(translate(locale, "Needs input"));
  else if (input.isWorking) parts.push(translate(locale, "Working"));
  if (input.isUnread) parts.push(translate(locale, "Unread"));
  if (parts.length === 0) return null;

  return {
    kind: input.isWaiting ? "waiting" : input.isWorking ? "working" : "unread",
    text: parts.join(" · "),
  };
}
