export type ChatStatusKind = "unread" | "working";

export interface ChatStatusInput {
  isUnread: boolean;
  isWorking: boolean;
}

export interface ChatStatus {
  /** Working wins the colour when both signals are present. */
  kind: ChatStatusKind;
  text: string;
}

/**
 * Единый короткий язык статусов для root-карточек и меню вкладок.
 * Спокойный чат не получает декоративную строку «Нет активности».
 */
export function chatStatusFor(input: ChatStatusInput): ChatStatus | null {
  const parts: string[] = [];
  if (input.isWorking) parts.push("Работает");
  if (input.isUnread) parts.push("Непрочитанное");
  if (parts.length === 0) return null;

  return {
    kind: input.isWorking ? "working" : "unread",
    text: parts.join(" · "),
  };
}
