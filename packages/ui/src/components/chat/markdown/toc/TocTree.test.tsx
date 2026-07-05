import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { TocDepth, TocEntry } from '../toc';
import { HEADING_ID_PREFIX } from '../toc';
import { TocTree } from './TocTree';

// Real render of the real component (no internal mocks) via react-dom/server —
// the harness this package uses for component tests (no jsdom/RTL is configured,
// and adding one is out of scope: project rule "no new deps"). Interactive
// click→scroll + the collapse hide/show transition run in the T7 real-Chromium
// e2e; here we prove the static render + the collapse control state, and the
// hide-set arithmetic is covered in tocModel.test.ts.

const entry = (depth: TocDepth, text: string): TocEntry => ({
  depth,
  text,
  slug: `${HEADING_ID_PREFIX}${text.toLowerCase().replace(/\s+/g, '-')}`,
  // `line` is irrelevant to the render/collapse assertions here — synthetic
  // entries with a fixed placeholder keep the TocEntry shape valid.
  line: 1,
});

const model: TocEntry[] = [
  entry(1, 'Alpha'),
  entry(2, 'Alpha Two'),
  entry(1, 'Beta'),
];

const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

describe('TocTree', () => {
  test('renders the model, default all-expanded, with translated aria', () => {
    const markup = render(<TocTree entries={model} />);

    // Nav landmark + entries present (parent and nested child both render).
    expect(markup).toContain('aria-label="Table of contents"');
    expect(markup).toContain('Alpha');
    expect(markup).toContain('Alpha Two');
    expect(markup).toContain('Beta');

    // Per-entry navigation affordance uses t() with the heading param.
    expect(markup).toContain('aria-label="Go to Alpha"');

    // A parent (has children) is expanded by default → its toggle offers COLLAPSE.
    expect(markup).toContain('aria-label="Collapse Alpha"');
    expect(markup).not.toContain('aria-label="Expand Alpha"');
  });

  test('a node seeded collapsed shows the EXPAND affordance instead', () => {
    const markup = render(
      <TocTree entries={model} defaultCollapsedSlugs={[`${HEADING_ID_PREFIX}alpha`]} />,
    );
    expect(markup).toContain('aria-label="Expand Alpha"');
    expect(markup).not.toContain('aria-label="Collapse Alpha"');
  });

  test('empty model renders nothing', () => {
    expect(render(<TocTree entries={[]} />)).toBe('');
  });
});
