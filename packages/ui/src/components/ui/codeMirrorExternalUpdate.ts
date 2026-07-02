import type { Text } from '@codemirror/state';
import { ChangeSet, EditorSelection } from '@codemirror/state';

/** Adjacent delete+insert lines this similar (0..1) are classified as an in-place replace. */
export const EXTERNAL_UPDATE_REPLACE_SIMILARITY = 0.5;

/** Above this old*new line-count product the diff bails to a single whole-doc replace (perf guard). */
const EXTERNAL_UPDATE_DIFF_CELL_CAP = 4_000_000;

/** Mirrors the op shape of the `editor-diff` module so the local diff can be swapped for the shared one. */
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

/** Character-level normalized LCS similarity of two lines, in [0, 1]. */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const denom = a.length + b.length;
  if (denom === 0) return 1;
  // LCS length via rolling DP (lines are short).
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }
  return (2 * prev[n]) / denom;
}

/**
 * Pure line-level diff: emits an ordered add/remove/replace op list transforming
 * `oldText` into `newText`. A del-run immediately followed by an equal-length
 * ins-run whose every paired line is >= EXTERNAL_UPDATE_REPLACE_SIMILARITY is
 * classified as an in-place `replace`; otherwise it stays a `remove` + `add`.
 */
export function computeLineDiff(oldText: string, newText: string): LineDiffOp[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  if (oldLines.length * newLines.length > EXTERNAL_UPDATE_DIFF_CELL_CAP) {
    return [
      {
        type: 'replace',
        oldStart: 0,
        newStart: 0,
        oldLines,
        newLines,
        withinLine: [],
      },
    ];
  }

  // Line-level LCS DP.
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Backtrack into a per-line script of equal / del / ins entries.
  type Entry = { tag: 'equal' | 'del' | 'ins'; oldIndex: number; newIndex: number };
  const script: Entry[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      script.push({ tag: 'equal', oldIndex: i, newIndex: j });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      script.push({ tag: 'del', oldIndex: i, newIndex: j });
      i += 1;
    } else {
      script.push({ tag: 'ins', oldIndex: i, newIndex: j });
      j += 1;
    }
  }
  while (i < m) {
    script.push({ tag: 'del', oldIndex: i, newIndex: j });
    i += 1;
  }
  while (j < n) {
    script.push({ tag: 'ins', oldIndex: i, newIndex: j });
    j += 1;
  }

  // Group consecutive del/ins runs and classify replace vs remove+add.
  const ops: LineDiffOp[] = [];
  let k = 0;
  while (k < script.length) {
    const entry = script[k];
    if (entry.tag === 'equal') {
      k += 1;
      continue;
    }
    // Collect a maximal del-run then a maximal ins-run (diff emits del before ins).
    const delLines: string[] = [];
    const delStart = entry.oldIndex;
    while (k < script.length && script[k].tag === 'del') {
      delLines.push(oldLines[script[k].oldIndex]);
      k += 1;
    }
    const insLines: string[] = [];
    let insStart = k < script.length ? script[k].newIndex : entry.newIndex;
    while (k < script.length && script[k].tag === 'ins') {
      if (insLines.length === 0) insStart = script[k].newIndex;
      insLines.push(newLines[script[k].newIndex]);
      k += 1;
    }

    if (delLines.length > 0 && insLines.length > 0) {
      const sameLength = delLines.length === insLines.length;
      const allSimilar =
        sameLength && delLines.every((line, idx) => lineSimilarity(line, insLines[idx]) >= EXTERNAL_UPDATE_REPLACE_SIMILARITY);
      if (allSimilar) {
        ops.push({
          type: 'replace',
          oldStart: delStart,
          newStart: insStart,
          oldLines: delLines,
          newLines: insLines,
          withinLine: [],
        });
      } else {
        ops.push({ type: 'remove', oldStart: delStart, oldLines: delLines });
        ops.push({ type: 'add', newStart: insStart, newLines: insLines });
      }
    } else if (delLines.length > 0) {
      ops.push({ type: 'remove', oldStart: delStart, oldLines: delLines });
    } else if (insLines.length > 0) {
      ops.push({ type: 'add', newStart: insStart, newLines: insLines });
    }
  }

  return ops;
}

