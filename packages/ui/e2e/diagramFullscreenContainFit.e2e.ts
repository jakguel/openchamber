/**
 * Playwright real-Chromium proof — task openchamber-5ki.41.14 (Story 5ki.41 WI1, AC1).
 *
 * BUG: the fullscreen diagram viewer opens OVER-ZOOMED (too close) for BOTH plantuml and
 * mermaid because of NESTED transforms. `applyDiagramHostBodyScale` (diagramScale.ts) stamps a
 * `transform: scale(0.6..1.4)` (origin top-left) on the [data-md-diagram] host for body-text
 * legibility, while `DiagramPanZoomViewport` measures the UNTRANSFORMED `content.offsetWidth`
 * and multiplies `computeFitScale` (origin center-center) on top — net painted size is
 * S_fit x S_body, so a diagram whose body-scale is >1 overflows the viewport on open.
 *
 * REPRODUCE-FIRST (the exact gap that let sibling 5ki.42 ship a passing-but-wrong fix): the
 * SIBLING harness (diagramFullscreenPanFit.e2e.ts) wraps a plain fixed DIV — no host, no
 * body-scale — so it CANNOT reproduce this. This spec instead wraps the REAL host DOM that
 * decorate.ts produces (data-md-diagram host inside the {mermaid,plantuml}-block/scroll,
 * under the real markdown-{kind}-fullscreen class) inside the REAL DiagramPanZoomViewport,
 * injects the REAL shipped index.css fullscreen rules, and applies the REAL
 * applyDiagramHostBodyScale — i.e. the real nested body-scale transform. Every bug-relevant
 * code path is production code; only the SVG markup is a fixture (the bug is geometric, not
 * content-dependent — mermaid/plantuml merely emit an <svg>).
 *
 * AC1a: on open the painted content rect (getBoundingClientRect) is within viewport+eps on
 *       BOTH axes, for BOTH renderers (contain-fit).
 * AC1b: the nested body-scale IS active (host data-md-diagram-scale > 1) — proving the
 *       reproduction is faithful and, before the index.css neutralization, this over-zoomed.
 * AC1c: neutralization is scoped to the fullscreen host classes in index.css (this spec fails
 *       RED without that rule and passes GREEN with it — no viewport-child querySelector).
 *
 * WHY real Chromium (not jsdom): the fit + painted rect depend on measured geometry
 * (offsetWidth / getBoundingClientRect with folded transforms); jsdom reports 0.
 *
 * NO internal mocks — the REAL DiagramPanZoomViewport + REAL applyDiagramHostBodyScale run.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium diagramFullscreenContainFit --workers=1
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(currentDir, '..');
const uiSrc = path.resolve(uiRoot, 'src');
const indexCssPath = path.resolve(uiSrc, 'index.css');

// Fixed viewport host — the fit + contain-fit math is asserted against these dimensions.
const VIEWPORT_W = 600;
const VIEWPORT_H = 400;

// Body-text px the host inherits from .markdown-content — the applyDiagramHostBodyScale target.
const CONTAINER_BODY_PX = 16;

// Fixture SVG: intrinsic 240x180 with a small <text font-size="10">. Against the 16px body
// target that yields ratio 1.6 -> clamped to DIAGRAM_SCALE_MAX (1.4): a deterministic
// body-scale > 1 that over-zooms the fit. Kept aspect < viewport aspect so the height axis is
// the fit constraint (fit = 400/180 = 2.222) and BOTH axes over-zoom at 1.4x.
const FIXTURE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180" viewBox="0 0 240 180">'
    + '<rect x="0" y="0" width="240" height="180" fill="#22304a"></rect>'
    + '<text x="12" y="34" font-size="10" fill="#dfe7f5">Alpha Node</text>'
    + '<text x="12" y="66" font-size="10" fill="#dfe7f5">Beta Node</text>'
    + '</svg>';

/**
 * Bundle the REAL DiagramPanZoomViewport + REAL applyDiagramHostBodyScale (+ React) into an
 * IIFE exposed as window.__containFitTest. `mount(container, kind)` renders the real viewport
 * wrapping the real decorate-shaped host DOM under the real markdown-{kind}-fullscreen class;
 * `applyBodyScale(kind)` then runs the real body-scale on that host.
 */
