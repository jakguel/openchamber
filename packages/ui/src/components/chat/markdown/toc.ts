import { marked, type Tokens } from 'marked';
import { stripLeadingFrontmatter } from './frontmatter';

/**
 * Table-of-Contents core — the shared data + anchor foundation for the Markdown
 * preview ToC (consumed by the desktop FilesView sidebar and the mobile ToC
 * sheet).
 *
 * Public API (stable — downstream tasks depend on it):
 *  - `extractToc(content, options?)` → ordered `{ depth, text, slug }[]` of the
 *    H1–H3 headings, in render order, derived from `marked.lexer` (so setext,
 *    blockquote/list-nested, and raw-HTML headings are all captured, and fenced
 *    code headings are excluded). Strips leading frontmatter by default so the
 *    heading order matches the rendered `<h1-3>` tags 1:1.
 *  - `slugifyHeading(text)` → the shared, un-prefixed base slug. The SAME slug
 *    logic backs both extraction and the DOM id injection in `decorateHeadings`.
 *  - `HEADING_ID_PREFIX` → the `md-h-` namespace every injected id / model slug
 *    carries. A consumer finds a heading element with `getElementById(entry.slug)`.
 *  - `planHeadingIds(content, renderedHeadingCount, options?)` → the ordered id
 *    list to assign positionally, or `null` when the token count and the rendered
 *    `<h1-3>` count disagree (caller must then SKIP injection to avoid
 *    misassignment). Ids are de-duped within the document (`-1`, `-2`, …) and
 *    against any ids already present, because morphdom keys on `id` and duplicate
 *    ids corrupt the DOM on content edits.
 */

export const HEADING_ID_PREFIX = 'md-h-';

export type TocDepth = 1 | 2 | 3;

export type TocEntry = {
  depth: TocDepth;
  /** Human-readable heading text (inline markdown/HTML markers stripped). */
  text: string;
  /** Namespaced, de-duped DOM id (e.g. `md-h-overview`, `md-h-overview-1`). */
  slug: string;
};

export type ExtractTocOptions = {
  /** Strip a single leading frontmatter block first (default: true). */
  stripFrontmatter?: boolean;
  /** Ids already present so injected slugs never collide (de-dup reservation). */
  existingIds?: Iterable<string>;
};

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

/**
 * Derive a stable, url-safe base slug from heading text. Strips inline code /
 * emphasis / link syntax, folds accents, keeps word chars + underscores, and
 * hyphenates whitespace. Returns `section` for empty/punctuation-only text.
 * NOTE: no namespace prefix and no de-dup — see `HEADING_ID_PREFIX` / `extractToc`.
 */
export const slugifyHeading = (text: string): string => {
  const base = text
    .replace(/`([^`]*)`/g, '$1') // inline code → inner
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) → label
    .replace(/[*~]/g, '') // emphasis / strikethrough markers
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // drop punctuation (keep word chars + _)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'section';
};

// ---------------------------------------------------------------------------
// Heading collection (recursive marked.lexer walk)
// ---------------------------------------------------------------------------

type RawHeading = { depth: TocDepth; text: string };

const readArray = (value: unknown): Tokens.Generic[] =>
  Array.isArray(value) ? (value as Tokens.Generic[]) : [];

const decodeEntities = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

// Flatten a heading's inline tokens to plain text (codespan/emphasis/link inner
// text), preserving literal `<`/`>` in text (e.g. `Vec<T>`).
const inlineTokensToText = (tokens: Tokens.Generic[]): string => {
  let out = '';
  for (const token of tokens) {
    const child = readArray(token.tokens);
    if (child.length > 0) {
      out += inlineTokensToText(child);
    } else if (typeof token.text === 'string') {
      out += token.text;
    }
  }
  return out;
};

const cleanInlineMarkers = (raw: string): string =>
  raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*~]/g, '');

const headingText = (token: Tokens.Generic): string => {
  const inline = readArray(token.tokens);
  const text = inline.length > 0
    ? inlineTokensToText(inline)
    : cleanInlineMarkers(typeof token.text === 'string' ? token.text : '');
  return text.replace(/\s+/g, ' ').trim();
};

const isTocDepth = (depth: unknown): depth is TocDepth =>
  depth === 1 || depth === 2 || depth === 3;

// Pull <h1-3> headings out of a raw block-HTML token (marked emits raw HTML as
// an `html` token, not heading tokens). Regex order preserves document order.
const collectHtmlHeadings = (html: string, out: RawHeading[]): void => {
  const re = /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const depth = Number(match[1]!.slice(1));
    if (!isTocDepth(depth)) continue;
    const inner = (match[2] ?? '').replace(/<[^>]*>/g, '');
    out.push({ depth, text: decodeEntities(inner).replace(/\s+/g, ' ').trim() });
  }
};

// Depth-first walk in document order. Recurses blockquotes and list items so
// nested headings are captured; `code` (and everything else) contributes no
// rendered <h1-3> and is skipped.
const collectHeadings = (tokens: Tokens.Generic[], out: RawHeading[]): void => {
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        if (isTocDepth(token.depth)) out.push({ depth: token.depth, text: headingText(token) });
        break;
      case 'blockquote':
        collectHeadings(readArray(token.tokens), out);
        break;
      case 'list':
        for (const item of readArray(token.items)) collectHeadings(readArray(item.tokens), out);
        break;
      case 'html':
        collectHtmlHeadings(
          typeof token.raw === 'string' ? token.raw : typeof token.text === 'string' ? token.text : '',
          out,
        );
        break;
      default:
        break;
    }
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const buildToc = (headings: RawHeading[], existingIds?: Iterable<string>): TocEntry[] => {
  const used = new Set<string>(existingIds ? Array.from(existingIds) : []);
  return headings.map(({ depth, text }) => {
    const base = slugifyHeading(text);
    let slug = `${HEADING_ID_PREFIX}${base}`;
    let n = 1;
    while (used.has(slug)) {
      slug = `${HEADING_ID_PREFIX}${base}-${n}`;
      n += 1;
    }
    used.add(slug);
    return { depth, text, slug };
  });
};

/**
 * Extract the ordered H1–H3 ToC model from markdown `content`. See the module
 * header for the full contract.
 */
export const extractToc = (content: string, options: ExtractTocOptions = {}): TocEntry[] => {
  const { stripFrontmatter = true, existingIds } = options;
  const source = stripFrontmatter ? stripLeadingFrontmatter(content) : content;
  const headings: RawHeading[] = [];
  collectHeadings(marked.lexer(source) as Tokens.Generic[], headings);
  return buildToc(headings, existingIds);
};

/**
 * Compute the ordered id list to assign positionally to the rendered `<h1-3>`
 * tags. Returns `null` when the collected heading-token count differs from
 * `renderedHeadingCount` — the caller MUST then skip injection (never misassign).
 * `stripFrontmatter` defaults to false here: the rendered content handed to the
 * decorate step is already frontmatter-stripped.
 */
export const planHeadingIds = (
  content: string,
  renderedHeadingCount: number,
  options: ExtractTocOptions = {},
): string[] | null => {
  const toc = extractToc(content, {
    stripFrontmatter: options.stripFrontmatter ?? false,
    existingIds: options.existingIds,
  });
  if (toc.length !== renderedHeadingCount) return null;
  return toc.map((entry) => entry.slug);
};
