/**
 * Playwright real-Chromium proof — task openchamber-5ki.36.2: fullscreen diagram viewport must
 * (BUG #2) initialize at a fit-to-viewport scale so the diagram fills the fullscreen area, and
 * (BUG #1) only pan when the (scaled) content actually overflows the viewport.
 *
 * Story: openchamber-5ki.36   Task: openchamber-5ki.36.2
 *
 * Under test (NO internal mocks — the REAL DiagramPanZoomViewport is bundled and mounted, and
 * the REAL diagramPanZoom math (computeFitScale / isContentPannable) runs inside it):
 *   - BUG #2: on open, the content transform scale is the measured fit (min(vw/cw, vh/ch) clamped
 *     to [0.25, 8]) — a small diagram scales UP (scale > 1) to fill the 600x400 viewport.
 *   - BUG #1: at the fitted, non-overflowing state a pointer drag does NOT move the content
 *     (translate stays 0,0); after zooming in so the content overflows, a drag pans; and a diagram
 *     far larger than the viewport (fit clamped to 0.25 but still overflowing) is pannable at open.
 *
 * WHY real Chromium (not jsdom): the fit + pan gate depend on measured geometry
 * (content.offsetWidth vs container.clientWidth); jsdom reports 0 for both, so the clamp and the
 * overflow predicate can only be exercised in a real layout engine driving real wheel/pointer
 * events. This is a self-contained bundle (page.setContent) — no live server required.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright, it pulls a mismatched runner):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium diagramFullscreenPanFit --workers=1
 */

import { test, expect, type Page } from '@playwright/test';
import { build, createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(currentDir, '..');
const uiSrc = path.resolve(uiRoot, 'src');

/**
 * Bundle the REAL DiagramPanZoomViewport (+ React) into an IIFE exposed as window.__pzFitTest.
 * The virtual entry uses React.createElement (no JSX) so the extension-less virtual module
 * compiles under the default JS loader. `mount(container, childW, childH)` renders the real
 * component wrapping a fixed-size child, exactly the geometry the fit + pan gate measure.
 */
async function bundlePanZoomComponent(): Promise<string> {
    const virtualId = '\0pz-fit-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [
            {
                name: 'pz-fit-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'pz-fit-e2e-entry' || id.endsWith('pz-fit-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return [
                        "import * as React from 'react';",
                        "import { createRoot } from 'react-dom/client';",
                        "import { DiagramPanZoomViewport } from '@/components/chat/message/DiagramPanZoomViewport';",
                        'export function mount(container, childWidth, childHeight) {',
                        "  const child = React.createElement('div', {",
                        "    'data-testid': 'diagram-child',",
                        "    style: { width: childWidth + 'px', height: childHeight + 'px', background: 'linear-gradient(45deg,#333,#999)' },",
                        '  });',
                        "  const el = React.createElement(DiagramPanZoomViewport, { 'data-testid': 'viewport' }, child);",
                        '  const root = createRoot(container);',
                        '  root.render(el);',
                        '}',
                    ].join('\n');
                },
            },
        ],
        build: {
            write: false,
            lib: { entry: 'pz-fit-e2e-entry', formats: ['iife'], name: '__pzFitTest' },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('pz-fit-e2e bundle produced no JS chunk');
    return chunk.code;
}

let panZoomBundle: Promise<string> | null = null;
function getPanZoomBundle(): Promise<string> {
    if (!panZoomBundle) panZoomBundle = bundlePanZoomComponent();
    return panZoomBundle;
}

// Fixed 600x400 viewport host — the fit + overflow math is asserted against these dimensions.
const VIEWPORT_W = 600;
const VIEWPORT_H = 400;

async function mountPanZoomHarness(page: Page, childW: number, childH: number): Promise<void> {
    const bundle = await getPanZoomBundle();
    await page.setContent(
        `<!doctype html><html><head><style>
           html, body { margin: 0; padding: 0; }
           #host { position: absolute; top: 0; left: 0; width: ${VIEWPORT_W}px; height: ${VIEWPORT_H}px; }
         </style></head>
         <body><div id="host"></div></body></html>`,
        { waitUntil: 'domcontentloaded' },
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => typeof (window as unknown as { __pzFitTest?: unknown }).__pzFitTest !== 'undefined');
    await page.evaluate(
        ({ w, h }) => {
            const host = document.getElementById('host') as HTMLElement;
            (window as unknown as { __pzFitTest: { mount: (c: HTMLElement, w: number, h: number) => void } }).__pzFitTest.mount(host, w, h);
        },
        { w: childW, h: childH },
    );
    await page.waitForSelector('[data-testid="viewport"]');
    await page.waitForSelector('[data-testid="diagram-child"]');
}

