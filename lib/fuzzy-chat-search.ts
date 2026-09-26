export interface SearchableChat {
  title: string;
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Prefer full-word matches, then substrings, then in-order fuzzy matches. */
function scoreToken(title: string, token: string): number | null {
  if (title === token) return 0;
  if (title.startsWith(token)) return 1;
  const index = title.indexOf(token);
  if (index >= 0) {
    const wordStart = index === 0 || /[^\p{L}\p{N}]/u.test(title[index - 1] ?? "");
    return (wordStart ? 3 : 10) + index;
  }
  let start = -1;
  let previous = -1;
  let gaps = 0;
  for (const char of token) {
    const next = title.indexOf(char, previous + 1);
    if (next < 0) return null;
    if (start < 0) start = next;
    else gaps += next - previous - 1;
    previous = next;
  }
  return 30 + start + gaps;
}

export function fuzzyChatSearch<T extends SearchableChat>(
  chats: readonly T[],
  query: string,
  limit = 30,
): T[] {
  const tokens = normalize(query).trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return [];
  return chats
    .map((chat, index) => {
      const title = normalize(chat.title);
      let score = 0;
      for (const token of tokens) {
        const part = scoreToken(title, token);
        if (part === null) return null;
        score += part;
      }
      return { chat, index, score };
    })
    .filter((match): match is { chat: T; index: number; score: number } => match !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map(({ chat }) => chat);
}
