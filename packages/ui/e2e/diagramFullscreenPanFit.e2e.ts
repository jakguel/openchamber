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
import { build } from 'vite';
import * as path from 'node:path';
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