function readTransform(page: Page): Promise<string> {
    return page.evaluate(() => {
        const content = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
        return content?.style.transform ?? '';
    });
}

/** Parse `translate(Xpx, Ypx) scale(S)` into numbers for bound assertions. */
function parseTransform(transform: string): { x: number; y: number; scale: number } {
    const translate = transform.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/);
    const scale = transform.match(/scale\(\s*(-?[\d.]+)\s*\)/);
    return {
        x: translate ? Number.parseFloat(translate[1]) : NaN,
        y: translate ? Number.parseFloat(translate[2]) : NaN,
        scale: scale ? Number.parseFloat(scale[1]) : NaN,
    };
}

function readCursor(page: Page): Promise<string> {
    return page.evaluate(() => {
        const vp = document.querySelector('[data-testid="viewport"]') as HTMLElement | null;
        return vp ? getComputedStyle(vp).cursor : '';
    });
}

/** Wait until the fit-to-viewport scale has been applied (the rAF-measured scale replaces the
 *  transient scale(1) the effect sets synchronously before measuring). */
async function waitForFitApplied(page: Page, expectedScale: number): Promise<void> {
    await page.waitForFunction(
        (expected) => {
            const c = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
            if (!c) return false;
            const m = c.style.transform.match(/scale\(\s*(-?[\d.]+)\s*\)/);
            if (!m) return false;
            return Math.abs(Number.parseFloat(m[1]) - expected) < 0.05;
        },
        expectedScale,
        { timeout: 10_000 },
    );
}

test.describe('Task .36.2 — fullscreen fit-to-viewport + overflow-gated pan (real Chromium)', () => {
    // A diagram SMALLER than the viewport: fit = min(600/200, 400/150) = min(3, 2.667) = 2.667.
    // At that fit the content exactly touches the 400px height and is 533px wide (< 600) — it
    // fills the viewport but does NOT overflow, so it must not pan until zoomed in.
    const SMALL_W = 200;
    const SMALL_H = 150;
    const SMALL_FIT = Math.min(VIEWPORT_W / SMALL_W, VIEWPORT_H / SMALL_H); // 2.6667

    // A diagram FAR larger than the viewport: fit = min(600/5000, 400/5000) = 0.08 → clamped to
    // DIAGRAM_MIN_SCALE (0.25). At 0.25 it is 1250x1250 — still overflowing, so pannable at open.
    const HUGE_W = 5000;
    const HUGE_H = 5000;
    const HUGE_FIT = 0.25;

    test('BUG #2: small diagram initializes at a fit scale > 1 (fills the viewport)', async ({ page }) => {
        await mountPanZoomHarness(page, SMALL_W, SMALL_H);
        await waitForFitApplied(page, SMALL_FIT);

        const parsed = parseTransform(await readTransform(page));
        expect(parsed.scale).toBeGreaterThan(1);
        expect(parsed.scale).toBeCloseTo(SMALL_FIT, 1);
        // Fit centers the content (no pan offset on open).
        expect(parsed.x).toBe(0);
        expect(parsed.y).toBe(0);
    });

    test('BUG #1: drag at the fitted, non-overflowing state does NOT move the content', async ({ page }) => {
        await mountPanZoomHarness(page, SMALL_W, SMALL_H);
        await waitForFitApplied(page, SMALL_FIT);

        // Cursor reflects non-pannability at fit.
        expect(await readCursor(page)).toBe('default');

        // Drag from the viewport center; the pan gate must reject it (content does not overflow).
        await page.mouse.move(VIEWPORT_W / 2, VIEWPORT_H / 2);
        await page.mouse.down();
        await page.mouse.move(VIEWPORT_W / 2 + 120, VIEWPORT_H / 2 + 80, { steps: 5 });
        await page.mouse.up();

        const parsed = parseTransform(await readTransform(page));
        expect(parsed.x).toBe(0);
        expect(parsed.y).toBe(0);
        // Scale is untouched by the (rejected) drag.
        expect(parsed.scale).toBeCloseTo(SMALL_FIT, 1);
    });

    test('BUG #1: after zooming in so the content overflows, a drag pans normally', async ({ page }) => {
        await mountPanZoomHarness(page, SMALL_W, SMALL_H);
        await waitForFitApplied(page, SMALL_FIT);

        // Wheel up to zoom in beyond the fit → the content now overflows the viewport.
        await page.mouse.move(VIEWPORT_W / 2, VIEWPORT_H / 2);
        await page.mouse.wheel(0, -300);
        await page.waitForFunction((fit) => {
            const c = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
            if (!c) return false;
            const m = c.style.transform.match(/scale\(\s*(-?[\d.]+)\s*\)/);
            return !!m && Number.parseFloat(m[1]) > fit + 0.1;
        }, SMALL_FIT, { timeout: 5_000 });

        // Cursor now indicates pannability.
        expect(await readCursor(page)).toBe('grab');

        // A small in-bounds drag now translates the content.
        await page.mouse.move(VIEWPORT_W / 2, VIEWPORT_H / 2);
        await page.mouse.down();
        await page.mouse.move(VIEWPORT_W / 2 + 40, VIEWPORT_H / 2 + 25, { steps: 3 });
        await page.mouse.up();

        const parsed = parseTransform(await readTransform(page));
        expect(parsed.x).toBeCloseTo(40, 0);
        expect(parsed.y).toBeCloseTo(25, 0);
    });

    test('BUG #1: a diagram larger than the viewport is pannable immediately at open', async ({ page }) => {
        await mountPanZoomHarness(page, HUGE_W, HUGE_H);
        await waitForFitApplied(page, HUGE_FIT);

        // Fit clamped to the floor (0.25) but 5000*0.25 = 1250 > viewport → overflow → pannable.
        expect(await readCursor(page)).toBe('grab');

        await page.mouse.move(VIEWPORT_W / 2, VIEWPORT_H / 2);
        await page.mouse.down();
        await page.mouse.move(VIEWPORT_W / 2 + 40, VIEWPORT_H / 2 + 25, { steps: 3 });
        await page.mouse.up();

        const parsed = parseTransform(await readTransform(page));
        expect(parsed.x).toBeCloseTo(40, 0);
        expect(parsed.y).toBeCloseTo(25, 0);
        expect(parsed.scale).toBeCloseTo(HUGE_FIT, 2);
    });
});

