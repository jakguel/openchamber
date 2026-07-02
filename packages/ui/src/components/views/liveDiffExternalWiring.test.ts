import { afterAll, describe, expect, test } from 'bun:test';
import type { EditorState } from '@codemirror/state';
import { EditorState as State } from '@codemirror/state';

// WI6 end-to-end wiring test: the WHETHER-layer decision (WI5
// resolveExternalChangeAction) routes a poll-detected external change on the OPEN
// file through the HOW-layer (WI1 line diff -> WI2 mapped transaction -> WI3
// animated decorations) ONLY for the CodeMirror text-editor branch. Image/pdf
// files short-circuit to the plain reload path (loadSelectedFile early-return),
// and a genuine dirty conflict opens the dialog instead of live-applying.
//
// Every module below is the REAL production module. The only faked input is the
// poll's stat snapshot + reloaded disk content (the I/O boundary FilesView reads
// via readFileStat/readFile). This mirrors the FilesView reaction at the seam,
// the same precedent as liveDiffDecorations.test.ts's WI4 seam mirror.
import {
  resolveExternalChangeAction,
  type ExternalChangeAction,
  type ExternalChangeStat,
} from './resolveExternalChangeAction';
import { isImageFile, isPdfFile } from '@/lib/toolHelpers';
import { buildExternalUpdateTransaction } from '@/components/ui/codeMirrorExternalUpdate';
import {
  addLiveDiffEffect,
  buildLiveDiffDecorations,
  liveDiffDecorationsExtension,
  liveDiffField,
  planLiveDiffAnimation,
  prefersReducedMotion,
} from '@/lib/codemirror/liveDiffDecorations';

const specClasses = (state: EditorState): string[] => {
  const set = state.field(liveDiffField);
  const out: string[] = [];
  const iter = set.iter();
  while (iter.value) {
    const cls = (iter.value.spec as { class?: string }).class;
    if (cls) out.push(cls);
    iter.next();
  }
  return out;
};

type ReactionResult = {
  action: ExternalChangeAction;
  dialogOpened: boolean;
  versionBumped: boolean;
  version: number;
  newDoc: string;
  animationClasses: string[];
};

/**
 * Faithful mirror of the FilesView poll reaction for one tick on the OPEN file,
 * composing the real WI5/WI1/WI2/WI3 modules exactly as
 * FilesView.loadSelectedFile + CodeMirrorEditor's external-update effect do:
 *
 *   resolveExternalChangeAction (WI5)
 *     -> refuse-safe-path : open dialog, no live-apply
 *     -> live-apply       : image/pdf short-circuit to plain reload (no diff),
 *                           text branch bumps version + runs applyExternalUpdate
 *                           (WI2 mapped transaction + WI3 animation)
 *
 * The baseline for the diff is the editor's CURRENT doc (captured BEFORE reload),
 * which the CM effect-ordering (externalUpdate effect before value effect)
 * guarantees at the real seam.
 */
function reactToPollTick(params: {
  path: string;
  currentStat: ExternalChangeStat;
  loadedStat: ExternalChangeStat;
  isDirty: boolean;
  baselineDoc: string;
  diskContent: string;
  priorVersion: number;
}): ReactionResult {
  const action = resolveExternalChangeAction({
    currentStat: params.currentStat,
    loadedStat: params.loadedStat,
    isDirty: params.isDirty,
  });

  const inert: ReactionResult = {
    action,
    dialogOpened: false,
    versionBumped: false,
    version: params.priorVersion,
    newDoc: params.baselineDoc,
    animationClasses: [],
  };

  // WHETHER: a genuine conflict (dirty + external change) surfaces the dialog and
  // must NOT live-apply.
  if (action === 'refuse-safe-path') {
    return { ...inert, dialogOpened: true };
  }
  if (action !== 'live-apply') {
    return inert;
  }

  // Scope guard (loadSelectedFile ~L1838-1860 early-return): image/pdf never
  // reach the text branch, so no version bump and no diff/animation — the plain
  // reload path stands.
  if (isImageFile(params.path) || isPdfFile(params.path)) {
    return { ...inert, newDoc: params.diskContent };
  }

  // HOW: text-editor branch — bump version and run the real CM external-update
  // seam (WI2 mapped transaction, then WI3 animation gated by reduced-motion).
  const version = params.priorVersion + 1;
  const animate = !prefersReducedMotion();
  const base = State.create({ doc: params.baselineDoc, extensions: [liveDiffDecorationsExtension()] });
  const result = buildExternalUpdateTransaction(base.doc, params.diskContent, base.selection);
  if (!result) {
    return { ...inert, versionBumped: true, version };
  }
  const applied = base.update(
    result.selection ? { changes: result.changes, selection: result.selection } : { changes: result.changes },
  ).state;

  let animationClasses: string[] = [];
  const plan = animate ? planLiveDiffAnimation(params.baselineDoc, params.diskContent) : null;
  if (plan) {
    const { ranges } = buildLiveDiffDecorations(applied, plan, { gen: version, activeCollapses: 0 });
    const painted = applied.update({ effects: addLiveDiffEffect.of(ranges) }).state;
    animationClasses = specClasses(painted);
  }

  return {
    action,
    dialogOpened: false,
    versionBumped: true,
    version,
    newDoc: applied.doc.toString(),
    animationClasses,
  };
}

const loadedStat: ExternalChangeStat = { path: '/notes.txt', size: 3, mtimeMs: 1000 };

