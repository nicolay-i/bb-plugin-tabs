export type ChatStatusKind = "unread" | "working";

export interface ChatStatusInput {
  isUnread: boolean;
  isWorking: boolean;
}

export interface ChatStatus {
  /** Working takes precedence for the status colour when both signals exist. */
  kind: ChatStatusKind;
  text: string;
}

/**
 * A shared, concise status vocabulary for home cards and the tabs menu. Calm
 * chats intentionally receive neither a decorative status nor a dot.
 */
export function chatStatusFor(input: ChatStatusInput): ChatStatus | null {
  const parts: string[] = [];
  if (input.isWorking) parts.push("Working");
  if (input.isUnread) parts.push("Unread");
  if (parts.length === 0) return null;

  return {
    kind: input.isWorking ? "working" : "unread",
    text: parts.join(" · "),
  };
}
