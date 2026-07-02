import type { EditorState, Extension, Range } from '@codemirror/state';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

import {
  buildExternalUpdateTransaction,
  computeLineDiff,
  type LineDiffOp,
} from '@/components/ui/codeMirrorExternalUpdate';

// One-shot animated decorations for the live external-diff feature (WI3). These
// compose ADDITIVELY with the Shiki decoration field (never resetting it) via a
// dedicated StateField in its own compartment. Doc mutation is done upstream by
// WI2's mapped per-change transaction; here we only paint transient feedback:
//
//   - added + replaced lines -> a `.cm-line-added` line decoration whose CSS
//     @keyframes animates green -> transparent (hold then fade), removed by a
//     single post-animation timer (no per-frame decoration rebuild).
//   - removed lines -> a red height-collapse block widget, capped at
//     LIVE_DIFF_CONCURRENT_COLLAPSE_CAP concurrent collapses; above the cap the
//     removal is instant (no widget) — the R1 scroll-oscillation mitigation.
//   - replaced spans -> an underline mark (`.cm-live-diff-replaced-span`),
//     distinct from Shiki's FONT_STYLE_UNDERLINE (own class, own compartment).
//
// CSS lives in packages/ui/src/index.css. The durations below are the source of
// truth for the removal timers; the CSS @keyframes durations mirror them.

/** Green flash hold before the fade begins. */
export const LIVE_DIFF_FLASH_HOLD_MS = 2000;
/** Green flash fade-out length after the hold. */
export const LIVE_DIFF_FLASH_FADE_MS = 800;
/** Total green-flash lifetime; the single flash-clear timer fires at this mark. */
export const LIVE_DIFF_FLASH_DURATION_MS = LIVE_DIFF_FLASH_HOLD_MS + LIVE_DIFF_FLASH_FADE_MS;
/** Red height-collapse lifetime; the collapse-clear timer fires at this mark. */
export const LIVE_DIFF_COLLAPSE_MS = 800;
/**
 * Conservative cap on simultaneously-collapsing removed-line widgets. Document
 * height animation is this repo's scroll-oscillation class; above the cap we
 * fall back to instant remove (no height animation). Keep this conservative.
 */
export const LIVE_DIFF_CONCURRENT_COLLAPSE_CAP = 8;

/**
 * Conservative ceiling on the total changed lines (added + replaced + removed)
 * an external update may animate. Above it, the whole diff routes to the same
 * instant-apply path as the concurrent-collapse fallback — mass-widget jank on
 * big diffs is the same scroll-oscillation class. Keep this conservative.
 */
export const LIVE_DIFF_MAX_ANIMATED_CHANGES = 200;

/**
 * Reduced-motion read via the repo's guarded matchMedia pattern
 * (FadeInOnReveal.tsx). Server/no-DOM contexts report no preference.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function countLiveDiffChanges(ops: readonly LineDiffOp[]): number {
  let total = 0;
  for (const op of ops) {
    if (op.type === 'add') total += op.newLines.length;
    else if (op.type === 'replace') total += op.newLines.length;
    else total += op.oldLines.length;
  }
  return total;
}

/**
 * WI4 large-diff entry gate: build the animation plan for an external update, or
 * return null to route to the instant-apply path when the change count exceeds
 * LIVE_DIFF_MAX_ANIMATED_CHANGES. Reduced-motion is gated by the caller (the
 * `animate` flag on applyExternalUpdate); the mapped transaction is unaffected.
 */
export function planLiveDiffAnimation(oldText: string, newText: string): LiveDiffPlan | null {
  const ops = computeLineDiff(oldText, newText);
  if (countLiveDiffChanges(ops) > LIVE_DIFF_MAX_ANIMATED_CHANGES) return null;
  return computeLiveDiffPlan(ops);
}

type LiveDiffKind = 'flash' | 'underline' | 'collapse';

const GEN_ATTR = 'data-livediff-gen';
const KIND_ATTR = 'data-livediff-kind';

