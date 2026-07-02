/**
 * Playwright real-browser verification — Story B task 1: Mermaid inline fit-to-width
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.15   Task: openchamber-f9d.15.1
 * Under test:
 *   - index.css inline mermaid rules (~L1378-1432): the [data-markdown="mermaid-scroll"]
 *     overflow rule + the [data-markdown="mermaid"] host + the diagram svg fit-to-width rule
 *   - decorate.ts decorateMermaid (block + scroll + svg host)
 *   - diagramScale.ts applyDiagramBodyScale (Story A font-balance transform — must still
 *     apply AND must not resurrect an inner scrollbar / fight the width fit)
 *   - beautiful-mermaid renderMermaidSVG (3rd-party render)
 *
 * WHY Playwright (not Vitest/jsdom):
 *   The fit assertions read scrollWidth/clientWidth and getBoundingClientRect() on a real
 *   <svg> laid out by a real engine. jsdom reports 0 and getBBox() is inert, so only real
 *   Chromium can prove "wider-than-container diagram fits with no inner scroll" and "small
 *   diagram is not upscaled".
 *
 * WHY self-contained (page.setContent, no live server):
 *   Same rationale as mermaidDiagram.e2e.ts — bundle the REAL modules with Vite, inject the
 *   REAL shipped inline mermaid CSS extracted from src/index.css, and drive the real render +
 *   scale pipeline. No internal mocks: reverting the index.css fit rules makes the assertions
 *   fail (a wide diagram would inner-scroll; a small diagram would be stretched to 100%).
 *
 * RUN:
 *   bunx playwright install chromium   # one-time
 *   bunx playwright test --config packages/ui/playwright.config.ts --project=chromium \
 *     mermaidInlineFit
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const uiSrc = path.resolve(uiRoot, 'src');
const indexCssPath = path.resolve(uiSrc, 'index.css');

/** Body font-size for the markdown container — the applyDiagramBodyScale scale target. */
const CONTAINER_BODY_PX = 15;

/** A horizontal flowchart renders WIDER than a narrow container (forces the fit path). */
const WIDE_MERMAID_SOURCE = 'graph LR\n  A --> B --> C --> D --> E --> F --> G --> H';
/** A tiny diagram renders NARROWER than a wide container (must not be upscaled). */
const SMALL_MERMAID_SOURCE = 'graph TD\n  A --> B';

/**
 * Bundle the REAL render modules into a single IIFE exposed as window.__mmTest.
 * Uses the same `@` → src alias the app uses so decorate.ts's `@/lib/*` imports resolve.
 */
async function bundleRealModules(): Promise<string> {
    const virtualId = '\0mmfit-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        plugins: [
            {
                name: 'mmfit-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'mmfit-e2e-entry' || id.endsWith('mmfit-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return [
                        "export { decorateMarkdown } from '@/components/chat/markdown/decorate';",
                        "export { applyDiagramBodyScale } from '@/components/chat/markdown/diagramScale';",
                        "export { renderMermaidSVG } from 'beautiful-mermaid';",
                    ].join('\n');
                },
            },
        ],
        build: {
            write: false,
            lib: { entry: 'mmfit-e2e-entry', formats: ['iife'], name: '__mmTest' },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('mmfit-e2e bundle produced no JS chunk');
    return chunk.code;
}

/**
 * Extract the REAL contiguous inline mermaid CSS section (block + scroll + host + ascii +
 * svg rules) from the shipped index.css — everything from the base [data-markdown=
 * "mermaid-block"] rule up to the fullscreen popup block. Injecting the actual source text
 * (not a hand-copied copy) means the fit assertions track exactly what ships.
 */
function extractInlineMermaidCss(): string {
    const css = readFileSync(indexCssPath, 'utf-8');
    const start = css.indexOf('[data-markdown="mermaid-block"] {');
    if (start === -1) throw new Error('base [data-markdown="mermaid-block"] rule not found in index.css');
    const fullscreenMarker = css.indexOf('.markdown-mermaid-fullscreen', start);
    if (fullscreenMarker === -1) throw new Error('.markdown-mermaid-fullscreen marker not found after mermaid block');
    return css.slice(start, fullscreenMarker).trim();
}

let harnessAssets: Promise<{ bundle: string; inlineCss: string }> | null = null;

function ensureHarnessAssets(): Promise<{ bundle: string; inlineCss: string }> {
    if (!harnessAssets) {
        harnessAssets = (async () => ({
            bundle: await bundleRealModules(),
            inlineCss: extractInlineMermaidCss(),
        }))();
    }
    return harnessAssets;
}

async function mountHarness(page: Page): Promise<void> {
    const { bundle, inlineCss } = await ensureHarnessAssets();
    await page.setContent(
        `<!doctype html><html><head><style>
           html, body { margin: 0; padding: 0; }
           .markdown-content { font-size: ${CONTAINER_BODY_PX}px; padding: 24px; box-sizing: border-box; }
           ${inlineCss}
         </style></head>
         <body><div class="markdown-content"><div data-markdown-content></div></div></body></html>`,
        { waitUntil: 'domcontentloaded' },
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => typeof (window as unknown as { __mmTest?: unknown }).__mmTest !== 'undefined');
}

type HarnessGlobals = {
    __mmTest: {
        decorateMarkdown: (root: HTMLElement, ctx: unknown) => void;
        applyDiagramBodyScale: (container: HTMLElement | null) => void;
        renderMermaidSVG: (source: string, options?: unknown) => string;
    };
};

const DECORATE_LABELS = {
    copy: 'Copy code',
    copied: 'Copied',
    copyTable: 'Copy table',
    downloadTable: 'Download table',
    copyDiagram: 'Copy diagram source',
    downloadDiagram: 'Download SVG',
    previewLabel: 'Preview',
    previewTitle: 'Open preview',
};

