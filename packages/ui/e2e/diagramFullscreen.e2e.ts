/**
 * Playwright real-browser verification — Story B task .15.2: fullscreen diagram viewer.
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.15   Task: openchamber-f9d.15.2
 * Under test:
 *   - decorate.ts decorateMermaid: the magnify toolbar button (data-md-action="mermaid-expand")
 *     that bridges the DOM-decorate toolbar to the React onShowPopup hook (AC1).
 *   - DiagramPanZoomViewport.tsx + diagramPanZoom.ts: true CSS-transform PAN (bounded to
 *     viewport + 100px) and wheel ZOOM — asserted on the live `transform` style (AC2).
 *
 * WHY Playwright (not Vitest/jsdom):
 *   AC2 asserts the computed `transform` (translate + scale) after real wheel + real pointer
 *   drag events. jsdom has no layout (offsetWidth/clientWidth return 0), so the pan-bound
 *   clamp — which depends on measured content vs viewport size — can only be exercised in a
 *   real engine. The whole point of Story B is transform-owns-movement, verifiable only with
 *   real geometry.
 *
 * WHY self-contained bundles (no live server):
 *   Same rationale as mermaidDiagram.e2e.ts. Two harnesses:
 *     1. DOM bundle (decorate.ts + beautiful-mermaid) → drives the REAL decorateMermaid and
 *        asserts the magnify button is emitted (no internal mocks).
 *     2. React bundle (DiagramPanZoomViewport + the REAL diagramPanZoom math) → mounts the
 *        REAL component and drives real wheel/pointer events.
 *
 * RUN:
 *   bunx playwright install chromium   # one-time
 *   bunx playwright test --config packages/ui/playwright.config.ts --project=chromium \
 *     diagramFullscreen
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const uiSrc = path.resolve(uiRoot, 'src');

const MERMAID_SOURCE = 'graph TD\n  A[Start] --> B[Middle]\n  B --> C[End]';

const DECORATE_LABELS = {
    copy: 'Copy code',
    copied: 'Copied',
    copyTable: 'Copy table',
    downloadTable: 'Download table',
    copyDiagram: 'Copy diagram source',
    downloadDiagram: 'Download SVG',
    expandDiagram: 'Fullscreen',
    previewLabel: 'Preview',
    previewTitle: 'Open preview',
};

/** Bundle the REAL decorate + render modules into an IIFE exposed as window.__dcTest. */
async function bundleDecorateModules(): Promise<string> {
    const virtualId = '\0dc-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        plugins: [
            {
                name: 'dc-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'dc-e2e-entry' || id.endsWith('dc-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return [
                        "export { decorateMarkdown } from '@/components/chat/markdown/decorate';",
                        "export { renderMermaidSVG, renderMermaidASCII } from 'beautiful-mermaid';",
                    ].join('\n');
                },
            },
        ],
        build: {
            write: false,
            lib: { entry: 'dc-e2e-entry', formats: ['iife'], name: '__dcTest' },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('dc-e2e bundle produced no JS chunk');
    return chunk.code;
}

/**
 * Bundle the REAL DiagramPanZoomViewport (+ React) into an IIFE exposed as window.__pzTest.
 * The virtual entry uses React.createElement (no JSX) so the extension-less virtual module
 * compiles under the default JS loader.
 */
async function bundlePanZoomComponent(): Promise<string> {
    const virtualId = '\0pz-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [
            {
                name: 'pz-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'pz-e2e-entry' || id.endsWith('pz-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return [
                        "import * as React from 'react';",
                        "import { createRoot } from 'react-dom/client';",
                        "import { DiagramPanZoomViewport } from '@/components/chat/message/DiagramPanZoomViewport';",
                        "export function mount(container, childWidth, childHeight) {",
                        "  const child = React.createElement('div', {",
                        "    'data-testid': 'big-child',",
                        "    style: { width: childWidth + 'px', height: childHeight + 'px', background: 'linear-gradient(45deg,#333,#999)' },",
                        "  });",
                        "  const el = React.createElement(DiagramPanZoomViewport, { 'data-testid': 'viewport' }, child);",
                        "  const root = createRoot(container);",
                        "  root.render(el);",
                        "}",
                    ].join('\n');
                },
            },
        ],
        build: {
            write: false,
            lib: { entry: 'pz-e2e-entry', formats: ['iife'], name: '__pzTest' },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('pz-e2e bundle produced no JS chunk');
    return chunk.code;
}

