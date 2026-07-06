/**
 * Playwright real-Chromium proof — task openchamber-5ki.41.14 (Story 5ki.41 WI1, AC1).
 *
 * BUG: the fullscreen diagram viewer opens OVER-ZOOMED (too close) for BOTH plantuml and mermaid.
 * applyDiagramHostBodyScale (diagramScale.ts) stamps a transform:scale(0.6..1.4) (origin top-left)
 * on the [data-md-diagram] host for inline body-text legibility, while DiagramPanZoomViewport
 * measures the UNTRANSFORMED content.offsetWidth and multiplies computeFitScale (origin
 * center-center) on top — net painted size is S_fit x S_body, so a diagram whose body-scale is >1
 * overflows the viewport on open. FIX (committed): a scoped index.css rule neutralizes the host
 * body-scale ONLY under the markdown-{mermaid,plantuml}-fullscreen classes so computeFitScale is
 * the single scale authority.
 *
 * This spec drives the REAL fullscreen render path — the exact composition MermaidPreviewDialog
 * uses (a real DiagramPanZoomViewport wrapping a real SimpleMarkdownRenderer with the
 * markdown-{kind}-fullscreen class, see fixtures/diagram-fullscreen-pipeline) — with REAL ```mermaid
 * and ```plantuml sources rendered through decorate.ts -> mermaid / @plantuml/core and the REAL
 * applyDiagramHostBodyScale. NOTHING under src/ is mocked.
 *
 * MACHINE-VERIFIABLE RED/GREEN (proves the CSS rule, not the harness, is the fix): the REAL shipped
 * CSS (packages/web/dist/assets/*.css) is injected TWICE —
 *   RED  : the neutralization rule regex-STRIPPED  -> the real rendered diagram OVERFLOWS the
 *          viewport (painted content rect exceeds it) and the host keeps its body-scale transform.
 *   GREEN: the full shipped CSS (rule present)     -> contain-fit (paintedW<=viewportW+eps AND
 *          paintedH<=viewportH+eps) and the host computed transform is none.
 * Both mermaid AND plantuml.
 *
 * WHY real Chromium: @plantuml/core needs a real layout engine (getBBox is 0 in jsdom) and the fit
 * + painted rect depend on measured geometry with folded transforms.
 *
 * REQUIRES: packages/web/dist built (`bun run build`) AFTER the index.css fix so the shipped CSS
 * carries the neutralization rule the GREEN case asserts.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium diagramFullscreenContainFit --workers=1
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'diagram-fullscreen-pipeline');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');
const webAssets = path.resolve(currentDir, '..', '..', 'web', 'dist', 'assets');

// Generous but BOUNDED — the first @plantuml/core load compiles ~8.6MB of WASM.
const RENDER_BOUND_MS = 90_000;
const EPS = 2;

// Real sources rendered through the real engines. The fixture's static index.html forces the
// diagram <text> font below the host body font (WIDE_METRIC_CSS technique) so the REAL
// applyDiagramHostBodyScale deterministically clamps to its >1 upper bound (1.4) — the over-zoom
// CONDITION — leaving the shipped neutralization rule as the ONLY RED/GREEN difference.
const MERMAID_SOURCE = 'graph TD\n  A[Alpha] --> B[Beta]\n  B --> C[Gamma]';
const PLANTUML_SOURCE = '@startuml\nAlpha -> Beta : hello\nBeta -> Gamma : world\n@enduml';

/**
 * Matches the shipped neutralization rule (grouped or minifier-split) so it can be stripped to
 * simulate the pre-fix state. Captures a fullscreen [data-md-diagram] selector run up to and
 * including its declaration block.
 */
const NEUTRALIZE_RE = /\.markdown-(?:mermaid|plantuml)-fullscreen\s*\[data-md-diagram\][^{}]*\{[^{}]*\}/g;

let shippingCss = '';
let strippedCss = '';
let server: ViteDevServer | null = null;
let baseUrl = '';

test.beforeAll(async () => {
    expect(
        existsSync(webAssets),
        'packages/web/dist/assets missing — run `bun run build` (AFTER the index.css fix) before this e2e',
    ).toBe(true);

    const cssFiles = readdirSync(webAssets).filter((f) => f.endsWith('.css'));
    expect(cssFiles.length, 'no compiled .css in packages/web/dist/assets').toBeGreaterThan(0);
    shippingCss = cssFiles.map((f) => readFileSync(path.join(webAssets, f), 'utf-8')).join('\n');

    // The shipped CSS MUST contain the neutralization rule (else GREEN is vacuous / build is stale).
    expect(
        new RegExp(NEUTRALIZE_RE.source).test(shippingCss),
        'shipped CSS has no fullscreen [data-md-diagram] neutralization rule — rebuild web after the index.css fix',
    ).toBe(true);

    strippedCss = shippingCss.replace(NEUTRALIZE_RE, '');
    // The strip MUST have removed the rule — otherwise RED reproduces nothing.
    expect(strippedCss.length, 'strip removed nothing').toBeLessThan(shippingCss.length);
    expect(new RegExp(NEUTRALIZE_RE.source).test(strippedCss), 'neutralization rule survived the strip').toBe(false);

    server = await createServer({
        root: fixtureRoot,
        configFile: fixtureConfig,
        logLevel: 'error',
        server: { port: 5301, strictPort: true },
    });
    await server.listen();
    const url = server.resolvedUrls?.local?.[0];
    if (!url) throw new Error('vite dev server produced no local url');
    baseUrl = url;
});

test.afterAll(async () => {
    if (server) {
        await server.close();
        server = null;
    }
});

