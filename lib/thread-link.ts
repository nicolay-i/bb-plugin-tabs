/** Data sufficient to create the canonical route for a regular project chat. */
export interface ThreadLinkTarget {
  projectId: string;
  threadId: string;
}

/**
 * Builds an absolute link without accessing BB's private route helpers. For
 * the current chat it preserves the actual route, including BB's projectless
 * personal-project URL.
 */
export function threadLinkUrl(
  target: ThreadLinkTarget,
  currentThreadId: string | null,
  location: Pick<Location, "href" | "origin"> = window.location,
): string {
  if (target.threadId === currentThreadId) {
    const current = new URL(location.href);
    current.search = "";
    current.hash = "";
    return current.toString();
  }

  const path = `/projects/${encodeURIComponent(
    target.projectId,
  )}/threads/${encodeURIComponent(target.threadId)}`;
  return new URL(path, location.origin).toString();
}
