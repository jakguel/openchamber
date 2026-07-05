import { describe, expect, test } from 'bun:test';

import type { TocDepth, TocEntry } from '../toc';
import { HEADING_ID_PREFIX } from '../toc';
import { buildTocTree, descendantSlugs, type TocNode } from './tocModel';

const entry = (depth: TocDepth, text: string): TocEntry => ({
  depth,
  text,
  slug: `${HEADING_ID_PREFIX}${text.toLowerCase().replace(/\s+/g, '-')}`,
});

// Flatten the tree back to a slug list in document order — the invariant that no
// entry is dropped by nesting.
const flattenSlugs = (nodes: TocNode[]): string[] => {
  const out: string[] = [];
  const walk = (n: TocNode): void => {
    out.push(n.entry.slug);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
};

describe('buildTocTree', () => {
  test('nests H2 under H1 and H3 under H2 (default-expanded structure)', () => {
    const tree = buildTocTree([
      entry(1, 'Overview'),
      entry(2, 'Setup'),
      entry(3, 'Install'),
      entry(3, 'Configure'),
      entry(2, 'Usage'),
    ]);

    expect(tree).toHaveLength(1);
    const overview = tree[0]!;
    expect(overview.entry.text).toBe('Overview');
    expect(overview.children.map((c) => c.entry.text)).toEqual(['Setup', 'Usage']);

    const setup = overview.children[0]!;
    expect(setup.children.map((c) => c.entry.text)).toEqual(['Install', 'Configure']);
    // Leaves have no children.
    expect(setup.children[0]!.children).toHaveLength(0);
  });

  test('collapsing a depth-1 node hides ALL its depth-2/3 descendants', () => {
    const tree = buildTocTree([
      entry(1, 'Alpha'),
      entry(2, 'Alpha Two'),
      entry(3, 'Alpha Three'),
      entry(1, 'Beta'),
      entry(2, 'Beta Two'),
    ]);

    const alpha = tree[0]!;
    expect(alpha.entry.text).toBe('Alpha');
    // The descendants hidden when Alpha collapses are exactly its subtree —
    // never Beta's subtree.
    expect(descendantSlugs(alpha)).toEqual([
      `${HEADING_ID_PREFIX}alpha-two`,
      `${HEADING_ID_PREFIX}alpha-three`,
    ]);
    expect(descendantSlugs(alpha)).not.toContain(`${HEADING_ID_PREFIX}beta-two`);
  });

  test('malformed ordering keeps every entry (H3 first → root; H1 after H3 → new root)', () => {
    const input = [
      entry(3, 'Orphan Three'),
      entry(1, 'Root One'),
      entry(3, 'Deep'),
    ];
    const tree = buildTocTree(input);

    // Orphan H3 with no shallower ancestor is a root; H1 starts a fresh root.
    expect(tree.map((n) => n.entry.text)).toEqual(['Orphan Three', 'Root One']);
    // The trailing H3 attaches under the preceding H1 (nearest shallower).
    expect(tree[1]!.children.map((c) => c.entry.text)).toEqual(['Deep']);
    // No entry lost.
    expect(flattenSlugs(tree)).toEqual(input.map((e) => e.slug));
  });

  test('empty model yields no roots', () => {
    expect(buildTocTree([])).toEqual([]);
  });
});