let decorateBundle: Promise<string> | null = null;
let panZoomBundle: Promise<string> | null = null;

function getDecorateBundle(): Promise<string> {
    if (!decorateBundle) decorateBundle = bundleDecorateModules();
    return decorateBundle;
}
function getPanZoomBundle(): Promise<string> {
    if (!panZoomBundle) panZoomBundle = bundlePanZoomComponent();
    return panZoomBundle;
}

async function mountDecorateHarness(page: Page): Promise<void> {
    const bundle = await getDecorateBundle();
    await page.setContent(
        `<!doctype html><html><head><style>
           html, body { margin: 0; padding: 0; }
           .markdown-content { font-size: 15px; padding: 24px; }
         </style></head>
         <body><div class="markdown-content"><div data-markdown-content></div></div></body></html>`,
        { waitUntil: 'domcontentloaded' },
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => typeof (window as unknown as { __dcTest?: unknown }).__dcTest !== 'undefined');
}

async function mountPanZoomHarness(page: Page, childW: number, childH: number): Promise<void> {
    const bundle = await getPanZoomBundle();
    await page.setContent(
        `<!doctype html><html><head><style>
           html, body { margin: 0; padding: 0; }
           #host { position: absolute; top: 0; left: 0; width: 600px; height: 400px; }
         </style></head>
         <body><div id="host"></div></body></html>`,
        { waitUntil: 'domcontentloaded' },
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => typeof (window as unknown as { __pzTest?: unknown }).__pzTest !== 'undefined');
    await page.evaluate(
        ({ w, h }) => {
            const host = document.getElementById('host') as HTMLElement;
            (window as unknown as { __pzTest: { mount: (c: HTMLElement, w: number, h: number) => void } }).__pzTest.mount(host, w, h);
        },
        { w: childW, h: childH },
    );
    await page.waitForSelector('[data-testid="viewport"]');
    await page.waitForSelector('[data-testid="big-child"]');
}

type DecorateGlobals = {
    __dcTest: {
        decorateMarkdown: (root: HTMLElement, ctx: unknown) => void;
        renderMermaidSVG: (source: string, options?: unknown) => string;
        renderMermaidASCII: (source: string, options?: unknown) => string;
    };
};

test.describe('Story B — magnify button (AC1)', () => {
    test('svg mode: decorateMermaid emits a magnify button with action + aria-label', async ({ page }) => {
        await mountDecorateHarness(page);

        const measured = await page.evaluate(
            ({ source, labels }) => {
                const w = window as unknown as DecorateGlobals;
                const target = document.querySelector('[data-markdown-content]') as HTMLElement;
                const pre = document.createElement('pre');
                const code = document.createElement('code');
                code.className = 'language-mermaid';
                code.textContent = source;
                pre.appendChild(code);
                target.appendChild(pre);

                const ctx = { labels, renderMermaid: (src: string) => ({ svg: w.__dcTest.renderMermaidSVG(src) }) };
                w.__dcTest.decorateMarkdown(target, ctx);

                const block = target.querySelector('[data-markdown="mermaid-block"]') as HTMLElement | null;
                const expand = block?.querySelector('[data-md-action="mermaid-expand"]') as HTMLElement | null;
                return {
                    hasBlock: !!block,
                    hasExpand: !!expand,
                    ariaLabel: expand?.getAttribute('aria-label') ?? null,
                    title: expand?.getAttribute('title') ?? null,
                    isButton: expand?.tagName.toLowerCase() === 'button',
                    // magnify sits alongside copy + download in svg mode
                    hasCopy: !!block?.querySelector('[data-md-action="mermaid-copy"]'),
                    hasDownload: !!block?.querySelector('[data-md-action="mermaid-download"]'),
                };
            },
            { source: MERMAID_SOURCE, labels: DECORATE_LABELS },
        );

        expect(measured.hasBlock).toBe(true);
        expect(measured.hasExpand).toBe(true);
        expect(measured.isButton).toBe(true);
        expect(measured.ariaLabel).toBe('Fullscreen');
        expect(measured.title).toBe('Fullscreen');
        expect(measured.hasCopy).toBe(true);
        expect(measured.hasDownload).toBe(true);
    });

    test('ascii mode: magnify button is present alongside copy', async ({ page }) => {
        await mountDecorateHarness(page);

        const measured = await page.evaluate(
            ({ source, labels }) => {
                const w = window as unknown as DecorateGlobals;
                const target = document.querySelector('[data-markdown-content]') as HTMLElement;
                const pre = document.createElement('pre');
                const code = document.createElement('code');
                code.className = 'language-mermaid';
                code.textContent = source;
                pre.appendChild(code);
                target.appendChild(pre);

                const ctx = { labels, renderMermaid: (src: string) => ({ ascii: w.__dcTest.renderMermaidASCII(src) }) };
                w.__dcTest.decorateMarkdown(target, ctx);

                const block = target.querySelector('[data-markdown="mermaid-block"]') as HTMLElement | null;
                return {
                    hasExpand: !!block?.querySelector('[data-md-action="mermaid-expand"]'),
                    hasCopy: !!block?.querySelector('[data-md-action="mermaid-copy"]'),
                };
            },
            { source: MERMAID_SOURCE, labels: DECORATE_LABELS },
        );

        expect(measured.hasExpand).toBe(true);
        expect(measured.hasCopy).toBe(true);
    });
});

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