/** New-doc-coordinate decoration plan derived from a WI2 line-diff op list. */
export interface LiveDiffPlan {
  /** Added-line ranges as 0-based [startLine, endLine) in the NEW doc. */
  addedLines: Array<{ startLine: number; endLine: number }>;
  /** Replaced-line ranges (0-based new-doc) plus old/new content for within-line spans. */
  replacedLines: Array<{
    startLine: number;
    endLine: number;
    oldLines: readonly string[];
    newLines: readonly string[];
  }>;
  /** Removal anchors: `atLine` is the 0-based new-doc line the collapse sits above. */
  removals: Array<{ atLine: number; lines: readonly string[] }>;
}

/** Block widget that renders removed lines in red and collapses its own height. */
class RemovedLinesWidget extends WidgetType {
  constructor(
    readonly lines: readonly string[],
    readonly gen: number,
  ) {
    super();
  }

  eq(other: RemovedLinesWidget): boolean {
    return other.gen === this.gen && other.lines === this.lines;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'oc-live-diff-removed';
    // TS-sourced duration so the collapse timing tracks LIVE_DIFF_COLLAPSE_MS.
    el.style.animationDuration = `${LIVE_DIFF_COLLAPSE_MS}ms`;
    for (const text of this.lines) {
      const row = document.createElement('div');
      row.className = 'oc-live-diff-removed-line';
      row.textContent = text.length > 0 ? text : '\u200b';
      el.appendChild(row);
    }
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface DecoMeta {
  gen?: number;
  kind?: LiveDiffKind;
}

const decoMeta = (value: Decoration): DecoMeta => {
  const spec = value.spec as { widget?: unknown; attributes?: Record<string, string> };
  if (spec.widget instanceof RemovedLinesWidget) {
    return { gen: spec.widget.gen, kind: 'collapse' };
  }
  const attrs = spec.attributes;
  if (attrs && attrs[GEN_ATTR] != null) {
    return { gen: Number(attrs[GEN_ATTR]), kind: attrs[KIND_ATTR] as LiveDiffKind };
  }
  return {};
};

/** Effect carrying a batch of live-diff decoration ranges to add to the field. */
export const addLiveDiffEffect = StateEffect.define<readonly Range<Decoration>[]>();
/** Effect removing every decoration of `gen` whose kind is in `kinds`. */
export const clearLiveDiffEffect = StateEffect.define<{ gen: number; kinds: readonly LiveDiffKind[] }>();

/**
 * Additive decoration field for live-diff feedback. It maps its decorations
 * through edits (cheap) and only mutates its set on explicit add/clear effects —
 * never rebuilt per view update. It is fully independent of the Shiki field.
 */
export const liveDiffField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(addLiveDiffEffect)) {
        next = next.update({ add: [...effect.value], sort: true });
      } else if (effect.is(clearLiveDiffEffect)) {
        const { gen, kinds } = effect.value;
        next = next.update({
          filter: (_from, _to, value) => {
            const meta = decoMeta(value);
            if (meta.gen !== gen || meta.kind == null) return true;
            return !kinds.includes(meta.kind);
          },
        });
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The live-diff decoration extension. Static — mount once, drive via effects. */
export function liveDiffDecorationsExtension(): Extension {
  return [liveDiffField];
}

/**
 * Turns a WI2 line-diff op list into a NEW-doc-coordinate decoration plan. The
 * old/new position tracking mirrors `opsToChangeList` so removal anchors land at
 * the surviving line that now occupies the removed slot.
 */
export function computeLiveDiffPlan(ops: readonly LineDiffOp[]): LiveDiffPlan {
  const plan: LiveDiffPlan = { addedLines: [], replacedLines: [], removals: [] };
  let oldPos = 0;
  let newPos = 0;
  for (const op of ops) {
    if (op.type === 'add') {
      oldPos += op.newStart - newPos;
      newPos = op.newStart;
      plan.addedLines.push({ startLine: op.newStart, endLine: op.newStart + op.newLines.length });
      newPos = op.newStart + op.newLines.length;
    } else if (op.type === 'replace') {
      oldPos = op.oldStart;
      newPos = op.newStart;
      plan.replacedLines.push({
        startLine: op.newStart,
        endLine: op.newStart + op.newLines.length,
        oldLines: op.oldLines,
        newLines: op.newLines,
      });
      oldPos = op.oldStart + op.oldLines.length;
      newPos = op.newStart + op.newLines.length;
    } else {
      const s = op.oldStart;
      newPos += s - oldPos;
      oldPos = s;
      plan.removals.push({ atLine: newPos, lines: op.oldLines });
      oldPos = s + op.oldLines.length;
    }
  }
  return plan;
}

/** Minimal within-line span of the NEW line that differs (prefix/suffix trimmed). */
function withinLineSpan(oldLine: string, newLine: string): { from: number; to: number } | null {
  if (oldLine === newLine) return null;
  const minLen = Math.min(oldLine.length, newLine.length);
  let start = 0;
  while (start < minLen && oldLine[start] === newLine[start]) start += 1;
  let oldEnd = oldLine.length;
  let newEnd = newLine.length;
  while (oldEnd > start && newEnd > start && oldLine[oldEnd - 1] === newLine[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  if (newEnd <= start) return null;
  return { from: start, to: newEnd };
}

export interface BuildLiveDiffOptions {
  gen: number;
  /** Collapse widgets already live in the field, counted against the cap. */
  activeCollapses: number;
  cap?: number;
}

export interface BuiltLiveDiff {
  ranges: Range<Decoration>[];
  /** How many collapse widgets this batch actually created (<= cap headroom). */
  addedCollapses: number;
}

/**
 * Builds the decoration ranges for a plan against the POST-dispatch (new-doc)
 * state. Added/replaced lines get the green flash line class; replaced lines
 * additionally get an underline mark over the differing span; removals get a
 * capped red collapse widget (overflow removals are instant — no widget).
 */
export function buildLiveDiffDecorations(
  state: EditorState,
  plan: LiveDiffPlan,
  options: BuildLiveDiffOptions,
): BuiltLiveDiff {
  const cap = options.cap ?? LIVE_DIFF_CONCURRENT_COLLAPSE_CAP;
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  const gen = String(options.gen);

  const pushFlashLine = (lineIndex0: number): void => {
    const lineNo = lineIndex0 + 1;
    if (lineNo < 1 || lineNo > doc.lines) return;
    ranges.push(
      Decoration.line({
        class: 'cm-line-added',
        attributes: { [KIND_ATTR]: 'flash', [GEN_ATTR]: gen },
      }).range(doc.line(lineNo).from),
    );
  };

  for (const added of plan.addedLines) {
    for (let line = added.startLine; line < added.endLine; line += 1) pushFlashLine(line);
  }

  for (const replaced of plan.replacedLines) {
    for (let line = replaced.startLine; line < replaced.endLine; line += 1) pushFlashLine(line);
    for (let i = 0; i < replaced.newLines.length; i += 1) {
      const span = withinLineSpan(replaced.oldLines[i] ?? '', replaced.newLines[i] ?? '');
      if (!span) continue;
      const lineNo = replaced.startLine + i + 1;
      if (lineNo < 1 || lineNo > doc.lines) continue;
      const line = doc.line(lineNo);
      const from = line.from + Math.min(span.from, line.length);
      const to = line.from + Math.min(span.to, line.length);
      if (to <= from) continue;
      ranges.push(
        Decoration.mark({
          class: 'cm-live-diff-replaced-span',
          attributes: { [KIND_ATTR]: 'underline', [GEN_ATTR]: gen },
        }).range(from, to),
      );
    }
  }

  let addedCollapses = 0;
  for (const removal of plan.removals) {
    if (options.activeCollapses + addedCollapses >= cap) continue; // instant remove: no widget
    const atEnd = removal.atLine >= doc.lines;
    const pos = atEnd ? doc.length : doc.line(removal.atLine + 1).from;
    ranges.push(
      Decoration.widget({
        widget: new RemovedLinesWidget(removal.lines, options.gen),
        block: true,
        side: atEnd ? 1 : -1,
      }).range(pos),
    );
    addedCollapses += 1;
  }

  return { ranges, addedCollapses };
}

/** Counts live collapse widgets in a decoration set (for the concurrent cap). */
export function countActiveCollapses(set: DecorationSet): number {
  let count = 0;
  const iter = set.iter();
  while (iter.value) {
    if (decoMeta(iter.value).kind === 'collapse') count += 1;
    iter.next();
  }
  return count;
}

/**
 * Arms the one-shot removal timers for a batch: collapse widgets clear at
 * LIVE_DIFF_COLLAPSE_MS, flash + underline clear at LIVE_DIFF_FLASH_DURATION_MS.
 * Two timers, no per-frame work. Timers self-prune from the returned set on fire.
 */
export function scheduleLiveDiffClears(
  gen: number,
  dispatch: (payload: { gen: number; kinds: LiveDiffKind[] }) => void,
  durations: { collapseMs: number; flashMs: number } = {
    collapseMs: LIVE_DIFF_COLLAPSE_MS,
    flashMs: LIVE_DIFF_FLASH_DURATION_MS,
  },
): Set<ReturnType<typeof setTimeout>> {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const arm = (ms: number, kinds: LiveDiffKind[]): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      dispatch({ gen, kinds });
    }, ms);
    timers.add(timer);
  };
  arm(durations.collapseMs, ['collapse']);
  arm(durations.flashMs, ['flash', 'underline']);
  return timers;
}

const planHasWork = (plan: LiveDiffPlan): boolean =>
  plan.addedLines.length > 0 || plan.replacedLines.length > 0 || plan.removals.length > 0;

let liveDiffGeneration = 0;

/**
 * Applies one batch of live-diff decorations for a just-dispatched external
 * update: builds the ranges against the current (new-doc) state honoring the
 * concurrent-collapse cap, adds them in one effect, then arms the removal timers.
 */
export function applyLiveDiffDecorations(view: EditorView, plan: LiveDiffPlan): void {
  if (!planHasWork(plan)) return;
  const gen = (liveDiffGeneration += 1);
  const current = view.state.field(liveDiffField, false) ?? Decoration.none;
  const { ranges } = buildLiveDiffDecorations(view.state, plan, {
    gen,
    activeCollapses: countActiveCollapses(current),
  });
  if (ranges.length === 0) return;
  view.dispatch({ effects: addLiveDiffEffect.of(ranges) });
  scheduleLiveDiffClears(gen, (payload) => {
    if (view.dom.isConnected) view.dispatch({ effects: clearLiveDiffEffect.of(payload) });
  });
}

/**
 * External-update seam (the single entry WI4 will later gate). Dispatches the
 * WI2 mapped per-change transaction, then — when `animate` is true — paints the
 * one-shot live-diff decorations. When `animate` is false the update applies
 * with NO decorations (the shared instant path WI4 routes reduced-motion /
 * large-file changes through). Returns false when there was nothing to apply.
 */
export function applyExternalUpdate(
  view: EditorView,
  newContent: string,
  options: { animate: boolean },
): boolean {
  const oldDoc = view.state.doc;
  const result = buildExternalUpdateTransaction(oldDoc, newContent, view.state.selection);
  if (!result) return false;
  const plan = options.animate ? planLiveDiffAnimation(oldDoc.toString(), newContent) : null;
  view.dispatch(
    result.selection ? { changes: result.changes, selection: result.selection } : { changes: result.changes },
  );
  if (plan) applyLiveDiffDecorations(view, plan);
  return true;
}