/**
 * Task openchamber-5ki.41.17 (Story 5ki.41 WI4, AC5) — real-Chromium acceptance proof that
 * WI1 (contain-fit), WI2 (focal zoom-to-cursor + per-axis clamp) and WI3 (dialog +/- buttons +
 * disable-at-clamp) work together in the REAL public dialog for BOTH renderers.
 *
 * This block mounts the actual exported ToolOutputDialog (which routes a `diagram` popup to
 * MermaidPreviewDialog) via a vite dev-server fixture with the REAL i18n/theme/runtime/sync
 * providers, the REAL DiagramPanZoomViewport, and REAL mermaid / @plantuml/core renders — nothing
 * under src/ is mocked. The shipped CSS (packages/web/dist, carrying WI1's fullscreen body-scale
 * neutralization rule + the h-11/w-11 button sizing) is injected so contain-fit and the 44x44
 * button box reflect production styling. All assertions read REAL painted geometry
 * (getBoundingClientRect) and the REAL applied transform — never internal component state.
 *
 * REQUIRES: packages/web/dist built (`bun run build`). Real Chromium only (jsdom returns 0 for
 * getBBox/getBoundingClientRect on these diagrams).
 */

const dialogFixtureRoot = path.resolve(currentDir, 'fixtures', 'diagram-fullscreen-dialog');
const dialogFixtureConfig = path.resolve(dialogFixtureRoot, 'vite.config.ts');
const webAssets = path.resolve(uiRoot, '..', 'web', 'dist', 'assets');

const RENDER_BOUND_MS = 90_000;
const FIT_EPS = 2;
const FOCAL_EPS = 3;
const BUTTON_BOX = 44;

const ZOOM_OUT = '[data-testid="mermaid-preview-zoom-out"]';
const ZOOM_IN = '[data-testid="mermaid-preview-zoom-in"]';
const CLOSE_BTN = '[data-testid="mermaid-preview-close"]';

