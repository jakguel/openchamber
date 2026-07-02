import {
  parseDiffFromFile,
  pushOrJoinSpan,
  type ChangeContent,
  type FileDiffMetadata,
} from '@pierre/diffs';

/**
 * Canonical ordered op emitted by {@link computeLineDiff}.
 *
 * WI2 (CodeMirror mapped transactions) and WI6 (integration) import this EXACT
 * shape, so it must stay stable:
 * - `add`     — new lines with no old counterpart.
 * - `remove`  — old lines with no new counterpart.
 * - `replace` — an in-place edit of `oldLines` -> `newLines`; `withinLine`
 *   carries the changed char spans on each NEW line (for the underline
 *   decoration), keyed by the line's offset within this op's `newLines`.
 *
 * Line numbers (`oldStart`, `newStart`) are 1-based, matching editor line
 * numbering.
 */
export type LineDiffOp =
  | { type: 'add'; newStart: number; newLines: string[] }
  | { type: 'remove'; oldStart: number; oldLines: string[] }
  | {
      type: 'replace';
      oldStart: number;
      newStart: number;
      oldLines: string[];
      newLines: string[];
      withinLine: Array<{ newLineOffset: number; spans: Array<{ from: number; to: number }> }>;
    };

/**
 * A paired (deleted line, added line) whose line-similarity is at or above this
 * threshold is classified as an in-place `replace`; below it, the pair is
 * emitted as a separate `remove` + `add`.
 *
 * Similarity is a normalized Levenshtein score: `1 - levenshtein(a, b) /
 * max(a.length, b.length)`, in `[0, 1]` (two empty lines score `1`).
 */
export const LINE_SIMILARITY_REPLACE_THRESHOLD = 0.5;

/**
 * Filename handed to `parseDiffFromFile`. It only affects language inference
 * for syntax highlighting, which this pure line diff never uses.
 */
const DIFF_FILE_NAME = 'file';

/**
 * Guard for the O(n*m) within-line/similarity comparisons. Lines longer than
 * this fall back to a cheap affix-based similarity and skip within-line span
 * computation. Callers already view-truncate content, so this only bites on
 * pathological single lines.
 */
const MAX_LINE_COMPARE_LENGTH = 5000;

/**
 * Compute an ordered line-level diff between two already-normalized strings.
 *
 * Pure and side-effect-free: no DOM, no CodeMirror, no I/O. The line-level diff
 * reuses `@pierre/diffs` `parseDiffFromFile` (the same Myers engine the rest of
 * the app uses); adjacent delete+insert runs are then classified into `replace`
 * vs separate `remove`/`add` by line similarity. Within-line char spans on
 * replaced lines reuse `@pierre/diffs` `pushOrJoinSpan` (the "word-alt" span
 * joiner) fed by a pure token diff.
 */
export function computeLineDiff(oldText: string, newText: string): LineDiffOp[] {
  if (oldText === newText) {
    return [];
  }

  const meta: FileDiffMetadata = parseDiffFromFile(
    { name: DIFF_FILE_NAME, contents: oldText },
    { name: DIFF_FILE_NAME, contents: newText },
  );

  const ops: LineDiffOp[] = [];
  for (const hunk of meta.hunks) {
    for (const block of hunk.hunkContent) {
      if (block.type !== 'change') {
        continue;
      }
      classifyChangeBlock(block, meta, ops);
    }
  }
  return ops;
}

/**
 * Turn a single `@pierre/diffs` change block (an adjacent delete-run +
 * insert-run) into `add` / `remove` / `replace` ops.
 */
function classifyChangeBlock(
  block: ChangeContent,
  meta: FileDiffMetadata,
  ops: LineDiffOp[],
): void {
  const oldLines = sliceLines(meta.deletionLines, block.deletionLineIndex, block.deletions);
  const newLines = sliceLines(meta.additionLines, block.additionLineIndex, block.additions);
  // Block indices are 0-based into the full-file line arrays; line numbers are 1-based.
  const oldStart = block.deletionLineIndex + 1;
  const newStart = block.additionLineIndex + 1;

  if (oldLines.length === 0) {
    ops.push({ type: 'add', newStart, newLines });
    return;
  }
  if (newLines.length === 0) {
    ops.push({ type: 'remove', oldStart, oldLines });
    return;
  }

  // Pair lines position-wise; group consecutive pairs of the same class so a
  // multi-line block stays a single op per run.
  const pairCount = Math.min(oldLines.length, newLines.length);
  const isReplacePair: boolean[] = [];
  for (let k = 0; k < pairCount; k += 1) {
    isReplacePair.push(
      lineSimilarity(oldLines[k], newLines[k]) >= LINE_SIMILARITY_REPLACE_THRESHOLD,
    );
  }

  let k = 0;
  while (k < pairCount) {
    const asReplace = isReplacePair[k];
    let end = k + 1;
    while (end < pairCount && isReplacePair[end] === asReplace) {
      end += 1;
    }
    const runOld = oldLines.slice(k, end);
    const runNew = newLines.slice(k, end);
    if (asReplace) {
      ops.push({
        type: 'replace',
        oldStart: oldStart + k,
        newStart: newStart + k,
        oldLines: runOld,
        newLines: runNew,
        withinLine: runNew.map((line, index) => ({
          newLineOffset: index,
          spans: computeWithinLineSpans(runOld[index], line),
        })),
      });
    } else {
      ops.push({ type: 'remove', oldStart: oldStart + k, oldLines: runOld });
      ops.push({ type: 'add', newStart: newStart + k, newLines: runNew });
    }
    k = end;
  }

  // Unpaired tail: extra deletions -> remove, extra additions -> add.
  if (oldLines.length > pairCount) {
    ops.push({ type: 'remove', oldStart: oldStart + pairCount, oldLines: oldLines.slice(pairCount) });
  } else if (newLines.length > pairCount) {
    ops.push({ type: 'add', newStart: newStart + pairCount, newLines: newLines.slice(pairCount) });
  }
}