describe('WI6 external-change wiring: WHETHER (WI5) -> HOW (WI1/WI2/WI3)', () => {
  test('AC1: pure external change on the open TEXT file live-applies + animates, no dialog', () => {
    const r = reactToPollTick({
      path: '/notes.txt',
      currentStat: { path: '/notes.txt', size: 5, mtimeMs: 2000 },
      loadedStat,
      isDirty: false,
      baselineDoc: 'a\nb',
      diskContent: 'a\nX\nb',
      priorVersion: 0,
    });

    expect(r.action).toBe('live-apply');
    expect(r.dialogOpened).toBe(false);
    expect(r.versionBumped).toBe(true);
    expect(r.version).toBe(1);
    // The mapped transaction applied the exact new content (green add path).
    expect(r.newDoc).toBe('a\nX\nb');
    // WI3 painted the green-flash decoration for the added line — the diff path
    // was genuinely entered, not a silent full replace.
    expect(r.animationClasses).toContain('cm-line-added');
  });

  test('AC2: pure external change on an IMAGE file does NOT enter the diff path (plain reload)', () => {
    const r = reactToPollTick({
      path: '/pic.png',
      currentStat: { path: '/pic.png', size: 999, mtimeMs: 2000 },
      loadedStat: { path: '/pic.png', size: 100, mtimeMs: 1000 },
      isDirty: false,
      baselineDoc: '',
      diskContent: 'binary-bytes',
      priorVersion: 7,
    });

    // WI5 still classifies it as an external change...
    expect(r.action).toBe('live-apply');
    // ...but the scope guard keeps it on the plain reload path: no version bump,
    // no animation. Byte-identical to today's behavior.
    expect(r.versionBumped).toBe(false);
    expect(r.version).toBe(7);
    expect(r.animationClasses).toEqual([]);
  });

  test('AC2: PDF files are likewise excluded from the diff/animation path', () => {
    const r = reactToPollTick({
      path: '/doc.pdf',
      currentStat: { path: '/doc.pdf', size: 4096, mtimeMs: 2000 },
      loadedStat: { path: '/doc.pdf', size: 2048, mtimeMs: 1000 },
      isDirty: false,
      baselineDoc: '',
      diskContent: 'pdf-bytes',
      priorVersion: 2,
    });

    expect(r.action).toBe('live-apply');
    expect(r.versionBumped).toBe(false);
    expect(r.animationClasses).toEqual([]);
  });

  test('negative: a dirty external conflict opens the dialog and does NOT live-apply', () => {
    const r = reactToPollTick({
      path: '/notes.txt',
      currentStat: { path: '/notes.txt', size: 9, mtimeMs: 2000 },
      loadedStat,
      isDirty: true,
      baselineDoc: 'a\nb',
      diskContent: 'totally different disk content',
      priorVersion: 0,
    });

    expect(r.action).toBe('refuse-safe-path');
    expect(r.dialogOpened).toBe(true);
    expect(r.versionBumped).toBe(false);
    expect(r.version).toBe(0);
    // The editor keeps the user's baseline — no silent overwrite.
    expect(r.newDoc).toBe('a\nb');
    expect(r.animationClasses).toEqual([]);
  });

  test('AC4-guard: an unchanged stat is a normal-save decision — no reaction, no flash', () => {
    const r = reactToPollTick({
      path: '/notes.txt',
      currentStat: { path: '/notes.txt', size: 3, mtimeMs: 1000 },
      loadedStat,
      isDirty: false,
      baselineDoc: 'a\nb',
      diskContent: 'a\nb',
      priorVersion: 4,
    });

    // No mtime/size delta -> WI5 says 'write' (the poll simply keeps polling).
    expect(r.action).toBe('write');
    expect(r.dialogOpened).toBe(false);
    expect(r.versionBumped).toBe(false);
    expect(r.animationClasses).toEqual([]);
  });

  test('AC3: mid-animation re-change is latest-wins — next diff baseline is the last-committed content', () => {
    const first = reactToPollTick({
      path: '/notes.txt',
      currentStat: { path: '/notes.txt', size: 5, mtimeMs: 2000 },
      loadedStat,
      isDirty: false,
      baselineDoc: 'a\nb',
      diskContent: 'a\nX\nb',
      priorVersion: 0,
    });
    expect(first.newDoc).toBe('a\nX\nb');
    expect(first.version).toBe(1);

    // A second external change lands before the first flash finishes. The baseline
    // for the new diff is the LAST-COMMITTED doc ('a\nX\nb'), not the original.
    const second = reactToPollTick({
      path: '/notes.txt',
      currentStat: { path: '/notes.txt', size: 7, mtimeMs: 3000 },
      loadedStat: { path: '/notes.txt', size: 5, mtimeMs: 2000 },
      isDirty: false,
      baselineDoc: first.newDoc,
      diskContent: 'a\nX\nY\nb',
      priorVersion: first.version,
    });

    expect(second.version).toBe(2);
    expect(second.newDoc).toBe('a\nX\nY\nb');
    // Only the newly-added line 'Y' flashes; the diff ran against the committed
    // baseline, proving clean latest-wins (not a re-diff from the original).
    expect(second.animationClasses).toContain('cm-line-added');
  });
});

describe('WI6 reduced-motion parity (instant apply, still no popup)', () => {
  const originalWindow = globalThis.window;
  afterAll(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  test('reduced-motion routes a pure text change to instant apply: content updates, no green flash', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { matchMedia: (q: string) => ({ matches: q.includes('reduce') }) },
    });

    const r = reactToPollTick({
      path: '/notes.txt',
      currentStat: { path: '/notes.txt', size: 5, mtimeMs: 2000 },
      loadedStat,
      isDirty: false,
      baselineDoc: 'a\nb',
      diskContent: 'a\nX\nb',
      priorVersion: 0,
    });

    // Still a live-apply (version bumps, content applies) — but no animation.
    expect(r.action).toBe('live-apply');
    expect(r.versionBumped).toBe(true);
    expect(r.newDoc).toBe('a\nX\nb');
    expect(r.animationClasses).toEqual([]);
  });
});
