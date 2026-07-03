/**
 * Playwright real-Chromium proof — task openchamber-f9d.23.1 (enlarged diagram popup is truly
 * fullscreen + has a large top-right close button).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.23   Task: openchamber-f9d.23.1
 *
 * Reuses the REAL FilesView markdown-preview fixture (fixtures/filesview-diagram) — the same
 * harness as filesViewDiagramPopup.e2e.ts. Only the IO boundary (files.readFile /
 * files.listDirectory) is mocked; FilesView, SimpleMarkdownRenderer, useDiagramPopup,
 * ToolOutputDialog (MermaidPreviewDialog), DiagramPanZoomViewport and all stores are the REAL
 * production modules. The click path flows through FilesView's own expand wiring to the real
 * lazy ToolOutputDialog.
 *
 * AC1: the popup panel fills the full viewport (width ~= innerWidth, height ~= innerHeight).
 * AC2: the close button is a large (>=40px) hit target anchored in the top-right quadrant over
 *      the diagram body.
 * AC3/regression: clicking the close button dismisses the popup.
 *
 * WHY real Chromium (not jsdom): the panel is measured via getBoundingClientRect; jsdom has no
 * real layout engine (getBBox()/rects are 0) so geometry assertions would be meaningless.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium diagramFullscreenPopup --workers=1
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'filesview-diagram');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');
const indexCssPath = path.resolve(currentDir, '..', 'src', 'index.css');

declare global {
    interface Window {
        __getImagePreviewOpen?: () => boolean;
        __filesViewReady?: boolean;
    }
}

const RENDER_BOUND_MS = 60_000;

const MERMAID_BLOCK = '[data-markdown="mermaid-block"]';
const MERMAID_EXPAND = '[data-md-action="mermaid-expand"]';
const POPUP_CONTENT = '[data-diagram-panzoom-content]';
const PANEL = '[data-testid="mermaid-preview-panel"]';
const CLOSE = '[data-testid="mermaid-preview-close"]';

function extractDiagramCss(): string {
    const css = readFileSync(indexCssPath, 'utf-8');
    const start = css.indexOf('[data-markdown="mermaid-block"] {');
    if (start === -1) throw new Error('mermaid-block rule not found in index.css');
    const end = css.indexOf('input[data-terminal-hidden-input', start);
    if (end === -1) throw new Error('terminal-input terminator not found after diagram CSS');
    return css.slice(start, end).trim();
}

/**
 * The filesview-diagram fixture has NO Tailwind pipeline (its vite config only runs @vitejs/
 * plugin-react), so the Tailwind utility classes the fullscreen overlay relies on
 * (`fixed inset-0`, `w-full`, `h-full`, `absolute top-4 right-4`, `h-11 w-11`, ...) emit no CSS
 * and the panel would collapse to intrinsic flow size. We inject the STANDARD Tailwind
 * definitions for exactly the layout utilities under test — deterministic 1:1 mappings, the same
 * spirit as this suite injecting the real mermaid CSS slice from index.css. The geometry then
 * reflects the component's REAL class structure: if the panel regressed to an 80% inline width,
 * a p-4 outer gap, or a small header-row close button, these assertions break.
 */
const LAYOUT_UTILITIES = `
    html, body { height: 100%; }
    .fixed { position: fixed; }
    .absolute { position: absolute; }
    .relative { position: relative; }
    .inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
    .w-full { width: 100%; }
    .h-full { height: 100%; }
    .top-4 { top: 1rem; }
    .right-4 { right: 1rem; }
    .h-11 { height: 2.75rem; }
    .w-11 { width: 2.75rem; }
    .z-10 { z-index: 10; }
    .z-50 { z-index: 50; }
    .flex { display: flex; }
    .items-center { align-items: center; }
    .justify-center { justify-content: center; }
    .overflow-hidden { overflow: hidden; }
    .pointer-events-none { pointer-events: none; }
    .pointer-events-auto { pointer-events: auto; }
`;

let server: ViteDevServer | null = null;
let baseUrl = '';
let diagramCss = '';

