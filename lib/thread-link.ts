/** Данные, достаточные для canonical route обычного проектного чата. */
export interface ThreadLinkTarget {
  projectId: string;
  threadId: string;
}

/**
 * Строит абсолютную ссылку без доступа к private route helpers BB.
 * Для текущего чата сохраняет его фактический route: это покрывает personal
 * project, у которого BB использует projectless URL.
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