interface Measurement {
    viewportW: number;
    viewportH: number;
    paintedW: number;
    paintedH: number;
    hostTransform: string;
    scaleAttr: number;
    hostFontPx: number;
    textFontPx: number;
    contentW: number;
    contentH: number;
    fitScale: number;
}

/**
 * Load the fixture with the given CSS variant, render the real fullscreen diagram, wait for the
 * real body-scale + fit to settle, and measure the painted content rect vs the viewport.
 */
async function renderAndMeasure(
    page: Page,
    kind: 'mermaid' | 'plantuml',
    source: string,
    css: string,
): Promise<Measurement> {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true, { timeout: 20_000 });
    await page.addStyleTag({ content: css });
    await page.evaluate(
        ({ k, s }) => window.__setDiagram?.(k as 'mermaid' | 'plantuml', s),
        { k: kind, s: source },
    );

    const hostSel = `[data-md-diagram="${kind}"]`;
    await page.waitForSelector(`${hostSel} svg`, { timeout: RENDER_BOUND_MS });
    // applyDiagramHostBodyScale has run (it stamps this attr) — the real nested body-scale exists.
    await page.waitForFunction(
        (sel) => {
            const host = document.querySelector(sel) as HTMLElement | null;
            return !!host?.getAttribute('data-md-diagram-scale');
        },
        hostSel,
        { timeout: RENDER_BOUND_MS },
    );
    // The DiagramPanZoomViewport fit effect has applied a content transform.
    await page.waitForFunction(
        () => {
            const c = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
            return !!c && /scale\(/.test(c.style.transform);
        },
        undefined,
        { timeout: 10_000 },
    );

    return page.evaluate((sel) => {
        const vp = document.querySelector('[data-diagram-panzoom]') as HTMLElement;
        const content = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement;
        const host = document.querySelector(sel) as HTMLElement;
        const svg = host.querySelector('svg') as SVGSVGElement;
        const text = svg.querySelector('text');
        const vpRect = vp.getBoundingClientRect();
        const svgRect = svg.getBoundingClientRect();
        const fitMatch = content.style.transform.match(/scale\(\s*([\d.]+)\s*\)/);
        return {
            viewportW: vpRect.width,
            viewportH: vpRect.height,
            paintedW: svgRect.width,
            paintedH: svgRect.height,
            hostTransform: getComputedStyle(host).transform,
            scaleAttr: Number.parseFloat(host.getAttribute('data-md-diagram-scale') ?? 'NaN'),
            hostFontPx: Number.parseFloat(getComputedStyle(host).fontSize),
            textFontPx: text ? Number.parseFloat(getComputedStyle(text).fontSize) : NaN,
            contentW: content.offsetWidth,
            contentH: content.offsetHeight,
            fitScale: fitMatch ? Number.parseFloat(fitMatch[1]) : NaN,
        };
    }, hostSel);
}

for (const kind of ['mermaid', 'plantuml'] as const) {
    const source = kind === 'mermaid' ? MERMAID_SOURCE : PLANTUML_SOURCE;

    test.describe(`Task 5ki.41.14 — fullscreen contain-fit, ${kind} (real renderer, real Chromium)`, () => {
        test(`${kind} RED: with the neutralization rule STRIPPED the real fullscreen diagram over-zooms (painted overflows viewport)`, async ({
            page,
        }) => {
            test.setTimeout(RENDER_BOUND_MS + 30_000);
            const m = await renderAndMeasure(page, kind, source, strippedCss);

            // Non-vacuous: the REAL applyDiagramHostBodyScale produced a body-scale > 1 (over-zoom source).
            expect(m.scaleAttr, `body-scale must be >1 to be a real over-zoom (got scale=${m.scaleAttr} hostFont=${m.hostFontPx} textFont=${m.textFontPx})`).toBeGreaterThan(1);
            // The host still carries its body-scale transform (not neutralized in the stripped CSS).
            expect(m.hostTransform).not.toBe('none');
            // Over-zoom: the painted content rect exceeds the viewport on at least one axis.
            const overflow = Math.max(m.paintedW - m.viewportW, m.paintedH - m.viewportH);
            expect(
                overflow,
                `expected over-zoom overflow >${EPS}px (painted ${m.paintedW.toFixed(1)}x${m.paintedH.toFixed(1)} vs viewport ${m.viewportW}x${m.viewportH}; content ${m.contentW}x${m.contentH} fit ${m.fitScale} scaleAttr ${m.scaleAttr})`,
            ).toBeGreaterThan(EPS);
        });

        test(`${kind} GREEN: with the shipped neutralization rule the real fullscreen diagram contain-fits the viewport`, async ({
            page,
        }) => {
            test.setTimeout(RENDER_BOUND_MS + 30_000);
            const m = await renderAndMeasure(page, kind, source, shippingCss);

            // Same real body-scale is still computed (attr present) — the fix neutralizes it visually.
            expect(m.scaleAttr, `body-scale must be >1 (same over-zoom source as RED, got ${m.scaleAttr})`).toBeGreaterThan(1);
            // AC1c: the host body-scale transform is neutralized in the fullscreen context.
            expect(m.hostTransform).toBe('none');
            // AC1a: neither axis overflows the viewport (contain-fit) — computeFitScale is authoritative.
            expect(
                m.paintedW,
                `paintedW ${m.paintedW.toFixed(1)} vs viewportW ${m.viewportW}`,
            ).toBeLessThanOrEqual(m.viewportW + EPS);
            expect(
                m.paintedH,
                `paintedH ${m.paintedH.toFixed(1)} vs viewportH ${m.viewportH}`,
            ).toBeLessThanOrEqual(m.viewportH + EPS);
        });
    });
}