/** Render one mermaid source inside a container pinned to `containerWidth` px and measure. */
async function renderAndMeasure(page: Page, source: string, containerWidth: number) {
    return page.evaluate(
        ({ source, labels, containerWidth }) => {
            const w = window as unknown as HarnessGlobals;
            const container = document.querySelector('.markdown-content') as HTMLElement;
            container.style.width = `${containerWidth}px`;
            const target = container.querySelector('[data-markdown-content]') as HTMLElement;
            target.innerHTML = '';

            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.className = 'language-mermaid';
            code.textContent = source;
            pre.appendChild(code);
            target.appendChild(pre);

            const ctx = {
                labels,
                renderMermaid: (src: string) => ({ svg: w.__mmTest.renderMermaidSVG(src) }),
            };
            w.__mmTest.decorateMarkdown(target, ctx);
            w.__mmTest.applyDiagramBodyScale(container);

            const block = target.querySelector('[data-markdown="mermaid-block"]') as HTMLElement | null;
            const scroll = block?.querySelector('[data-markdown="mermaid-scroll"]') as HTMLElement | null;
            const host = block?.querySelector('[data-md-diagram="mermaid"]') as HTMLElement | null;
            const svg = host?.querySelector('svg') as SVGSVGElement | null;

            const intrinsicWidthAttr = svg ? Number.parseFloat(svg.getAttribute('width') ?? 'NaN') : NaN;
            const svgRect = svg ? svg.getBoundingClientRect() : null;
            // Layout width of the svg (used CSS width) — this EXCLUDES the ancestor
            // transform, so it is the true fit-to-width measure. getBoundingClientRect and
            // scrollWidth both fold in diagramScale's transform:scale on the host.
            const computedSvgWidth = svg ? Number.parseFloat(getComputedStyle(svg).width) : NaN;

            return {
                hasSvg: !!svg,
                scrollWidth: scroll ? scroll.scrollWidth : -1,
                scrollClientWidth: scroll ? scroll.clientWidth : -1,
                scrollOverflowX: scroll ? getComputedStyle(scroll).overflowX : '',
                svgRenderedWidth: svgRect ? svgRect.width : -1,
                computedSvgWidth,
                intrinsicWidthAttr,
                // Story A font-balance transform proof: diagramScale stamps this attribute.
                hasScaleAttr: host?.hasAttribute('data-md-diagram-scale') ?? false,
                appliedScale: host ? Number.parseFloat(host.getAttribute('data-md-diagram-scale') ?? 'NaN') : NaN,
                hostTransform: host ? getComputedStyle(host).transform : '',
            };
        },
        { source, labels: DECORATE_LABELS, containerWidth },
    );
}

test.describe('Story B task 1 — mermaid inline fit-to-width', () => {
    test('AC1: a diagram WIDER than its container fits width with no inner horizontal scroll', async ({ page }) => {
        await mountHarness(page);
        const m = await renderAndMeasure(page, WIDE_MERMAID_SOURCE, 320);

        expect(m.hasSvg).toBe(true);
        // The source really is wider than the (narrow) container — otherwise the test is vacuous.
        expect(m.intrinsicWidthAttr).toBeGreaterThan(m.scrollClientWidth);
        // AC1 no inner horizontal scroll: scrollWidth <= clientWidth INCLUDING the Story A
        // font-balance transform (the host reserves headroom so scale never overflows).
        expect(m.scrollWidth).toBeLessThanOrEqual(m.scrollClientWidth);
        expect(m.scrollOverflowX).toBe('hidden');
        // AC1 fit-to-width: the svg layout width is scaled down to fit, aspect preserved by
        // height:auto (never wider than the container).
        expect(m.computedSvgWidth).toBeLessThanOrEqual(m.scrollClientWidth + 1);
        expect(m.computedSvgWidth).toBeLessThan(m.intrinsicWidthAttr);
    });

    test('AC2: a diagram SMALLER than its container is NOT upscaled past its natural size', async ({ page }) => {
        await mountHarness(page);
        const m = await renderAndMeasure(page, SMALL_MERMAID_SOURCE, 900);

        expect(m.hasSvg).toBe(true);
        // Natural size is well under the wide container.
        expect(m.intrinsicWidthAttr).toBeLessThan(900);
        // Not stretched: rendered width stays at the intrinsic width (width:auto, not width:100%).
        // Allow the Story A font-balance transform (visual) to enlarge the painted box — compare
        // against the intrinsic width scaled by the applied font-balance factor, not 100% width.
        const scale = Number.isFinite(m.appliedScale) ? m.appliedScale : 1;
        const expectedMax = m.intrinsicWidthAttr * Math.max(scale, 1) + 2;
        expect(m.svgRenderedWidth).toBeLessThanOrEqual(expectedMax);
        // And crucially: not blown up to the container width.
        expect(m.svgRenderedWidth).toBeLessThan(600);
    });

    test('AC3: Story A font-balance transform still applies alongside the width fit', async ({ page }) => {
        await mountHarness(page);
        const m = await renderAndMeasure(page, WIDE_MERMAID_SOURCE, 320);

        // diagramScale ran and stamped its scale marker (font-balance still applies)…
        expect(m.hasScaleAttr).toBe(true);
        expect(Number.isFinite(m.appliedScale)).toBe(true);
        expect(m.appliedScale).toBeGreaterThan(1);
        // …and it did NOT compound wrongly: even with the scale applied, the inner box still
        // has no horizontal overflow (scrollWidth includes the transform).
        expect(m.scrollWidth).toBeLessThanOrEqual(m.scrollClientWidth);
        expect(m.scrollOverflowX).toBe('hidden');
    });
});