test.describe('Story B — fullscreen pan/zoom transform (AC2)', () => {
    // Child 2000x1500 inside a 600x400 viewport: at scale 1 the pan bound is
    //   maxX = (2000 - 600)/2 + 100 = 800 ; maxY = (1500 - 400)/2 + 100 = 650
    const CHILD_W = 2000;
    const CHILD_H = 1500;
    const EXPECTED_MAX_X = 800;
    const EXPECTED_MAX_Y = 650;

    test('initial transform is identity (translate 0,0 scale 1)', async ({ page }) => {
        await mountPanZoomHarness(page, CHILD_W, CHILD_H);
        const parsed = parseTransform(await readTransform(page));
        expect(parsed.x).toBe(0);
        expect(parsed.y).toBe(0);
        expect(parsed.scale).toBe(1);
    });

    test('wheel up increases the scale transform (zoom in)', async ({ page }) => {
        await mountPanZoomHarness(page, CHILD_W, CHILD_H);
        await page.mouse.move(300, 200);
        await page.mouse.wheel(0, -300);
        await page.waitForFunction(() => {
            const c = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
            return !!c && /scale\(/.test(c.style.transform) && Number.parseFloat((c.style.transform.match(/scale\(([\d.]+)\)/) ?? ['', '1'])[1]) > 1;
        });
        const parsed = parseTransform(await readTransform(page));
        expect(parsed.scale).toBeGreaterThan(1);
    });

    test('wheel down decreases the scale transform (zoom out)', async ({ page }) => {
        await mountPanZoomHarness(page, CHILD_W, CHILD_H);
        await page.mouse.move(300, 200);
        await page.mouse.wheel(0, 300);
        await page.waitForFunction(() => {
            const c = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
            return !!c && Number.parseFloat((c.style.transform.match(/scale\(([\d.]+)\)/) ?? ['', '1'])[1]) < 1;
        });
        const parsed = parseTransform(await readTransform(page));
        expect(parsed.scale).toBeLessThan(1);
    });

    test('drag translates the content and clamps within the viewport+100px bound', async ({ page }) => {
        await mountPanZoomHarness(page, CHILD_W, CHILD_H);

        // Drag far beyond the bound; the offset must clamp to the max, not follow the cursor.
        await page.mouse.move(300, 200);
        await page.mouse.down();
        await page.mouse.move(300 + 5000, 200 + 5000, { steps: 5 });
        await page.mouse.up();

        const parsed = parseTransform(await readTransform(page));
        // Non-zero translation actually happened (pan works)...
        expect(parsed.x).toBeGreaterThan(0);
        expect(parsed.y).toBeGreaterThan(0);
        // ...and it is clamped to the computed bound (transform owns movement, bounded).
        expect(parsed.x).toBeCloseTo(EXPECTED_MAX_X, 0);
        expect(parsed.y).toBeCloseTo(EXPECTED_MAX_Y, 0);
        expect(parsed.scale).toBe(1);
    });

    test('small in-bound drag passes through unclamped', async ({ page }) => {
        await mountPanZoomHarness(page, CHILD_W, CHILD_H);

        await page.mouse.move(300, 200);
        await page.mouse.down();
        await page.mouse.move(300 + 40, 200 + 25, { steps: 3 });
        await page.mouse.up();

        const parsed = parseTransform(await readTransform(page));
        expect(parsed.x).toBeCloseTo(40, 0);
        expect(parsed.y).toBeCloseTo(25, 0);
    });
});
