/**
 * Playwright real-Chromium regression — chat streaming scroll pin (pre-paint snap)
 *
 * Story: openchamber-5ki.29  Task: openchamber-5ki.29.1
 * Under test (accepted fix, base commit 7b578def):
 *   - MarkdownRendererImpl.tsx useMorphdomMarkdown: `if (streaming) onContentGrown?.()`
 *     fired synchronously at the END of the async morphdom trailing-block write.
 *   - AssistantTextPart.tsx: handleContentGrown -> onContentChange seam that carries
 *     that call into useChatAutoFollow.notifyContentChange -> snapToBottomIfPinned.
 *
 * WHY a self-contained mounted fixture (no live server / no agent):
 *   The reviewer requires a COMMITTED, DETERMINISTIC harness that mounts the REAL
 *   React chat render path with NO internal-module mocks. The previous live-app
 *   test skipped without a running instance+agent. Here we bundle the REAL modules
 *   with Vite (same pattern as diagramFullscreen.e2e.ts) and mount:
 *     RuntimeAPIProvider (the app's own DI boundary — files/git/github external I/O)
 *       -> useChatAutoFollow (real) wired to a real scroll container
 *       -> AssistantTextPart (real) -> MarkdownRenderer/useMorphdomMarkdown (real).
 *   Only the RuntimeAPIs *value* is a minimal injected stub (external I/O surface,
 *   never touched on the streaming path) — no internal src module is mocked.
 *
 * WHY real Chromium (not jsdom): scrollTop/scrollHeight/clientHeight and the
 *   frame-to-frame paint timing that distinguishes a pre-paint snap from a
 *   post-paint ResizeObserver correction only exist in a real layout engine.
 *
 * PRE-PAINT DETECTION MODEL:
 *   A per-rAF sampler runs BEFORE paint each frame. The frame a streaming "growth
 *   commit" lands on (scrollHeight grew vs the previous frame) reveals whether the
 *   correction was pre-paint (distance ~0 — snapToBottomIfPinned fired in the SAME
 *   task that grew the DOM, the fix) or deferred to the post-paint ResizeObserver
 *   (distance ~= the grown chunk height first, corrected a frame later — the flicker).
 *
 * NEGATIVE CONTROL (proves the assertion is not vacuous): the SAME fixture is
 *   mounted with the onContentChange seam UNWIRED, which is behaviorally identical
 *   to removing the `onContentGrown?.()` call — only the post-paint ResizeObserver
 *   fallback remains. That run MUST show a stale growth-commit frame (distance >>
 *   epsilon). If the pre-paint snap ever regresses, the positive test goes red.
 *
 * RUN:
 *   bunx playwright install chromium   # one-time
 *   bunx playwright test --config packages/ui/playwright.config.ts --project=chromium \
 *     streamingScrollPin
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const uiSrc = path.resolve(uiRoot, 'src');

/** Min per-frame scrollHeight growth (px) that counts as a real streaming commit. */
const MEANINGFUL_GROWTH_PX = 12;

/** Distance-from-bottom (px) at/under which the previous frame counts as pinned. */
const PINNED_TOLERANCE_PX = 8;

/**
 * Max distance-from-bottom (px) allowed ON a growth-commit frame while pinned.
 * Pre-paint snap => ~0. Post-paint-only => ~= chunk height (a text line, tens of px).
 * 16px sits above sub-pixel settle, far below a stale one-chunk gap.
 */
const STREAM_PINNED_EPSILON_PX = 16;

/** Session-open: first-frame distance tolerance (sub-pixel + bottom spacer). */
const AT_BOTTOM_TOLERANCE_PX = 4;

/** Session-open: max scrollTop band across idle settle frames (no oscillation). */
const MAX_IDLE_BAND_PX = 1;

type Metrics = { top: number; sh: number; ch: number };
type CsGlobals = {
    __csTest: { mount: (container: HTMLElement, opts: { prefill: number; wirePrePaintSnap: boolean }) => void };
    __cs: {
        appendChunk: (t: string) => void;
        metrics: () => Metrics | null;
        state: () => string;
        scrollUp: (px: number) => void;
        goToBottom: () => void;
    };
};