test.beforeAll(async () => {
    diagramCss = extractDiagramCss();
    server = await createServer({ root: fixtureRoot, configFile: fixtureConfig, logLevel: 'error' });
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

async function mount(page: Page): Promise<void> {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__filesViewReady === true, { timeout: 30_000 });
    await page.addStyleTag({ content: diagramCss });
    await page.addStyleTag({ content: LAYOUT_UTILITIES });
}

function getImagePreviewOpen(page: Page): Promise<boolean> {
    return page.evaluate(() => window.__getImagePreviewOpen?.() ?? false);
}

async function clickAction(page: Page, selector: string): Promise<void> {
    await page.evaluate((sel) => {
        const btn = document.querySelector(sel) as HTMLElement | null;
        btn?.click();
    }, selector);
}

// The inline diagram re-decorates as it settles (morphdom), so a single click can land during a
// re-render and miss. Re-clicking the expand button is idempotent, so poll-click until attached.
async function openMermaidPopup(page: Page): Promise<void> {
    await expect
        .poll(async () => {
            await clickAction(page, MERMAID_EXPAND);
            return page.locator(POPUP_CONTENT).count();
        }, { timeout: 30_000, intervals: [300, 700, 1000, 1000, 1500] })
        .toBeGreaterThan(0);
}

test.describe('Task .23.1 — enlarged diagram popup is fullscreen with a large close X (real Chromium)', () => {
    test('panel fills the viewport and the close button is a large top-right hit target', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);

        await page.waitForSelector(`${MERMAID_BLOCK} svg`, { timeout: RENDER_BOUND_MS });
        await page.waitForSelector(MERMAID_EXPAND, { timeout: 15_000 });

        await openMermaidPopup(page);
        // Gate on the painted svg so the portal has fully laid out before measuring.
        await page.waitForSelector(`${POPUP_CONTENT} ${MERMAID_BLOCK} svg`, { timeout: RENDER_BOUND_MS });

        // The overlay is position:fixed, so measure with getBoundingClientRect (viewport-relative,
        // scroll-independent) rather than Playwright boundingBox (document-relative, includes scroll).
        const rect = (selector: string) =>
            page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
            }, selector);

        const viewport = await page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
        }));

        const panelBox = await rect(PANEL);
        expect(panelBox).not.toBeNull();
        if (!panelBox) throw new Error('panel bounding box missing');

        // AC1: full viewport, no 80% clamp and no outer padding gap (few-px tolerance for rounding).
        expect(Math.abs(panelBox.x)).toBeLessThanOrEqual(2);
        expect(Math.abs(panelBox.y)).toBeLessThanOrEqual(2);
        expect(Math.abs(panelBox.width - viewport.width)).toBeLessThanOrEqual(2);
        expect(Math.abs(panelBox.height - viewport.height)).toBeLessThanOrEqual(2);

        // AC2: close button is a large (>=40px) hit target in the top-right quadrant, over the body.
        const closeBox = await rect(CLOSE);
        expect(closeBox).not.toBeNull();
        if (!closeBox) throw new Error('close button bounding box missing');

        expect(closeBox.width).toBeGreaterThanOrEqual(40);
        expect(closeBox.height).toBeGreaterThanOrEqual(40);
        // Top-right quadrant of the viewport.
        expect(closeBox.x).toBeGreaterThan(viewport.width / 2);
        expect(closeBox.y).toBeLessThan(viewport.height / 2);
        // Anchored near the right edge (well inside the right half, not floating mid-screen).
        expect(closeBox.x + closeBox.width).toBeGreaterThan(viewport.width - 80);
    });

    test('clicking the close button dismisses the popup', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);

        await page.waitForSelector(`${MERMAID_BLOCK} svg`, { timeout: RENDER_BOUND_MS });
        await page.waitForSelector(MERMAID_EXPAND, { timeout: 15_000 });

        await openMermaidPopup(page);
        await page.waitForSelector(`${POPUP_CONTENT} ${MERMAID_BLOCK} svg`, { timeout: RENDER_BOUND_MS });
        expect(await getImagePreviewOpen(page)).toBe(true);

        await page.locator(CLOSE).click();

        await expect.poll(() => getImagePreviewOpen(page), { timeout: 10_000 }).toBe(false);
    });
});