async function bundleViewport(): Promise<string> {
    const virtualId = '\0contain-fit-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [
            {
                name: 'contain-fit-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'contain-fit-e2e-entry' || id.endsWith('contain-fit-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return [
                        "import * as React from 'react';",
                        "import { createRoot } from 'react-dom/client';",
                        "import { DiagramPanZoomViewport } from '@/components/chat/message/DiagramPanZoomViewport';",
                        "import { applyDiagramHostBodyScale } from '@/components/chat/markdown/diagramScale';",
                        `const SVG = ${JSON.stringify(FIXTURE_SVG)};`,
                        'function blockHtml(kind) {',
                        "  return '<div data-markdown=\"' + kind + '-block\" class=\"group relative\">'",
                        "    + '<div data-markdown=\"' + kind + '-scroll\">'",
                        "    + '<div data-markdown=\"' + kind + '\" data-md-diagram=\"' + kind + '\">' + SVG + '</div>'",
                        "    + '</div></div>';",
                        '}',
                        'export function mount(container, kind) {',
                        "  const child = React.createElement('div', {",
                        "    className: 'markdown-' + kind + '-fullscreen markdown-content',",
                        '    dangerouslySetInnerHTML: { __html: blockHtml(kind) },',
                        '  });',
                        "  const el = React.createElement(DiagramPanZoomViewport, { 'data-testid': 'viewport', resetKey: kind }, child);",
                        '  const root = createRoot(container);',
                        '  root.render(el);',
                        '}',
                        'export function applyBodyScale(kind) {',
                        "  const host = document.querySelector('[data-md-diagram=\"' + kind + '\"]');",
                        '  if (host) applyDiagramHostBodyScale(host);',
                        "  return host ? host.getAttribute('data-md-diagram-scale') : null;",
                        '}',
                    ].join('\n');
                },
            },
        ],
        build: {
            write: false,
            lib: { entry: 'contain-fit-e2e-entry', formats: ['iife'], name: '__containFitTest' },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('contain-fit-e2e bundle produced no JS chunk');
    return chunk.code;
}

/**
 * Extract the REAL contiguous diagram CSS section (inline mermaid block + both fullscreen
 * blocks, INCLUDING the fullscreen host-scale neutralization rule under test) from the shipped
 * index.css. Injecting the actual source text (not a hand copy) means the assertions track
 * exactly what ships — and this spec fails RED until that neutralization rule exists.
 */
function extractDiagramCss(): string {
    const css = readFileSync(indexCssPath, 'utf-8');
    const start = css.indexOf('[data-markdown="mermaid-block"] {');
    if (start === -1) throw new Error('mermaid-block rule not found in index.css');
    const end = css.indexOf('input[data-terminal-hidden-input', start);
    if (end === -1) throw new Error('terminal-input terminator not found after diagram CSS');
    return css.slice(start, end).trim();
}

let bundlePromise: Promise<string> | null = null;
let cssCache: string | null = null;
function getBundle(): Promise<string> {
    if (!bundlePromise) bundlePromise = bundleViewport();
    return bundlePromise;
}
function getCss(): string {
    if (cssCache == null) cssCache = extractDiagramCss();
    return cssCache;
}