// The virtual entry mounts the REAL subtree with React.createElement (no JSX, so the
// extension-less virtual module compiles under Vite's default loader — mirrors the
// diagramFullscreen.e2e.ts harness). The ONLY stub is the RuntimeAPIs value passed to
// the REAL RuntimeAPIProvider; it is the external I/O boundary and is never called on
// the streaming path (enableFileReferences is false while streaming).
const VIRTUAL_ENTRY = [
    "import * as React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';",
    "import { I18nProvider } from '@/lib/i18n/context';",
    "import { useChatAutoFollow } from '@/hooks/useChatAutoFollow';",
    "import AssistantTextPart from '@/components/chat/message/parts/AssistantTextPart';",
    "const apis = { files: {}, editor: {}, runtime: { isVSCode: false } };",
    "function Harness(props) {",
    "  const prefill = props.prefill;",
    "  const wire = props.wirePrePaintSnap;",
    "  const [streamText, setStreamText] = React.useState('');",
    "  const af = useChatAutoFollow({ currentSessionId: 'sess-1', sessionMessageCount: prefill, sessionIsWorking: true, isMobile: false });",
    "  React.useEffect(function () {",
    "    window.__cs = {",
    "      appendChunk: function (t) { setStreamText(function (prev) { return prev + t; }); },",
    "      metrics: function () { var el = af.scrollRef.current; return el ? { top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight } : null; },",
    "      state: function () { return af.state; },",
    "      scrollUp: function (px) { var el = af.scrollRef.current; if (el) { el.scrollTop = Math.max(0, el.scrollTop - px); el.dispatchEvent(new Event('scroll', { bubbles: true })); } },",
    "      goToBottom: function () { af.goToBottom('instant'); },",
    "    };",
    "  }, [af]);",
    "  React.useEffect(function () { af.restoreSnapshot(); }, []);",
    "  var rows = [];",
    "  for (var i = 0; i < prefill; i++) {",
    "    rows.push(React.createElement('div', { key: 'pf' + i, style: { height: '120px', color: '#ccc', font: '14px monospace', borderBottom: '1px solid #333' } }, 'prefilled message ' + i));",
    "  }",
    "  var tail = React.createElement(AssistantTextPart, {",
    "    part: { id: 'p1', type: 'text', text: streamText },",
    "    messageId: 'm1',",
    "    streamPhase: 'streaming',",
    "    chatRenderMode: 'live',",
    "    onContentChange: wire ? af.notifyContentChange : undefined,",
    "  });",
    "  return React.createElement('div', {",
    "    ref: af.scrollRef,",
    "    'data-testid': 'af-scroll',",
    "    style: { height: '320px', overflowY: 'auto', background: '#111', color: '#eee' },",
    "  }, React.createElement('div', null, rows.concat([React.createElement('div', { key: 'tail', 'data-testid': 'af-tail' }, tail)])));",
    "}",
    "var syncStub = {",
    "  childStores: { children: new Map(), subscribeAll: function () { return function () {}; }, getChild: function () { return undefined; }, subscribe: function () { return function () {}; } },",
    "  sdk: {},",
    "  directory: '',",
    "};",
    "window.__csTest = {",
    "  mount: function mount(container, opts) {",
    "    var SyncCtx = globalThis['__openchamber_sync_context__'];",
    "    var tree = React.createElement(I18nProvider, null, React.createElement(Harness, opts));",
    "    if (SyncCtx) { tree = React.createElement(SyncCtx.Provider, { value: syncStub }, tree); }",
    "    var root = createRoot(container);",
    "    root.render(React.createElement(RuntimeAPIProvider, { apis: apis }, tree));",
    "  },",
    "};",
].join('\n');

async function bundleHarness(): Promise<string> {
    const virtualId = '\0cs-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        // The real MarkdownRenderer statically imports a Shiki Web Worker for code-block
        // highlighting (markdown-worker.ts). Workers cannot be code-split into an IIFE, so
        // we build ES + worker ES. The worker asset is never fetched here: the test streams
        // plain prose (no code fences), and markdown-worker.ts degrades to plain text when
        // the worker is absent — so no internal logic is stubbed, only the build format.
        worker: { format: 'es' },
        plugins: [
            {
                name: 'cs-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'cs-e2e-entry' || id.endsWith('cs-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return VIRTUAL_ENTRY;
                },
            },
            {
                // A server-only @opencode-ai/sdk util (spawnSync etc.) sits, unreachable,
                // in the static graph. Node builtins are external I/O — the sanctioned stub
                // boundary — never invoked on the browser chat render path under test.
                name: 'cs-e2e-node-builtin-stub',
                enforce: 'pre',
                resolveId(id) {
                    return id.startsWith('node:') ? `\0nodestub:${id}` : null;
                },
                load(id) {
                    if (!id.startsWith('\0nodestub:')) return null;
                    return [
                        "const noop = () => { throw new Error('node builtin unavailable in browser test'); };",
                        "export const spawnSync = noop, spawn = noop, exec = noop, execSync = noop, execFile = noop, execFileSync = noop, fork = noop;",
                        "export const readFileSync = noop, writeFileSync = noop, existsSync = noop, promises = {};",
                        "export const homedir = noop, platform = noop, tmpdir = noop, release = noop, arch = noop, cpus = noop;",
                        "export const join = noop, resolve = noop, dirname = noop, basename = noop, extname = noop, sep = '/';",
                        "export const createHash = noop, randomBytes = noop, randomUUID = noop;",
                        "export default {};",
                    ].join('\n');
                },
            },
        ],
        build: {
            write: false,
            lib: { entry: 'cs-e2e-entry', formats: ['es'] },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('cs-e2e bundle produced no JS chunk');
    return chunk.code;
}

