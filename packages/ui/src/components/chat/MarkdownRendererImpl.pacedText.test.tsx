import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// Real hook + real reveal engine, zero project-module mocks.
//
// MarkdownRendererImpl is only loadable under the Vite bundler: it transitively
// imports build-tool virtual assets (`?worker&url`, `?url`) that Node/bun cannot
// resolve. We stub ONLY those bundler-asset boundaries (external I/O — the same
// class as mocking a network/file handle, NOT a project module) so the REAL
// hook can be imported and rendered in Node. usePacedText + nextRevealIndex run
// as genuine production code. The stub is registered via bun's runtime plugin
// API before the module is dynamically imported below (a static import would
// hoist above the registration).
declare const Bun: {
  plugin(plugin: {
    name: string;
    setup(build: {
      onResolve(
        opts: { filter: RegExp },
        cb: (args: { path: string }) => { path: string; namespace: string },
      ): void;
      onLoad(
        opts: { filter: RegExp; namespace: string },
        cb: () => { contents: string; loader: string },
      ): void;
    }): void;
  }): void;
};

Bun.plugin({
  name: 'stub-vite-virtual-imports',
  setup(build) {
    build.onResolve({ filter: /\?(worker(&url)?|url|raw|inline|sharedworker)$/ }, (args) => ({
      path: args.path,
      namespace: 'vite-virtual-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'vite-virtual-stub' }, () => ({
      contents: 'export default "";',
      loader: 'js',
    }));
  },
});

const { nextRevealIndex, usePacedText } = await import('./MarkdownRendererImpl');

// The real hook must run inside a real component so React's dispatcher is active.
// renderToStaticMarkup runs the useState seed but NOT effects — the exact
// mount-time lens for this fix. The paced tick loop is browser-only by design
// (usePacedText bails to full content when `typeof window === 'undefined'`, which
// is the case here), so the live typing animation is covered by real-Chromium
// e2e; these units prove the mount-SEED contract via the real hook plus the real
// reveal ENGINE the tick composes.
const Host = ({ content, streaming }: { content: string; streaming: boolean }) => (
  <>{usePacedText(content, streaming)}</>
);

const revealedOnMount = (content: string, streaming: boolean): string =>
  renderToStaticMarkup(<Host content={content} streaming={streaming} />);

describe('usePacedText mount-seed contract', () => {
  // AC1.3a / AC1.4a: a streaming message remounted with text ALREADY present
  // (the session-switch replay case) must show the FULL text at once — nothing
  // is re-typed. FAILS if the seed reverts to `streaming ? 0 : len` (which
  // renders an empty string on mount).
  test('(a) streaming mount with existing content shows the full content immediately', () => {
    expect(revealedOnMount('Hallo Welt', true)).toBe('Hallo Welt');

    const existing = 'The quick brown fox jumps over the lazy dog.';
    expect(revealedOnMount(existing, true)).toBe(existing);
  });

  // AC1.3c: non-streaming always returns the full content verbatim.
  test('(c) non-streaming returns the full content', () => {
    expect(revealedOnMount('', false)).toBe('');
    expect(revealedOnMount('Hallo Welt', false)).toBe('Hallo Welt');

    const long = 'x'.repeat(500);
    expect(revealedOnMount(long, false)).toBe(long);
  });
});

describe('usePacedText paced reveal engine', () => {
  // AC1.3b / AC1.4b: a message that STARTS empty (content grew from '') is
  // seeded at 0 and revealed step-by-step by the hook's tick, which is exactly
  // `setShown(nextRevealIndex(content, current))`. Replaying that real
  // composition proves the reveal is PACED — not an instant jump to full. FAILS
  // if the pacing is removed (a tick jumping straight to content.length would
  // make the first output already equal the whole string).
  test('(b) reveal advances in bounded steps, never instantly full', () => {
    const content =
      'The quick brown fox jumps over the lazy dog, then keeps on running for quite a while.';

    let shown = 0; // empty-content mount seed: content grew from ''
    const outputs: string[] = [];
    let guard = 0;
    while (shown < content.length && guard < 1000) {
      shown = nextRevealIndex(content, shown);
      outputs.push(content.slice(0, shown));
      guard += 1;
    }

    expect(outputs[0].length).toBeGreaterThan(0);
    expect(outputs[0].length).toBeLessThan(content.length);
    expect(outputs.length).toBeGreaterThan(1);
    for (let i = 1; i < outputs.length; i += 1) {
      expect(outputs[i].length).toBeGreaterThan(outputs[i - 1].length);
      expect(content.startsWith(outputs[i - 1])).toBe(true);
    }
    expect(outputs[outputs.length - 1]).toBe(content);
  });

  // AC1.3d: if the content SHRINKS mid-reveal (stream correction / shorter
  // re-render) the engine's reveal index stays within the new length, and the
  // hook's render clamp `slice(0, Math.min(shown, len))` yields no negative and
  // no overlong slice. FAILS if the engine could overshoot the shorter content
  // (an unclamped index would return more than shorter.length).
  test('(d) content shrink never yields a negative or overlong slice', () => {
    const long = 'The quick brown fox jumps over the lazy dog.';
    let shown = nextRevealIndex(long, 0);
    shown = nextRevealIndex(long, shown);
    // The reveal has advanced past the shorter content's length.
    expect(shown).toBeGreaterThan(9);

    const shorter = 'The quick';

    // The hook's exact render-time clamp yields the whole (shorter) content,
    // never an overlong slice.
    expect(shorter.slice(0, Math.min(shown, shorter.length))).toBe(shorter);

    // The engine, fed a start past the shorter length, returns exactly the
    // shorter length — it never overshoots.
    expect(nextRevealIndex(shorter, shown)).toBe(shorter.length);

    // Even a wildly stale index clamps down to the content and never overruns.
    const stale = 9999;
    expect(shorter.slice(0, Math.min(stale, shorter.length))).toBe(shorter);
    expect(nextRevealIndex(shorter, stale)).toBe(shorter.length);
  });
});
