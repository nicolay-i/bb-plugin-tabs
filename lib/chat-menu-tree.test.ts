import { describe, expect, it } from "vitest";
import { chatMenuTree } from "./chat-menu-tree";

const tab = (threadId: string, parentThreadId?: string) => ({
  entry: { threadId, parentThreadId },
});

describe("chatMenuTree", () => {
  it("includes known ancestors once, preserves sibling order and keeps missing-parent chats", () => {
    const root = tab("root");
    const parent = tab("parent", "root");
    const child = tab("child", "parent");
    const sibling = tab("sibling", "root");
    const orphan = tab("orphan", "unknown");
    expect(chatMenuTree([child, sibling, child, orphan], [parent, root])).toEqual([
      {
        tab: root,
        children: [
          { tab: parent, children: [{ tab: child, children: [] }] },
          { tab: sibling, children: [] },
        ],
      },
      { tab: orphan, children: [] },
    ]);
  });

  it.each([false, true])(
    "keeps a 20000-level chain stack-safe in either input order (%s)",
    (reverse) => {
      const chain = Array.from({ length: 20000 }, (_, index) =>
        tab(`t${index}`, index ? `t${index - 1}` : undefined),
      );
      const tree = chatMenuTree(reverse ? [...chain].reverse() : chain, []);
      expect(tree).toHaveLength(1);
      let node = tree[0];
      let count = 0;
      while (node) {
        count++;
        node = node.children[0];
      }
      expect(count).toBe(chain.length);
    },
  );

  it("breaks self and multi-node cycles without losing entries", () => {
    const a = tab("a", "b"),
      b = tab("b", "c"),
      c = tab("c", "a"),
      self = tab("self", "self");
    expect(chatMenuTree([a, self], [a, b, c])).toEqual([
      { tab: c, children: [{ tab: b, children: [{ tab: a, children: [] }] }] },
      { tab: self, children: [] },
    ]);
  });
});