/** Turns an ordered op list into old-doc-coordinate CM change specs (per-change, not full replace). */
function opsToChangeList(ops: LineDiffOp[], oldDoc: Text): Array<{ from: number; to: number; insert: string }> {
  const lineCount = oldDoc.lines;
  const docLen = oldDoc.length;
  const lineStart = (index0: number): number => oldDoc.line(index0 + 1).from;
  // Range covering old lines [s, e) as a deletion, handling the end-of-doc newline.
  const delRange = (s: number, e: number): { from: number; to: number } => {
    if (e < lineCount) return { from: lineStart(s), to: lineStart(e) };
    if (s > 0) return { from: oldDoc.line(s).to, to: docLen }; // consume the newline before line s
    return { from: 0, to: docLen };
  };

  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let oldPos = 0;
  let newPos = 0;
  for (const op of ops) {
    if (op.type === 'remove') {
      const s = op.oldStart;
      const e = op.oldStart + op.oldLines.length;
      newPos += s - oldPos;
      oldPos = s;
      const r = delRange(s, e);
      changes.push({ from: r.from, to: r.to, insert: '' });
      oldPos = e;
    } else if (op.type === 'add') {
      const anchorNew = op.newStart;
      oldPos += anchorNew - newPos;
      newPos = anchorNew;
      const anchorOld = oldPos;
      if (anchorOld < lineCount) {
        const from = lineStart(anchorOld);
        changes.push({ from, to: from, insert: `${op.newLines.join('\n')}\n` });
      } else {
        const insert = docLen === 0 ? op.newLines.join('\n') : `\n${op.newLines.join('\n')}`;
        changes.push({ from: docLen, to: docLen, insert });
      }
      newPos = anchorNew + op.newLines.length;
    } else {
      const s = op.oldStart;
      const e = op.oldStart + op.oldLines.length;
      oldPos = s;
      newPos = op.newStart;
      const r = delRange(s, e);
      let insert: string;
      if (e < lineCount) insert = `${op.newLines.join('\n')}\n`;
      else if (s > 0) insert = `\n${op.newLines.join('\n')}`;
      else insert = op.newLines.join('\n');
      changes.push({ from: r.from, to: r.to, insert });
      oldPos = e;
      newPos = op.newStart + op.newLines.length;
    }
  }
  return changes;
}

/** True if `pos` sat strictly inside a removed/replaced span of the change set. */
function positionWasRemoved(changes: ChangeSet, pos: number): boolean {
  let removed = false;
  changes.iterChanges((fromA, toA) => {
    if (pos > fromA && pos < toA) removed = true;
  });
  return removed;
}

/**
 * Builds the mapped-transaction payload for an external update: a per-change
 * ChangeSet plus a remapped selection. A cursor that sat inside a removed or
 * replaced region snaps to the nearest surviving line start; cursors elsewhere
 * map by CM's default position mapping (preserving caret/scroll through edits
 * above them). Returns `null` when the content is byte-identical (no dispatch).
 *
 * If the derived per-change set does not reproduce `newContent` exactly (a
 * malformed op list), it falls back to a single whole-doc replace so the
 * document is always correct.
 */
export function buildExternalUpdateTransaction(
  oldDoc: Text,
  newContent: string,
  selection?: EditorSelection,
): { changes: ChangeSet; selection?: EditorSelection; usedFullReplace: boolean } | null {
  if (oldDoc.toString() === newContent) return null;

  const ops = computeLineDiff(oldDoc.toString(), newContent);
  let usedFullReplace = false;
  let changes = ChangeSet.of(opsToChangeList(ops, oldDoc), oldDoc.length);
  if (changes.apply(oldDoc).toString() !== newContent) {
    changes = ChangeSet.of([{ from: 0, to: oldDoc.length, insert: newContent }], oldDoc.length);
    usedFullReplace = true;
  }

  let mappedSelection: EditorSelection | undefined;
  if (selection) {
    const newDoc = changes.apply(oldDoc);
    const snap = (pos: number): number => {
      const mapped = changes.mapPos(pos, -1);
      return positionWasRemoved(changes, pos) ? newDoc.lineAt(mapped).from : mapped;
    };
    const ranges = selection.ranges.map((range) => EditorSelection.range(snap(range.anchor), snap(range.head)));
    mappedSelection = EditorSelection.create(ranges, selection.mainIndex);
  }

  return { changes, selection: mappedSelection, usedFullReplace };
}
