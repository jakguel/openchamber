import { marked, type Tokens } from 'marked';
import { stripLeadingFrontmatter } from './frontmatter';

/**
 * Table-of-Contents core — the shared data + anchor foundation for the Markdown
 * preview ToC (consumed by the desktop FilesView sidebar and the mobile ToC
 * sheet).
 *
 * Public API (stable — downstream tasks depend on it):
 *  - `extractToc(content, options?)` → ordered `{ depth, text, slug, line }[]` of
 *    the H1–H3 headings, in render order, derived from `marked.lexer` (so setext,
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
  /**
   * 1-based source line of the heading in the FULL ORIGINAL content, INCLUDING
   * any leading frontmatter block (i.e. not relative to the stripped body). Used
   * by the editor-mode ToC to scroll the CodeMirror source to a heading. This
   * field is strictly additive: it never feeds into `slug` / `HEADING_ID_PREFIX`.
   */
  line: number;
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

type RawHeading = { depth: TocDepth; text: string; line: number };

const readArray = (value: unknown): Tokens.Generic[] =>
  Array.isArray(value) ? (value as Tokens.Generic[]) : [];

// Count '\n' occurrences (CRLF counts once — only the '\n' is tallied). Used to
// thread a running 1-based line number through the marked.lexer token walk.
const countNewlines = (value: string): number => {
  let n = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10) n += 1;
  }
  return n;
};

const rawOf = (token: Tokens.Generic): string => (typeof token.raw === 'string' ? token.raw : '');

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
// `baseLine` is the 1-based source line at which `html` starts; each heading's
// line is derived from the newline count in `html` before the tag's match index.
const collectHtmlHeadings = (html: string, out: RawHeading[], baseLine: number): void => {
  const re = /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const depth = Number(match[1]!.slice(1));
    if (!isTocDepth(depth)) continue;
    const inner = (match[2] ?? '').replace(/<[^>]*>/g, '');
    const line = baseLine + countNewlines(html.slice(0, match.index));
    out.push({ depth, text: decodeEntities(inner).replace(/\s+/g, ' ').trim(), line });
  }
};

// Depth-first walk in document order, threading a running 1-based source line.
// `baseLine` is the line at which the FIRST token in `tokens` starts. Recurses
// blockquotes and list items so nested headings are captured; `code` (and
// everything else) contributes no rendered <h1-3>, but its `raw` newlines still
// advance the line counter so a `# ...` line inside a fence neither counts as a
// heading nor corrupts the offset of following headings.
//
// Container newline invariant: for a blockquote, the concatenated child token
// `.raw` reconstructs the source newline structure (only the `> ` marker is
// stripped, never a line break); for a list, the concatenated `item.raw`
// newlines equal the list token's `.raw` newlines. So recursing with the
// container's own start line and then advancing the outer counter by the
// container token's `.raw` newlines stays consistent.
const collectHeadings = (tokens: Tokens.Generic[], out: RawHeading[], baseLine: number): void => {
  let line = baseLine;
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        if (isTocDepth(token.depth)) out.push({ depth: token.depth, text: headingText(token), line });
        break;
      case 'blockquote':
        collectHeadings(readArray(token.tokens), out, line);
        break;
      case 'list': {
        let itemLine = line;
        for (const item of readArray(token.items)) {
          collectHeadings(readArray(item.tokens), out, itemLine);
          itemLine += countNewlines(rawOf(item));
        }
        break;
      }
      case 'html':
        collectHtmlHeadings(rawOf(token) || (typeof token.text === 'string' ? token.text : ''), out, line);
        break;
      default:
        break;
    }
    line += countNewlines(rawOf(token));
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const buildToc = (headings: RawHeading[], existingIds?: Iterable<string>): TocEntry[] => {
  const used = new Set<string>(existingIds ? Array.from(existingIds) : []);
  return headings.map(({ depth, text, line }) => {
    const base = slugifyHeading(text);
    let slug = `${HEADING_ID_PREFIX}${base}`;
    let n = 1;
    while (used.has(slug)) {
      slug = `${HEADING_ID_PREFIX}${base}-${n}`;
      n += 1;
    }
    used.add(slug);
    return { depth, text, slug, line };
  });
};

/**
 * Extract the ordered H1–H3 ToC model from markdown `content`. See the module
 * header for the full contract.
 */
export const extractToc = (content: string, options: ExtractTocOptions = {}): TocEntry[] => {
  const { stripFrontmatter = true, existingIds } = options;
  const source = stripFrontmatter ? stripLeadingFrontmatter(content) : content;
  // Lines removed as leading frontmatter — added back so every heading `line`
  // is absolute in the ORIGINAL content. When nothing is stripped, source ===
  // content and the offset is 0.
  const frontmatterOffset = countNewlines(content.slice(0, content.length - source.length));
  const headings: RawHeading[] = [];
  collectHeadings(marked.lexer(source) as Tokens.Generic[], headings, frontmatterOffset + 1);
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
