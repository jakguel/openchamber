import { describe, expect, test } from 'bun:test';
import {
  extractToc,
  slugifyHeading,
  planHeadingIds,
  HEADING_ID_PREFIX,
} from './toc';
import { marked } from 'marked';
import { stripLeadingFrontmatter } from './frontmatter';

// The renderer's parser lexes with marked; render to an HTML string with the
// same marked to compare extracted headings against the real rendered <h1-3>.
const renderToHtml = (src: string): string => marked.parse(src) as string;

// Independent oracle: pull the h1–h3 tags out of the REAL marked-rendered HTML
// string (the same parser the renderer uses). extractToc must match this 1:1 in
// count, order and depth — that is what "positional id injection" relies on.
const renderedHeadingDepths = (html: string): number[] => {
  const re = /<h([1-3])\b[^>]*>[\s\S]*?<\/h\1>/gi;
  const depths: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) depths.push(Number(m[1]));
  return depths;
};

describe('slugifyHeading', () => {
  test('lowercases and hyphenates words', () => {
    expect(slugifyHeading('Hello World')).toBe('hello-world');
  });

  test('simple word', () => {
    expect(slugifyHeading('Overview')).toBe('overview');
  });

  test('strips inline code and emphasis markers (fails if markers leak into slug)', () => {
    expect(slugifyHeading('`code` and *em*')).toBe('code-and-em');
  });

  test('keeps underscores (identifiers), drops other punctuation', () => {
    expect(slugifyHeading('my_var')).toBe('my_var');
    expect(slugifyHeading('C++ & Rust!')).toBe('c-rust');
  });

  test('collapses runs and trims stray hyphens', () => {
    expect(slugifyHeading('  --A   B--  ')).toBe('a-b');
  });

  test('empty / punctuation-only falls back to a stable base', () => {
    expect(slugifyHeading('   ')).toBe('section');
    expect(slugifyHeading('***')).toBe('section');
  });
});

describe('extractToc — depth + slug model', () => {
  test('ATX headings, only H1–H3 (H4 excluded)', () => {
    const toc = extractToc('# H1\n## H2\n### H3\n#### H4');
    expect(toc).toEqual([
      { depth: 1, text: 'H1', slug: `${HEADING_ID_PREFIX}h1` },
      { depth: 2, text: 'H2', slug: `${HEADING_ID_PREFIX}h2` },
      { depth: 3, text: 'H3', slug: `${HEADING_ID_PREFIX}h3` },
    ]);
  });

  test('setext (=== / ---) headings are collected as H1 / H2', () => {
    const toc = extractToc('Title\n=====\n\nSub\n-----');
    expect(toc.map((e) => [e.depth, e.text])).toEqual([
      [1, 'Title'],
      [2, 'Sub'],
    ]);
  });

  test('heading nested in a blockquote is collected', () => {
    const toc = extractToc('> ## Quoted heading');
    expect(toc).toEqual([
      { depth: 2, text: 'Quoted heading', slug: `${HEADING_ID_PREFIX}quoted-heading` },
    ]);
  });

  test('heading nested in a list item is collected', () => {
    const toc = extractToc('- # List Heading\n- plain item');
    expect(toc).toEqual([
      { depth: 1, text: 'List Heading', slug: `${HEADING_ID_PREFIX}list-heading` },
    ]);
  });

  test('headings inside a fenced code block are EXCLUDED', () => {
    const toc = extractToc('# Real\n```\n## fake\n```');
    expect(toc).toEqual([
      { depth: 1, text: 'Real', slug: `${HEADING_ID_PREFIX}real` },
    ]);
  });

  test('raw-HTML heading (<h2>) is collected positionally', () => {
    const toc = extractToc('<h2>Raw HTML</h2>\n\nafter');
    expect(toc).toEqual([
      { depth: 2, text: 'Raw HTML', slug: `${HEADING_ID_PREFIX}raw-html` },
    ]);
  });

  test('inline code / emphasis heading → clean text + stable slug', () => {
    const toc = extractToc('## `fn()` returns *x*');
    expect(toc).toEqual([
      { depth: 2, text: 'fn() returns x', slug: `${HEADING_ID_PREFIX}fn-returns-x` },
    ]);
  });

  test('zero headings → empty model', () => {
    expect(extractToc('just a paragraph of text')).toEqual([]);
  });

  test('only H4–H6 → empty model', () => {
    expect(extractToc('#### four\n##### five\n###### six')).toEqual([]);
  });
});