let harnessBundle: Promise<string> | null = null;
function getHarnessBundle(): Promise<string> {
    if (!harnessBundle) harnessBundle = bundleHarness();
    return harnessBundle;
}

async function mountHarness(page: Page, opts: { prefill: number; wirePrePaintSnap: boolean }): Promise<void> {
    const bundle = await getHarnessBundle();
    // Serve from a real https origin (not setContent's null origin) so modules that read
    // localStorage / theme prefs at init don't throw and abort the module graph.
    const ORIGIN = 'https://cs-e2e.local';
    await page.route(`${ORIGIN}/`, (route) =>
        route.fulfill({
            contentType: 'text/html',
            body:
                `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#host{width:640px}</style></head>` +
                `<body><div id="host"></div></body></html>`,
        }),
    );
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    // A bundled dep references the Node `process` global at init; define it before the
    // module bundle evaluates (the Vite `define` only rewrites `process.env.NODE_ENV`).
    await page.addScriptTag({
        content:
            "window.process = window.process || { env: { NODE_ENV: 'production' }, platform: 'browser', " +
            "cwd: function () { return '/'; }, nextTick: function (f) { setTimeout(f, 0); } };",
    });
    await page.addScriptTag({ content: bundle, type: 'module' });
    await page.waitForFunction(() => typeof (window as unknown as CsGlobals).__csTest !== 'undefined');
    await page.evaluate((o) => {
        const host = document.getElementById('host') as HTMLElement;
        (window as unknown as CsGlobals).__csTest.mount(host, o);
    }, opts);
    await page.waitForSelector('[data-testid="af-scroll"]');
    // Wait until the prefilled content actually overflows the fixed-height container.
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="af-scroll"]') as HTMLElement | null;
        return !!el && el.scrollHeight - el.clientHeight > 50;
    });
}

/**
 * Mount, pin, then drive paced streaming chunks while sampling scroll metrics once
 * per animation frame (before paint). Returns every sampled frame.
 */