async function mountHarness(page: Page, kind: 'mermaid' | 'plantuml'): Promise<string | null> {
    const [bundle, css] = [await getBundle(), getCss()];
    await page.setContent(
        `<!doctype html><html><head><style>
           html, body { margin: 0; padding: 0; }
           .markdown-content { font-size: ${CONTAINER_BODY_PX}px; }
           #host { position: absolute; top: 0; left: 0; width: ${VIEWPORT_W}px; height: ${VIEWPORT_H}px; }
           ${css}
         </style></head>
         <body><div id="host"></div></body></html>`,
        { waitUntil: 'domcontentloaded' },
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => typeof (window as unknown as { __containFitTest?: unknown }).__containFitTest !== 'undefined');
    await page.evaluate(
        (k) => {
            const host = document.getElementById('host') as HTMLElement;
            (window as unknown as { __containFitTest: { mount: (c: HTMLElement, k: string) => void } }).__containFitTest.mount(host, k);
        },
        kind,
    );
    await page.waitForSelector('[data-testid="viewport"]');
    await page.waitForSelector(`[data-md-diagram="${kind}"] svg`);
    // Apply the REAL body-scale transform on the real host (decorate does this post-paint).
    const appliedScale = await page.evaluate(
        (k) => (window as unknown as { __containFitTest: { applyBodyScale: (k: string) => string | null } }).__containFitTest.applyBodyScale(k),
        kind,
    );
    return appliedScale;
}

/** Wait until the fit-to-viewport scale has been applied to the panzoom content transform. */
async function waitForFitApplied(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const c = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
            if (!c) return false;
            const m = c.style.transform.match(/scale\(\s*(-?[\d.]+)\s*\)/);
            return !!m && Number.parseFloat(m[1]) > 1.1;
        },
        undefined,
        { timeout: 10_000 },
    );
}

async function measurePaintedVsViewport(page: Page, kind: 'mermaid' | 'plantuml') {
    return page.evaluate((k) => {
        const viewport = document.querySelector('[data-diagram-panzoom]') as HTMLElement | null;
        const svg = document.querySelector(`[data-md-diagram="${k}"] svg`) as SVGSVGElement | null;
        const host = document.querySelector(`[data-md-diagram="${k}"]`) as HTMLElement | null;
        if (!viewport || !svg || !host) return null;
        const vpRect = viewport.getBoundingClientRect();
        const paintedRect = svg.getBoundingClientRect();
        return {
            viewportW: vpRect.width,
            viewportH: vpRect.height,
            paintedW: paintedRect.width,
            paintedH: paintedRect.height,
            // Computed transform on the host proves whether the body-scale is neutralized.
            hostTransform: getComputedStyle(host).transform,
        };
    }, kind);
}

const EPS = 2;

for (const kind of ['mermaid', 'plantuml'] as const) {
    test.describe(`Task 5ki.41.14 — fullscreen contain-fit, ${kind} (real Chromium)`, () => {
        test(`${kind}: real nested body-scale is active (>1) AND painted content contain-fits the viewport on open`, async ({ page }) => {
            const appliedScale = await mountHarness(page, kind);

            // AC1b: the reproduction is faithful — the REAL applyDiagramHostBodyScale stamped a
            // body-scale > 1 (the over-zoom source). Without this, the test would be vacuous.
            expect(appliedScale).not.toBeNull();
            expect(Number.parseFloat(appliedScale as string)).toBeGreaterThan(1);

            await waitForFitApplied(page);

            const m = await measurePaintedVsViewport(page, kind);
            expect(m).not.toBeNull();
            const { viewportW, viewportH, paintedW, paintedH, hostTransform } = m!;

            // AC1a: neither axis overflows the viewport (contain-fit). BEFORE the index.css
            // neutralization the nested body-scale over-zoomed this to ~1.4x and both axes
            // exceeded the viewport (RED); the neutralization makes computeFitScale authoritative.
            expect(paintedW, `paintedW ${paintedW} vs viewportW ${viewportW}`).toBeLessThanOrEqual(viewportW + EPS);
            expect(paintedH, `paintedH ${paintedH} vs viewportH ${viewportH}`).toBeLessThanOrEqual(viewportH + EPS);

            // AC1c: the fullscreen host-scale is neutralized in index.css, so the painted host
            // carries NO body-scale transform (computeFitScale is the single scale authority).
            expect(hostTransform === 'none' || hostTransform === '').toBe(true);
        });
    });
}
