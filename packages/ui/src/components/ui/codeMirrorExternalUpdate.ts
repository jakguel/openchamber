import type { Text } from '@codemirror/state';
import { ChangeSet, EditorSelection } from '@codemirror/state';

/** Adjacent delete+insert lines this similar (0..1) are classified as an in-place replace. */
export const EXTERNAL_UPDATE_REPLACE_SIMILARITY = 0.5;

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

type Change = { from: number; to: number; insert: string };

/**
 * Turns an ordered op list into old-doc-coordinate CM change specs. Every op is
 * mapped to a scoped change over exactly the lines it touches (never a whole-doc
 * replace shortcut); newline boundaries at the end of the document are handled
 * by consuming the terminator of the preceding line. An adjacent remove+add over
 * the same gap is emitted as one replace region so trailing-empty-line content
 * (e.g. "a" -> "") reconstructs exactly.
 */
function opsToChangeList(ops: LineDiffOp[], oldDoc: Text): Change[] {
  const lineCount = oldDoc.lines;
  const docLen = oldDoc.length;
  const lineStart = (index0: number): number => oldDoc.line(index0 + 1).from;

  const emitDelete = (s: number, e: number): Change => {
    if (e < lineCount) return { from: lineStart(s), to: lineStart(e), insert: '' };
    return { from: s > 0 ? oldDoc.line(s).to : 0, to: docLen, insert: '' };
  };
  const emitReplace = (s: number, e: number, newLines: string[]): Change => {
    const text = newLines.join('\n');
    if (e < lineCount) return { from: lineStart(s), to: lineStart(e), insert: `${text}\n` };
    return { from: s > 0 ? oldDoc.line(s).to : 0, to: docLen, insert: s > 0 ? `\n${text}` : text };
  };
  const emitInsert = (anchorOld: number, newLines: string[]): Change => {
    const text = newLines.join('\n');
    if (anchorOld < lineCount) return { from: lineStart(anchorOld), to: lineStart(anchorOld), insert: `${text}\n` };
    if (docLen === 0) return { from: 0, to: 0, insert: text };
    return { from: docLen, to: docLen, insert: `\n${text}` };
  };

  const changes: Change[] = [];
  let oldPos = 0;
  let newPos = 0;
  for (let idx = 0; idx < ops.length; idx += 1) {
    const op = ops[idx];
    if (op.type === 'remove') {
      const s = op.oldStart;
      const e = s + op.oldLines.length;
      newPos += s - oldPos;
      oldPos = s;
      const next = ops[idx + 1];
      if (next && next.type === 'add' && next.newStart === newPos) {
        changes.push(emitReplace(s, e, next.newLines));
        oldPos = e;
        newPos = next.newStart + next.newLines.length;
        idx += 1;
      } else {
        changes.push(emitDelete(s, e));
        oldPos = e;
      }
    } else if (op.type === 'add') {
      oldPos += op.newStart - newPos;
      newPos = op.newStart;
      changes.push(emitInsert(oldPos, op.newLines));
      newPos = op.newStart + op.newLines.length;
    } else {
      const s = op.oldStart;
      const e = s + op.oldLines.length;
      oldPos = s;
      newPos = op.newStart;
      changes.push(emitReplace(s, e, op.newLines));
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
 * ChangeSet plus a remapped selection, derived purely from the line diff. There
 * is deliberately NO whole-doc-replace path — the version-bump handler must
 * always dispatch mapped per-change edits so CodeMirror maps selection/scroll.
 * A cursor that sat inside a removed/replaced region snaps to the nearest
 * surviving line start; cursors elsewhere map by CM's default position mapping.
 * Returns `null` when the content is byte-identical or the diff is degenerate
 * (no dispatch — never a full replace).
 */
export function buildExternalUpdateTransaction(
  oldDoc: Text,
  newContent: string,
  selection?: EditorSelection,
): { changes: ChangeSet; selection?: EditorSelection } | null {
  if (oldDoc.toString() === newContent) return null;

  // WI4: large-diff instant-apply gate belongs upstream (skips animation, not mapping).
  const ops = computeLineDiff(oldDoc.toString(), newContent);
  const changeList = opsToChangeList(ops, oldDoc);
  if (changeList.length === 0) return null;

  const changes = ChangeSet.of(changeList, oldDoc.length);

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

  return { changes, selection: mappedSelection };
}