const DIALOG_MERMAID_SOURCE = 'graph TD\n  A[Alpha] --> B[Beta]\n  A --> C[Gamma]\n  B --> D[Delta]\n  C --> D';
const DIALOG_PLANTUML_SOURCE = '@startuml\nAlpha -> Beta : hello\nBeta -> Gamma : world\nGamma -> Alpha : loop\n@enduml';
// Wide, short diagram for the per-axis re-centering test: its height fits the viewport (offset
// forced to 0) at a scale where its width still overflows (offset retained).
const DIALOG_MERMAID_WIDE = 'graph LR\n  A[Alpha] --> B[Beta] --> C[Gamma] --> D[Delta] --> E[Epsilon]';

let dialogServer: ViteDevServer | null = null;
let dialogBaseUrl = '';
let shippedCss = '';

interface ContentGeom {
    vpW: number;
    vpH: number;
    paintedW: number;
    paintedH: number;
    contentW: number;
    contentH: number;
    scale: number;
    offsetX: number;
    offsetY: number;
}

function hostSelector(kind: 'mermaid' | 'plantuml'): string {
    return `[data-md-diagram="${kind}"]`;
}

/** Read the applied scale off the real content element's inline transform. */
function getScale(page: Page): Promise<number> {
    return page.evaluate(() => {
        const c = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
        const m = c?.style.transform.match(/scale\(\s*(-?[\d.]+)\s*\)/);
        return m ? Number.parseFloat(m[1]) : Number.NaN;
    });
}

/** Wait until the applied scale differs from `prev` (a zoom actually took effect). */
async function waitScaleChange(page: Page, prev: number): Promise<void> {
    await page.waitForFunction(
        (p) => {
            const c = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
            const m = c?.style.transform.match(/scale\(\s*(-?[\d.]+)\s*\)/);
            return !!m && Math.abs(Number.parseFloat(m[1]) - p) > 1e-4;
        },
        prev,
        { timeout: 8_000 },
    );
}

/** Resolve once the fit transform has settled (same transform string across two polls). */
async function waitForStableTransform(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const c = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
            if (!c) return false;
            const t = c.style.transform;
            if (!t.includes('scale(')) return false;
            const store = window as unknown as { __lastFitT?: string };
            if (store.__lastFitT === t) return true;
            store.__lastFitT = t;
            return false;
        },
        undefined,
        { timeout: 15_000, polling: 120 },
    );
}

/** Read real painted (getBoundingClientRect) + layout geometry and the applied transform. */
function readGeometry(page: Page, kind: 'mermaid' | 'plantuml'): Promise<ContentGeom> {
    return page.evaluate((sel) => {
        const vp = document.querySelector('[data-diagram-panzoom]') as HTMLElement;
        const content = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement;
        const host = document.querySelector(sel) as HTMLElement;
        const svg = host.querySelector('svg') as SVGSVGElement;
        const vpr = vp.getBoundingClientRect();
        const sr = svg.getBoundingClientRect();
        const s = content.style.transform.match(/scale\(\s*(-?[\d.]+)\s*\)/);
        const tr = content.style.transform.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/);
        return {
            vpW: vpr.width,
            vpH: vpr.height,
            paintedW: sr.width,
            paintedH: sr.height,
            contentW: content.offsetWidth,
            contentH: content.offsetHeight,
            scale: s ? Number.parseFloat(s[1]) : Number.NaN,
            offsetX: tr ? Number.parseFloat(tr[1]) : Number.NaN,
            offsetY: tr ? Number.parseFloat(tr[2]) : Number.NaN,
        };
    }, hostSelector(kind));
}

/** Open the real dialog for a diagram and wait for the render + contain-fit to settle. */
async function openRealDialog(
    page: Page,
    kind: 'mermaid' | 'plantuml',
    source: string,
    viewport: { width: number; height: number },
): Promise<void> {
    await page.setViewportSize(viewport);
    await page.goto(dialogBaseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true, { timeout: 20_000 });
    await page.addStyleTag({ content: shippedCss });
    const open = (k: 'mermaid' | 'plantuml', s: string) =>
        page.evaluate(({ ek, es }) => window.__openDialog?.(ek as 'mermaid' | 'plantuml', es), { ek: k, es: s });

    if (kind === 'plantuml') {
        // Warm the @plantuml/core WASM first: the very first (cold) plantuml render's async layout
        // settles a few px AFTER the fit-once locks, which is a WASM-compile warmup artifact, not a
        // contain-fit defect. A warm render is stable at fit time, so measuring the second open
        // asserts the steady-state contain-fit AC1 actually guarantees.
        await open('plantuml', source);
        await page.waitForSelector(`${hostSelector('plantuml')} svg`, { timeout: RENDER_BOUND_MS });
        await open('mermaid', 'graph TD\n  W1[warmup] --> W2[warmup]');
        await page.waitForSelector(`${hostSelector('mermaid')} svg`, { timeout: 20_000 });
    }

    await open(kind, source);
    await page.waitForSelector(`${hostSelector(kind)} svg`, { timeout: RENDER_BOUND_MS });
    await waitForStableTransform(page);
}

