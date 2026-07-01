/**
 * Playwright real-browser verification — Story A: Mermaid typographic integration
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.13   Task: openchamber-f9d.13.2
 * Under test:
 *   - index.css [data-markdown="mermaid-block"] vertical margin (rhythm ≈ code blocks' my-4)
 *   - diagramScale.ts applyDiagramBodyScale / scaleForBodyText (A1, commit 709a00a4)
 *   - decorate.ts decorateMermaid (block + toolbar + svg/ascii hosts)
 *   - beautiful-mermaid renderMermaidSVG / renderMermaidASCII (3rd-party render)
 *
 * WHY Playwright (not Vitest/jsdom):
 *   The scale pass reads getComputedStyle(text).fontSize on a rendered <svg>, and the
 *   margin assertion reads getComputedStyle(block).marginTop. jsdom returns 0 for both
 *   and getBBox() is inert — only a real layout engine can verify this behavior.
 *
 * WHY self-contained (page.setContent, no live server):
 *   The existing e2e harness (scrollOscillation.e2e.ts) navigates to a running app and
 *   opens a live OpenCode session — it has no app-mount fixture that renders arbitrary
 *   markdown, and a mermaid diagram only appears if a session happens to contain one.
 *   Rather than stand up a whole app harness, this spec bundles the REAL modules
 *   (decorate.ts + diagramScale.ts + beautiful-mermaid) with Vite once, injects the REAL
 *   shipped [data-markdown="mermaid-block"] rule extracted from src/index.css, and drives
 *   the real render + scale pipeline in real Chromium. No internal mocks: every function
 *   is the production implementation, so removing the CSS margin or breaking the scale math
 *   makes the corresponding assertion fail.
 *
 * RUN:
 *   bunx playwright install chromium   # one-time
 *   bunx playwright test --config packages/ui/playwright.config.ts --project=chromium \
 *     mermaidDiagram
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

/**
 * Deterministic body font-size for the markdown container. applyDiagramBodyScale reads
 * getComputedStyle(container).fontSize as its scale target, so pinning it makes the
 * scale assertion exact.
 */
const CONTAINER_BODY_PX = 15;

/** How close the scaled diagram text must land to the container body px (AC: ~±2px). */
const SCALE_TOLERANCE_PX = 2;

const MERMAID_SOURCE = 'graph TD\n  A[Start] --> B[Middle]\n  B --> C[End]';

/**
 * Bundle the REAL render modules into a single IIFE exposed as window.__mmTest.
 * Uses the same `@` → src alias the app uses so decorate.ts's `@/lib/*` imports resolve.
 */
async function bundleRealModules(): Promise<string> {
    const virtualId = '\0mm-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        plugins: [
            {
                name: 'mm-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'mm-e2e-entry' || id.endsWith('mm-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return [
                        "export { decorateMarkdown } from '@/components/chat/markdown/decorate';",
                        "export { applyDiagramBodyScale, scaleForBodyText } from '@/components/chat/markdown/diagramScale';",
                        "export { renderMermaidSVG, renderMermaidASCII } from 'beautiful-mermaid';",
                    ].join('\n');
                },
            },
        ],
        build: {
            write: false,
            lib: { entry: 'mm-e2e-entry', formats: ['iife'], name: '__mmTest' },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('mm-e2e bundle produced no JS chunk');
    return chunk.code;
}

/**
 * Extract the REAL base [data-markdown="mermaid-block"] rule (not the descendant or
 * fullscreen selectors) from the shipped index.css. Injecting the actual source text —
 * rather than a hand-copied copy — means the margin assertion tracks what really ships.
 */
function extractMermaidBlockRule(): string {
    const css = readFileSync(indexCssPath, 'utf-8');
    const match = css.match(/\[data-markdown="mermaid-block"\][ \t]*\{[\s\S]*?\}/);
    if (!match) throw new Error('base [data-markdown="mermaid-block"] rule not found in index.css');
    return match[0];
}

let harnessAssets: Promise<{ bundle: string; mermaidBlockRule: string }> | null = null;

function ensureHarnessAssets(): Promise<{ bundle: string; mermaidBlockRule: string }> {
    if (!harnessAssets) {
        harnessAssets = (async () => ({
            bundle: await bundleRealModules(),
            mermaidBlockRule: extractMermaidBlockRule(),
        }))();
    }
    return harnessAssets;
}

