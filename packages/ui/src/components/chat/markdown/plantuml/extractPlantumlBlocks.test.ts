import { describe, expect, test } from 'bun:test';

import {
  extractPlantumlBlocks,
  PLANTUML_BLOCK_SELECTOR,
  PLANTUML_SOURCE_ATTR,
  readPlantumlSource,
  type PlantumlBlockContainer,
  type PlantumlBlockNode,
} from './extractPlantumlBlocks';

interface FakeNodeOpts {
  attr?: string | null;
  mdSource?: string | null;
  codeText?: string | null;
  text?: string | null;
}

const childWithAttr = (attrName: string, value: string): PlantumlBlockNode => ({
  getAttribute: (name) => (name === attrName ? value : null),
  querySelector: () => null,
  textContent: null,
});

const codeChild = (text: string): PlantumlBlockNode => ({
  getAttribute: () => null,
  querySelector: () => null,
  textContent: text,
});

const makeNode = (opts: FakeNodeOpts): PlantumlBlockNode => ({
  getAttribute: (name) => (name === PLANTUML_SOURCE_ATTR ? opts.attr ?? null : null),
  querySelector: (selectors) => {
    if (selectors === '[data-md-source]' && opts.mdSource != null) {
      return childWithAttr('data-md-source', opts.mdSource);
    }
    if (selectors === 'code' && opts.codeText != null) {
      return codeChild(opts.codeText);
    }
    return null;
  },
  textContent: opts.text ?? null,
});

const makeRoot = (nodes: PlantumlBlockNode[]): PlantumlBlockContainer => ({
  querySelectorAll: (selectors) => (selectors === PLANTUML_BLOCK_SELECTOR ? nodes : []),
});

describe('extractPlantumlBlocks — AC6 sources + positional indices', () => {
  test('reads the data-plantuml-source attribute of each block with its DOM index', () => {
    const root = makeRoot([
      makeNode({ attr: '@startuml\nA -> B\n@enduml' }),
      makeNode({ attr: '@startuml\nC -> D\n@enduml' }),
    ]);
    expect(extractPlantumlBlocks(root)).toEqual([
      { source: '@startuml\nA -> B\n@enduml', index: 0 },
      { source: '@startuml\nC -> D\n@enduml', index: 1 },
    ]);
  });

  test('indices track DOM order so interleaved diagram types stay aligned', () => {
    const root = makeRoot([
      makeNode({ attr: 'first' }),
      makeNode({ attr: 'second' }),
      makeNode({ attr: 'third' }),
    ]);
    expect(extractPlantumlBlocks(root).map((block) => block.index)).toEqual([0, 1, 2]);
  });

  test('returns an empty array when there are no plantuml blocks', () => {
    expect(extractPlantumlBlocks(makeRoot([]))).toEqual([]);
  });

  test('falls back to a data-md-source toolbar button when the attribute is absent', () => {
    const root = makeRoot([makeNode({ mdSource: '@startuml\nX\n@enduml' })]);
    expect(extractPlantumlBlocks(root)).toEqual([{ source: '@startuml\nX\n@enduml', index: 0 }]);
  });

  test('falls back to nested <code> text when attribute and button are absent', () => {
    const root = makeRoot([makeNode({ codeText: '@startuml\nY\n@enduml\n' })]);
    expect(extractPlantumlBlocks(root)).toEqual([{ source: '@startuml\nY\n@enduml', index: 0 }]);
  });

  test('falls back to the block text as a last resort', () => {
    const root = makeRoot([makeNode({ text: 'raw plantuml source' })]);
    expect(extractPlantumlBlocks(root)).toEqual([{ source: 'raw plantuml source', index: 0 }]);
  });

  test('the source attribute wins over nested code (fails if fallback order inverted)', () => {
    const root = makeRoot([makeNode({ attr: 'canonical', codeText: 'stale-code' })]);
    expect(extractPlantumlBlocks(root)).toEqual([{ source: 'canonical', index: 0 }]);
  });

  test('trims only trailing whitespace, preserving leading indentation', () => {
    const root = makeRoot([makeNode({ attr: '  @startuml\n  A\n  @enduml   \n\n' })]);
    expect(extractPlantumlBlocks(root)).toEqual([{ source: '  @startuml\n  A\n  @enduml', index: 0 }]);
  });

  test('an empty/whitespace attribute is skipped so a real fallback source is used', () => {
    const root = makeRoot([makeNode({ attr: '   ', codeText: '@startuml\nZ\n@enduml' })]);
    expect(readPlantumlSource(makeNode({ attr: '   ', codeText: '@startuml\nZ\n@enduml' }))).toBe(
      '@startuml\nZ\n@enduml',
    );
    expect(extractPlantumlBlocks(root)).toEqual([{ source: '@startuml\nZ\n@enduml', index: 0 }]);
  });
});
