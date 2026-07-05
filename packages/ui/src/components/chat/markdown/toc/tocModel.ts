import type { TocEntry } from '../toc';

/**
 * Nest the FLAT, document-ordered `TocEntry[]` from `extractToc` into a tree by
 * heading depth (H1 > H2 > H3). Each node owns the descendants that a collapse
 * of that node must hide.
 *
 * Robust to malformed ordering: a heading attaches to the nearest preceding
 * heading of a SHALLOWER depth, or becomes a root when none exists (so an H3
 * with no preceding H2/H1 is a root, and an H1 following an H3 starts a new
 * root). No entry is ever dropped — the flattened tree equals the input order.
 */
export type TocNode = {
  entry: TocEntry;
  children: TocNode[];
};

export const buildTocTree = (entries: TocEntry[]): TocNode[] => {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];
  for (const entry of entries) {
    const node: TocNode = { entry, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.entry.depth >= entry.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }
  return roots;
};

/**
 * The slugs of every descendant of `node` (not including the node itself) in
 * document order. These are exactly the entries hidden when the node collapses.
 */
export const descendantSlugs = (node: TocNode): string[] => {
  const out: string[] = [];
  const walk = (n: TocNode): void => {
    for (const child of n.children) {
      out.push(child.entry.slug);
      walk(child);
    }
  };
  walk(node);
  return out;
};