async function mountHarness(page: Page): Promise<void> {
    const { bundle, mermaidBlockRule } = await ensureHarnessAssets();
    await page.setContent(
        `<!doctype html><html><head><style>
           html, body { margin: 0; padding: 0; }
           .markdown-content { font-size: ${CONTAINER_BODY_PX}px; padding: 24px; }
           ${mermaidBlockRule}
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
        scaleForBodyText: (intrinsic: number, target: number) => number;
        renderMermaidSVG: (source: string, options?: unknown) => string;
        renderMermaidASCII: (source: string, options?: unknown) => string;
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

test.describe('Story A — mermaid typographic integration', () => {
    test('svg mode: renders, scales to body px, has vertical margin + copy/download toolbar', async ({ page }) => {
        await mountHarness(page);

        const measured = await page.evaluate(
            ({ source, labels }) => {
                const w = window as unknown as HarnessGlobals;
                const container = document.querySelector('.markdown-content') as HTMLElement;
                const target = container.querySelector('[data-markdown-content]') as HTMLElement;
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
                const host = block?.querySelector('[data-md-diagram="mermaid"]') as HTMLElement | null;
                const svg = host?.querySelector('svg') as SVGElement | null;
                const textEl = svg?.querySelector('text') as SVGElement | null;

                const blockStyle = block ? getComputedStyle(block) : null;
                const intrinsicFontPx = textEl ? Number.parseFloat(getComputedStyle(textEl).fontSize) : NaN;
                const appliedScale = host ? Number.parseFloat(host.getAttribute('data-md-diagram-scale') ?? 'NaN') : NaN;
                const targetBodyPx = Number.parseFloat(getComputedStyle(container).fontSize);

                return {
                    hasBlock: !!block,
                    hasSvg: !!svg,
                    hasText: !!textEl,
                    marginTop: blockStyle ? Number.parseFloat(blockStyle.marginTop) : -1,
                    marginBottom: blockStyle ? Number.parseFloat(blockStyle.marginBottom) : -1,
                    intrinsicFontPx,
                    appliedScale,
                    targetBodyPx,
                    expectedScale: w.__mmTest.scaleForBodyText(intrinsicFontPx, targetBodyPx),
                    hasCopy: !!block?.querySelector('[data-md-action="mermaid-copy"]'),
                    hasDownload: !!block?.querySelector('[data-md-action="mermaid-download"]'),
                };
            },
            { source: MERMAID_SOURCE, labels: DECORATE_LABELS },
        );

        // Real render produced a real svg with measurable text.
        expect(measured.hasBlock).toBe(true);
        expect(measured.hasSvg).toBe(true);
        expect(measured.hasText).toBe(true);
        expect(measured.intrinsicFontPx).toBeGreaterThan(0);

        // AC: vertical rhythm — non-zero top AND bottom margin from the shipped rule.
        expect(measured.marginTop).toBeGreaterThan(0);
        expect(measured.marginBottom).toBeGreaterThan(0);

        // AC: scale util applied faithfully (behavioral tie to diagramScale.ts).
        expect(measured.appliedScale).toBeCloseTo(measured.expectedScale, 5);

        // AC: rendered text size approximates the container body px within ~±2px.
        const effectivePx = measured.intrinsicFontPx * measured.appliedScale;
        expect(Math.abs(effectivePx - measured.targetBodyPx)).toBeLessThanOrEqual(SCALE_TOLERANCE_PX);

        // AC: copy + download toolbar buttons present in svg mode.
        expect(measured.hasCopy).toBe(true);
        expect(measured.hasDownload).toBe(true);
    });

    test('ascii mode: renders ascii diagram (no svg) with copy button', async ({ page }) => {
        await mountHarness(page);

        const measured = await page.evaluate(
            ({ source, labels }) => {
                const w = window as unknown as HarnessGlobals;
                const container = document.querySelector('.markdown-content') as HTMLElement;
                const target = container.querySelector('[data-markdown-content]') as HTMLElement;
                const pre = document.createElement('pre');
                const code = document.createElement('code');
                code.className = 'language-mermaid';
                code.textContent = source;
                pre.appendChild(code);
                target.appendChild(pre);

                const ctx = {
                    labels,
                    renderMermaid: (src: string) => ({ ascii: w.__mmTest.renderMermaidASCII(src) }),
                };
                w.__mmTest.decorateMarkdown(target, ctx);
                w.__mmTest.applyDiagramBodyScale(container);

                const block = target.querySelector('[data-markdown="mermaid-block"]') as HTMLElement | null;
                const asciiEl = block?.querySelector('[data-markdown="mermaid-ascii"]') as HTMLElement | null;
                return {
                    hasBlock: !!block,
                    hasAscii: !!asciiEl,
                    asciiLen: (asciiEl?.textContent ?? '').trim().length,
                    hasDiagramHost: !!block?.querySelector('[data-md-diagram="mermaid"]'),
                    hasCopy: !!block?.querySelector('[data-md-action="mermaid-copy"]'),
                };
            },
            { source: MERMAID_SOURCE, labels: DECORATE_LABELS },
        );

        expect(measured.hasBlock).toBe(true);
        expect(measured.hasAscii).toBe(true);
        expect(measured.asciiLen).toBeGreaterThan(0);
        // ascii mode must NOT emit the diagram svg host (regression guard for the mode toggle).
        expect(measured.hasDiagramHost).toBe(false);
        expect(measured.hasCopy).toBe(true);
    });
});