describe('extractToc — in-document slug de-dup + prefix', () => {
  test('duplicate "## Overview" → distinct, prefixed, -1 suffixed', () => {
    const toc = extractToc('## Overview\n\n## Overview\n\n## Overview');
    expect(toc.map((e) => e.slug)).toEqual([
      `${HEADING_ID_PREFIX}overview`,
      `${HEADING_ID_PREFIX}overview-1`,
      `${HEADING_ID_PREFIX}overview-2`,
    ]);
    // all distinct (morphdom keys on id → duplicates corrupt the DOM on edit)
    expect(new Set(toc.map((e) => e.slug)).size).toBe(3);
  });

  test('every slug carries the namespace prefix', () => {
    const toc = extractToc('# Alpha\n## Beta');
    for (const e of toc) expect(e.slug.startsWith(HEADING_ID_PREFIX)).toBe(true);
  });

  test('de-dupes against ids already present (sanitized-DOM parity)', () => {
    const toc = extractToc('## Overview', { existingIds: [`${HEADING_ID_PREFIX}overview`] });
    expect(toc[0]!.slug).toBe(`${HEADING_ID_PREFIX}overview-1`);
  });
});

describe('extractToc — frontmatter + rendered-h-tag 1:1 parity', () => {
  test('strips leading frontmatter by default', () => {
    const content = '---\ntitle: X\ntags: [a, b]\n---\n# After FM\n## Section';
    expect(extractToc(content).map((e) => [e.depth, e.text])).toEqual([
      [1, 'After FM'],
      [2, 'Section'],
    ]);
  });

  test('extracted headings match the rendered <h1-3> tags 1:1 (order + depth)', () => {
    const content = [
      '---',
      'title: Doc',
      '---',
      '# Top',
      'para',
      '> ## Quoted',
      '- # In List',
      '### Deep `code`',
      '```',
      '## fenced-fake',
      '```',
      '<h2>Raw</h2>',
      '#### too-deep',
    ].join('\n');

    const stripped = stripLeadingFrontmatter(content);
    const renderedDepths = renderedHeadingDepths(renderToHtml(stripped));
    const tocDepths = extractToc(content).map((e) => e.depth);

    // Same count, same order, same depths as what actually renders.
    expect(tocDepths).toEqual(renderedDepths);
    // sanity: the fixture really exercises H1..H3 and excludes the fenced + H4
    expect(tocDepths).toEqual([1, 2, 1, 3, 2]);
  });
});

describe('planHeadingIds — positional plan + mismatch guard', () => {
  test('matching counts → ordered slug list (no frontmatter strip on rendered content)', () => {
    expect(planHeadingIds('# A\n## B', 2)).toEqual([
      `${HEADING_ID_PREFIX}a`,
      `${HEADING_ID_PREFIX}b`,
    ]);
  });

  test('token count != rendered h-tag count → null (caller skips + warns, no misassign)', () => {
    // 2 heading tokens but the live DOM grew a 3rd <h2> not in the source.
    expect(planHeadingIds('# A\n## B', 3)).toBeNull();
    // fewer rendered than tokens also mismatches
    expect(planHeadingIds('# A\n## B\n### C', 2)).toBeNull();
  });

  test('reserves existing DOM ids so injected ids never collide', () => {
    expect(
      planHeadingIds('## Overview', 1, { existingIds: [`${HEADING_ID_PREFIX}overview`] }),
    ).toEqual([`${HEADING_ID_PREFIX}overview-1`]);
  });
});

describe('render stage never injects heading ids (chat byte-identity guard)', () => {
  test('marked/parse HTML for headings carries NO id attribute and no md-h- prefix', () => {
    const html = renderToHtml('# Heading One\n## Heading Two\n### Heading Three');
    expect(html).toContain('<h1>Heading One</h1>');
    expect(html).toContain('<h2>Heading Two</h2>');
    expect(html).not.toContain('id=');
    expect(html).not.toContain(HEADING_ID_PREFIX);
  });
});
