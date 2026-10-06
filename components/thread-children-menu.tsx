import { useEffect, useRef, useState, type PointerEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { chatStatusFor } from "../lib/chat-status";
import type { ChildThreadNode } from "../lib/thread-children";
import { translate, type PluginLocale } from "../lib/plugin-locale";
import type { TabCandidate } from "../lib/tabs-model";
import { Icon } from "./ui/icon";

interface ThreadChildrenMenuProps {
  title: string;
  children: readonly ChildThreadNode[];
  attentionCount: number;
  locale?: PluginLocale;
  onOpen: (thread: TabCandidate) => void;
}

/** A separate sibling button, never nested inside the main tab button. */
export function ThreadChildrenMenu({ title, children, attentionCount, locale = "en", onOpen }: ThreadChildrenMenuProps) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(false);
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) => translate(locale, key, variables);
  const clearTimers = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  useEffect(() => () => clearTimers(), []);
  useEffect(() => { if (children.length === 0) { clearTimers(); setOpen(false); } }, [children.length]);
  if (children.length === 0) return null;

  const enter = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    clearTimers();
    openTimer.current = setTimeout(() => { hovered.current = true; setOpen(true); }, 250);
  };
  const leave = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    clearTimers();
    // Portalled nested menus belong to this same hover region.
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest(".bb-chat-tabs-child-menu, .bb-chat-tab-children")) return;
    if (hovered.current) closeTimer.current = setTimeout(() => setOpen(false), 250);
  };
  const keepOpen = () => {
    clearTimers();
  };
  const choose = (node: ChildThreadNode) => {
    clearTimers();
    setOpen(false);
    onOpen({ threadId: node.threadId, projectId: node.projectId, title: node.title ?? t("Untitled") });
  };
  const label = (node: ChildThreadNode) => node.title ?? t("Untitled");
  const itemLabel = (node: ChildThreadNode) => {
    const status = chatStatusFor(node, locale);
    return status ? `${label(node)}. ${status.text}.` : label(node);
  };
  const content = (node: ChildThreadNode) => {
    const status = chatStatusFor(node, locale);
    return <>
      {status ? <span className="bb-chat-tabs-child-indicators" title={status.text} aria-hidden>
        {node.isWaiting ? <span className="bb-chat-tab-waiting">?</span>
          : node.isWorking ? <span className="bb-chat-tab-working" /> : null}
        {node.isUnread ? <span className="bb-chat-tab-unread" /> : null}
      </span> : null}
      <span className="bb-chat-tabs-child-copy">
        <span className="bb-chat-tabs-child-title" title={label(node)}>{label(node)}</span>
      </span>
      {node.children.length > 0 ? <span className="bb-chat-tabs-child-count" aria-hidden>{node.attentionCount}</span> : null}
    </>;
  };
  const items = (nodes: readonly ChildThreadNode[]) => nodes.map((node) => node.children.length === 0 ? (
    <DropdownMenu.Item key={node.threadId} className="bb-chat-tabs-child-item" data-thread-id={node.threadId} aria-label={itemLabel(node)} onSelect={() => choose(node)}>
      {content(node)}
    </DropdownMenu.Item>
  ) : (
    <DropdownMenu.Sub key={node.threadId}>
      <DropdownMenu.SubTrigger className="bb-chat-tabs-child-item" data-thread-id={node.threadId} aria-label={itemLabel(node)}
        onClick={(event) => {
          // Touch users can tap the arrow to expand, or the title to open the chat.
          if (event.target instanceof Element && event.target.closest(".bb-chat-tabs-child-expand")) return;
          event.preventDefault(); choose(node);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(node); }
        }}>
        {content(node)}<span className="bb-chat-tabs-child-expand" title={t("Subthreads of “{title}”", { title: label(node) })} aria-hidden>
          <Icon name="ChevronRight" className="bb-chat-tabs-child-chevron" />
        </span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className="bb-chat-tabs-child-menu" sideOffset={4} collisionPadding={8}
          aria-label={t("Subthreads of “{title}”", { title: label(node) })} aria-labelledby={undefined}
          onPointerEnter={keepOpen} onPointerLeave={leave}>
          {items(node.children)}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  ));

  const accessibleLabel = t("Subthreads of “{title}”: {count} active or unread", { title, count: attentionCount });
  return (
    <DropdownMenu.Root open={open} modal={false} dir={locale === "ar" ? "rtl" : "ltr"}
      onOpenChange={(next) => { clearTimers(); setOpen(next); }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" draggable={false} className="bb-chat-tab-children" data-attention={attentionCount > 0 ? "true" : undefined}
          onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}
          aria-label={accessibleLabel} title={accessibleLabel} onPointerEnter={enter} onPointerLeave={leave}
          onPointerDown={(event) => { hovered.current = false; clearTimers(); event.stopPropagation(); }}
          onKeyDown={() => { hovered.current = false; clearTimers(); }}>
          <Icon name="GitBranch" aria-hidden />{attentionCount}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="bb-chat-tabs-child-menu" side="bottom" align="start" sideOffset={6} collisionPadding={8}
          aria-label={t("Subthreads of “{title}”", { title })} aria-labelledby={undefined}
          onCloseAutoFocus={(event) => { if (hovered.current) event.preventDefault(); }}
          onPointerDown={() => { hovered.current = false; clearTimers(); }}
          onPointerEnter={keepOpen} onPointerLeave={leave}>
          {items(children)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