/**
 * Slice `count` lines out of a full-file line array and strip the single
 * trailing newline `@pierre/diffs` retains on each line.
 */
function sliceLines(lines: string[], start: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(stripTrailingNewline(lines[start + i] ?? ''));
  }
  return out;
}

function stripTrailingNewline(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

/**
 * Normalized Levenshtein similarity in `[0, 1]`. Long lines fall back to an
 * affix-overlap ratio to keep the comparison bounded.
 */
function lineSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) {
    return 1;
  }
  if (maxLength > MAX_LINE_COMPARE_LENGTH) {
    return affixSimilarity(a, b, maxLength);
  }
  return 1 - levenshtein(a, b) / maxLength;
}

/** Cheap similarity proxy: shared prefix + suffix length over the longer line. */
function affixSimilarity(a: string, b: string, maxLength: number): number {
  const shared = commonPrefixLength(a, b) + commonSuffixLength(a, b);
  return Math.min(shared, maxLength) / maxLength;
}

/** Classic two-row Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1, // deletion
        current[j - 1] + 1, // insertion
        previous[j - 1] + cost, // substitution
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

/**
 * Changed char spans on the NEW line for a replaced pair, mirroring the
 * `@pierre/diffs` "word-alt" pipeline: a word-level diff whose runs are joined
 * via the exported `pushOrJoinSpan`, then walked into `{ from, to }` offsets.
 * jsdiff is not reachable from this package, so the word items come from a pure
 * token diff instead of `diffWordsWithSpace`.
 */
function computeWithinLineSpans(oldLine: string, newLine: string): Array<{ from: number; to: number }> {
  if (oldLine === newLine || newLine.length === 0) {
    return [];
  }
  if (oldLine.length > MAX_LINE_COMPARE_LENGTH || newLine.length > MAX_LINE_COMPARE_LENGTH) {
    return [];
  }

  const items = wordDiffItems(tokenize(oldLine), tokenize(newLine));
  const additionSpans: Array<[0 | 1, string]> = [];
  const lastItem = items[items.length - 1];
  for (const item of items) {
    const isLastItem = item === lastItem;
    if (!item.added && !item.removed) {
      pushOrJoinSpan({ item, arr: additionSpans, enableJoin: true, isNeutral: true, isLastItem });
    } else if (item.added) {
      pushOrJoinSpan({ item, arr: additionSpans, enableJoin: true, isLastItem });
    }
    // Removed tokens only exist on the deletion side; skip for addition spans.
  }

  const spans: Array<{ from: number; to: number }> = [];
  let offset = 0;
  for (const [kind, value] of additionSpans) {
    if (kind === 1) {
      spans.push({ from: offset, to: offset + value.length });
    }
    offset += value.length;
  }
  return spans;
}

/** Word/whitespace token shape compatible with `pushOrJoinSpan`'s change item. */
interface WordToken {
  value: string;
  added: boolean;
  removed: boolean;
  count: number;
}

/** Split into alternating word and whitespace tokens (jsdiff word semantics). */
function tokenize(line: string): string[] {
  return line.split(/(\s+)/).filter((token) => token.length > 0);
}

/**
 * Ordered word-level diff via LCS: matched tokens are neutral, old-only tokens
 * are `removed`, new-only tokens are `added`. Token counts per line are small,
 * so the O(n*m) table is cheap.
 */
function wordDiffItems(a: string[], b: string[]): WordToken[] {
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const items: WordToken[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      items.push({ value: a[i], added: false, removed: false, count: 1 });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      items.push({ value: a[i], added: false, removed: true, count: 1 });
      i += 1;
    } else {
      items.push({ value: b[j], added: true, removed: false, count: 1 });
      j += 1;
    }
  }
  while (i < m) {
    items.push({ value: a[i], added: false, removed: true, count: 1 });
    i += 1;
  }
  while (j < n) {
    items.push({ value: b[j], added: true, removed: false, count: 1 });
    j += 1;
  }
  return items;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) {
    i += 1;
  }
  return i;
}