async function streamAndSample(page: Page): Promise<Metrics[]> {
    // Warm-up: mount the streaming markdown block and let its FIRST content settle +
    // snap BEFORE we sample. The empty->first-content transition mounts MarkdownRenderer
    // via the synchronous first-paint path (not the per-token morphdom write under test),
    // a one-time settle that is not the per-chunk streaming flicker. Sampling the steady
    // state isolates the repeated per-token growth the fix targets.
    await page.evaluate(async () => {
        const cs = (window as unknown as CsGlobals).__cs;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        cs.appendChunk('Warm-up sentence that mounts the streaming markdown block before sampling. ');
        await sleep(700);
        cs.goToBottom();
        await sleep(200);
    });
    return page.evaluate(async () => {
        const cs = (window as unknown as CsGlobals).__cs;
        const samples: Metrics[] = [];
        let running = true;
        const loop = () => {
            if (!running) return;
            const m = cs.metrics();
            if (m) samples.push(m);
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const chunk = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ';
        for (let i = 0; i < 26; i += 1) {
            cs.appendChunk(chunk);
            await sleep(90);
        }
        await sleep(2000); // let usePacedText / throttle flush remaining reveals
        running = false;
        return samples;
    });
}

const distanceFromBottom = (m: Metrics): number => m.sh - m.ch - m.top;

interface GrowthFrame {
    grew: number;
    dist: number;
}

function pinnedGrowthCommitFrames(samples: Metrics[]): GrowthFrame[] {
    const frames: GrowthFrame[] = [];
    for (let i = 1; i < samples.length; i += 1) {
        const a = samples[i - 1]!;
        const b = samples[i]!;
        const grew = b.sh - a.sh;
        if (grew >= MEANINGFUL_GROWTH_PX && distanceFromBottom(a) <= PINNED_TOLERANCE_PX) {
            frames.push({ grew, dist: distanceFromBottom(b) });
        }
    }
    return frames;
}

test.describe('Chat streaming scroll pin — pre-paint snap (real mounted subtree)', () => {
    test.describe.configure({ mode: 'serial' });

    test('AC1 — pinned streaming growth stays glued on the growth-commit frame (pre-paint)', async ({ page }) => {
        await mountHarness(page, { prefill: 8, wirePrePaintSnap: true });
        const samples = await streamAndSample(page);
        const growth = pinnedGrowthCommitFrames(samples);

        // The stream must have produced real pinned growth, else the behavior wasn't exercised.
        expect(
            growth.length,
            `No pinned streaming growth-commit frames were sampled — the streaming path did not grow while pinned.`,
        ).toBeGreaterThan(0);

        const worst = growth.reduce((acc, f) => Math.max(acc, f.dist), 0);
        expect(
            worst,
            [
                `REGRESSION: a pinned streaming growth commit painted at a stale scrollTop (per-chunk flicker).`,
                `worst distance-from-bottom on a growth-commit frame=${worst}px across ${growth.length} commits`,
                `(tolerance ${STREAM_PINNED_EPSILON_PX}px). A distance ~= the chunk height means the snap fired`,
                `only from the POST-paint ResizeObserver — the pre-paint onContentGrown -> notifyContentChange`,
                `-> snapToBottomIfPinned seam is not firing synchronously inside the morphdom write.`,
            ].join(' '),
        ).toBeLessThanOrEqual(STREAM_PINNED_EPSILON_PX);
    });

    test('AC1 negative control — WITHOUT the pre-paint seam a stale growth-commit frame IS observed', async ({ page }) => {
        // Same real subtree, but the onContentChange seam is unwired — behaviorally
        // identical to removing `onContentGrown?.()`. Only the post-paint ResizeObserver
        // fallback remains, so at least one growth-commit frame must paint stale. This
        // proves the positive assertion above is NOT vacuous and genuinely depends on
        // the pre-paint snap.
        await mountHarness(page, { prefill: 8, wirePrePaintSnap: false });
        const samples = await streamAndSample(page);
        const growth = pinnedGrowthCommitFrames(samples);

        expect(
            growth.length,
            `No pinned streaming growth-commit frames were sampled in the control run.`,
        ).toBeGreaterThan(0);

        const worst = growth.reduce((acc, f) => Math.max(acc, f.dist), 0);
        expect(
            worst,
            [
                `CONTROL FAILED: with the pre-paint seam unwired, NO stale growth-commit frame appeared`,
                `(worst distance=${worst}px, expected > ${STREAM_PINNED_EPSILON_PX}px).`,
                `If this control cannot reproduce the flicker, the positive AC1 assertion would be vacuous.`,
            ].join(' '),
        ).toBeGreaterThan(STREAM_PINNED_EPSILON_PX);
    });

    test('AC2 — session open lands at the bottom instantly and does not oscillate', async ({ page }) => {
        await mountHarness(page, { prefill: 8, wirePrePaintSnap: true });

        const result = await page.evaluate(async () => {
            const el = document.querySelector('[data-testid="af-scroll"]') as HTMLElement;
            const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
            const firstFrame = { top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight };
            const samples: number[] = [el.scrollTop];
            for (let i = 1; i < 20; i += 1) {
                await nextFrame();
                samples.push(el.scrollTop);
            }
            return { firstFrame, samples };
        });

        const maxScroll = result.firstFrame.sh - result.firstFrame.ch;
        const firstDistance = maxScroll - result.firstFrame.top;
        expect(
            firstDistance,
            `REGRESSION: session open did not land at the bottom on the first frame. distance=${firstDistance}px (tol ${AT_BOTTOM_TOLERANCE_PX}px).`,
        ).toBeLessThanOrEqual(AT_BOTTOM_TOLERANCE_PX);

        const band = Math.max(...result.samples) - Math.min(...result.samples);
        expect(
            band,
            `REGRESSION: scrollTop oscillated on an idle open. band=${band}px (expected <= ${MAX_IDLE_BAND_PX}px). samples=[${result.samples.join(', ')}].`,
        ).toBeLessThanOrEqual(MAX_IDLE_BAND_PX);
    });
});