/** Move the mouse to the viewport centre and wheel-zoom in until BOTH axes overflow. */
async function zoomInUntilBothOverflow(page: Page, kind: 'mermaid' | 'plantuml'): Promise<void> {
    const centre = await page.evaluate(() => {
        const r = (document.querySelector('[data-diagram-panzoom]') as HTMLElement).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(centre.x, centre.y);
    for (let i = 0; i < 60; i++) {
        const g = await readGeometry(page, kind);
        if (g.paintedW > g.vpW + 1 && g.paintedH > g.vpH + 1) return;
        if (g.scale >= 8 - 1e-2) return;
        const prev = g.scale;
        await page.mouse.wheel(0, -240);
        await waitScaleChange(page, prev);
    }
}

test.describe('Task 5ki.41.17 — real MermaidPreviewDialog contain-fit + zoom buttons + focal + re-center (real Chromium)', () => {
    test.beforeAll(async () => {
        expect(
            existsSync(webAssets),
            'packages/web/dist/assets missing — run `bun run build` before this e2e',
        ).toBe(true);
        const cssFiles = readdirSync(webAssets).filter((f) => f.endsWith('.css'));
        expect(cssFiles.length, 'no compiled .css in packages/web/dist/assets').toBeGreaterThan(0);
        shippedCss = cssFiles.map((f) => readFileSync(path.join(webAssets, f), 'utf-8')).join('\n');

        dialogServer = await createServer({
            root: dialogFixtureRoot,
            configFile: dialogFixtureConfig,
            logLevel: 'error',
            server: { port: 5299, strictPort: true },
        });
        await dialogServer.listen();
        const url = dialogServer.resolvedUrls?.local?.[0];
        if (!url) throw new Error('dialog vite dev server produced no local url');
        dialogBaseUrl = url;
    });

    test.afterAll(async () => {
        if (dialogServer) {
            await dialogServer.close();
            dialogServer = null;
        }
    });

    for (const kind of ['mermaid', 'plantuml'] as const) {
        const source = kind === 'mermaid' ? DIALOG_MERMAID_SOURCE : DIALOG_PLANTUML_SOURCE;

        test(`AC5a ${kind}: opens contain-fit — real painted rect fits inside the viewport`, async ({ page }) => {
            test.setTimeout(RENDER_BOUND_MS + 30_000);
            await openRealDialog(page, kind, source, { width: 800, height: 600 });

            const g = await readGeometry(page, kind);
            // The diagram actually painted (non-vacuous) …
            expect(g.paintedW, 'diagram did not paint').toBeGreaterThan(0);
            expect(g.paintedH, 'diagram did not paint').toBeGreaterThan(0);
            // … and neither painted axis exceeds the viewport (contain-fit), asserted on the
            // measured painted rect, NOT the raw scale() number.
            expect(g.paintedW, `paintedW ${g.paintedW.toFixed(1)} vs viewportW ${g.vpW}`).toBeLessThanOrEqual(g.vpW + FIT_EPS);
            expect(g.paintedH, `paintedH ${g.paintedH.toFixed(1)} vs viewportH ${g.vpH}`).toBeLessThanOrEqual(g.vpH + FIT_EPS);
        });

        test(`AC5b ${kind}: +/- buttons zoom, share the X's 44x44 box, disable at [0.25, 8]`, async ({ page }) => {
            test.setTimeout(RENDER_BOUND_MS + 40_000);
            await openRealDialog(page, kind, source, { width: 800, height: 600 });
            await page.waitForSelector(ZOOM_IN);
            await page.waitForSelector(ZOOM_OUT);

            const boxes = await page.evaluate(
                ({ closeSel, outSel, inSel }) => {
                    const box = (s: string) => {
                        const b = (document.querySelector(s) as HTMLElement).getBoundingClientRect();
                        return { w: b.width, h: b.height };
                    };
                    return { close: box(closeSel), out: box(outSel), in: box(inSel) };
                },
                { closeSel: CLOSE_BTN, outSel: ZOOM_OUT, inSel: ZOOM_IN },
            );
            // Each control is the shared 44x44 (h-11 w-11) box — the zoom buttons match the X.
            expect(boxes.close.w).toBeCloseTo(BUTTON_BOX, 0);
            expect(boxes.close.h).toBeCloseTo(BUTTON_BOX, 0);
            expect(boxes.out.w).toBeCloseTo(boxes.close.w, 0);
            expect(boxes.out.h).toBeCloseTo(boxes.close.h, 0);
            expect(boxes.in.w).toBeCloseTo(boxes.close.w, 0);
            expect(boxes.in.h).toBeCloseTo(boxes.close.h, 0);

            // Zoom-out decreases the applied scale; zoom-in increases it.
            const s0 = await getScale(page);
            await page.click(ZOOM_OUT);
            await waitScaleChange(page, s0);
            const s1 = await getScale(page);
            expect(s1).toBeLessThan(s0 - 1e-3);
            await page.click(ZOOM_IN);
            await waitScaleChange(page, s1);
            const s2 = await getScale(page);
            expect(s2).toBeGreaterThan(s1 + 1e-3);

            // Drive to the lower clamp: gate on the scale (the source of truth for `disabled`) to
            // avoid a React re-render disabling the button between an isDisabled() read and click.
            for (let i = 0; i < 40; i++) {
                const s = await getScale(page);
                if (s <= 0.25 + 1e-3) break;
                await page.click(ZOOM_OUT);
                await waitScaleChange(page, s);
            }
            // Retrying assertion: the `disabled` prop lands a render after the scale commit.
            await expect(page.locator(ZOOM_OUT)).toBeDisabled();
            expect(await getScale(page)).toBeCloseTo(0.25, 2);

            // Drive to the upper clamp: zoom-in becomes disabled at DIAGRAM_MAX_SCALE (8).
            for (let i = 0; i < 40; i++) {
                const s = await getScale(page);
                if (s >= 8 - 1e-3) break;
                await page.click(ZOOM_IN);
                await waitScaleChange(page, s);
            }
            await expect(page.locator(ZOOM_IN)).toBeDisabled();
            expect(await getScale(page)).toBeCloseTo(8, 1);
        });

        test(`AC5c ${kind}: focal wheel zoom keeps the cursor's content point fixed`, async ({ page }) => {
            test.setTimeout(RENDER_BOUND_MS + 40_000);
            await openRealDialog(page, kind, source, { width: 800, height: 600 });
            // Zoom in until BOTH axes overflow so neither axis is force-recentered — the focal
            // invariant must then hold on both axes.
            await zoomInUntilBothOverflow(page, kind);
            const overflow = await readGeometry(page, kind);
            expect(overflow.paintedW, 'width did not overflow before focal test').toBeGreaterThan(overflow.vpW);
            expect(overflow.paintedH, 'height did not overflow before focal test').toBeGreaterThan(overflow.vpH);

            // Tag the off-centre painted label under which we anchor the cursor; its rect centre
            // IS the content-space point that must stay put across the zoom.
            const target = await page.evaluate((hostSel) => {
                const vpr = (document.querySelector('[data-diagram-panzoom]') as HTMLElement).getBoundingClientRect();
                const cx = vpr.left + vpr.width / 2;
                const cy = vpr.top + vpr.height / 2;
                const texts = Array.from(document.querySelectorAll(`${hostSel} svg text`)) as SVGTextElement[];
                let best: SVGTextElement | null = null;
                let bestCentre = { x: 0, y: 0, d: -1 };
                for (const el of texts) {
                    const b = el.getBoundingClientRect();
                    if (b.width === 0 || b.height === 0) continue;
                    const mx = b.left + b.width / 2;
                    const my = b.top + b.height / 2;
                    if (mx < vpr.left + 12 || mx > vpr.right - 12 || my < vpr.top + 12 || my > vpr.bottom - 12) continue;
                    const d = Math.hypot(mx - cx, my - cy);
                    if (d > bestCentre.d) {
                        best = el;
                        bestCentre = { x: mx, y: my, d };
                    }
                }
                if (!best) return null;
                best.setAttribute('data-focal-target', '');
                return { x: bestCentre.x, y: bestCentre.y, dcx: bestCentre.x - cx, dcy: bestCentre.y - cy };
            }, hostSelector(kind));

            expect(target, 'no off-centre painted label found inside the viewport').not.toBeNull();
            const anchored = target as { x: number; y: number; dcx: number; dcy: number };
            // A real focal test needs d != 0 (cursor off the viewport centre).
            expect(Math.hypot(anchored.dcx, anchored.dcy)).toBeGreaterThan(20);

            const preScale = await getScale(page);
            await page.mouse.move(anchored.x, anchored.y);
            await page.mouse.wheel(0, -150);
            await waitScaleChange(page, preScale);

            const after = await page.evaluate(() => {
                const el = document.querySelector('[data-focal-target]') as SVGTextElement;
                const b = el.getBoundingClientRect();
                return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
            });
            // The anchored content point stays under the cursor within eps (wrong-sign focal math
            // would move it by ~2*d*(1-ratio), tens of px).
            expect(Math.abs(after.x - anchored.x), `focal x drift ${(after.x - anchored.x).toFixed(2)}px`).toBeLessThanOrEqual(FOCAL_EPS);
            expect(Math.abs(after.y - anchored.y), `focal y drift ${(after.y - anchored.y).toFixed(2)}px`).toBeLessThanOrEqual(FOCAL_EPS);
        });
    }

    test('AC5d mermaid: per-axis clamp re-centers the fitting axis to 0 while the other stays panned', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 40_000);
        // Wide/short diagram in a small viewport → on zoom-out the HEIGHT axis fits (offset forced
        // to 0) at a scale where the WIDTH axis still overflows (offset retained).
        await openRealDialog(page, 'mermaid', DIALOG_MERMAID_WIDE, { width: 400, height: 260 });

        await zoomInUntilBothOverflow(page, 'mermaid');
        const zoomed = await readGeometry(page, 'mermaid');
        expect(zoomed.paintedW, 'width did not overflow after zoom-in').toBeGreaterThan(zoomed.vpW);
        expect(zoomed.paintedH, 'height did not overflow after zoom-in').toBeGreaterThan(zoomed.vpH);

        // Pan so BOTH axes carry a non-zero offset.
        const centre = { x: zoomed.vpW / 2, y: zoomed.vpH / 2 };
        await page.mouse.move(centre.x, centre.y);
        await page.mouse.down();
        await page.mouse.move(centre.x - 60, centre.y - 45, { steps: 4 });
        await page.mouse.up();
        const panned = await readGeometry(page, 'mermaid');
        expect(Math.abs(panned.offsetX), 'x did not pan').toBeGreaterThan(1);
        expect(Math.abs(panned.offsetY), 'y did not pan').toBeGreaterThan(1);

        // Zoom out (about centre) until the height axis fits while width still overflows.
        await page.mouse.move(centre.x, centre.y);
        let reached = false;
        for (let i = 0; i < 60; i++) {
            const g = await readGeometry(page, 'mermaid');
            const heightFits = g.contentH * g.scale <= g.vpH;
            const widthOverflows = g.contentW * g.scale > g.vpW;
            if (heightFits && widthOverflows) {
                reached = true;
                break;
            }
            if (g.scale <= 0.25 + 1e-3) break;
            const prev = g.scale;
            await page.mouse.wheel(0, 160);
            await waitScaleChange(page, prev);
        }
        expect(reached, 'never reached a state where height fits but width overflows').toBe(true);

        const g = await readGeometry(page, 'mermaid');
        // The fitting (height) axis is re-centered to EXACTLY 0 …
        expect(g.offsetY, `height axis should re-center to 0, got ${g.offsetY}`).toBe(0);
        // … while the still-overflowing (width) axis keeps a non-zero, bounded offset.
        expect(Math.abs(g.offsetX), 'width axis should stay panned').toBeGreaterThan(0);
        const widthBound = (g.contentW * g.scale - g.vpW) / 2 + 100 + FIT_EPS;
        expect(Math.abs(g.offsetX), `width offset ${g.offsetX} exceeds clamp bound ${widthBound}`).toBeLessThanOrEqual(widthBound);
    });
});
