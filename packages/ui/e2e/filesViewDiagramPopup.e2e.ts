/**
 * Playwright real-Chromium proof — task openchamber-f9d.22.6 AC6 (fullscreen popup in a REAL
 * FilesView markdown preview).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.22   Task: openchamber-f9d.22.6
 *
 * Unlike diagramPopupHook.e2e.ts (which drives the useDiagramPopup hook in isolation), this spec
 * mounts the ACTUAL FilesView component (fixtures/filesview-diagram) with a markdown file open in
 * preview mode. The click path therefore flows through FilesView's OWN wiring:
 *   real expand button -> real useMermaid/PlantumlInlineInteractions -> FilesView's
 *   onShowDiagramPopup (from its useDiagramPopup instance) -> FilesView's diagramPopupElement ->
 *   real lazy ToolOutputDialog.
 * Only the IO boundary (files.readFile / files.listDirectory) is mocked; FilesView,
 * SimpleMarkdownRenderer, useDiagramPopup, ToolOutputDialog, and all stores are the REAL modules.
 * If FilesView's onShowPopup wiring or its single shared popupElement regressed, these fail.
 *
 * WHY real Chromium (not jsdom): mermaid + @plantuml/core need a real layout engine; jsdom's
 * getBBox() returns 0 so a rendered diagram is meaningless there.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium filesViewDiagramPopup
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

type DiagramKind = 'mermaid' | 'plantuml';

const BLOCK = (kind: DiagramKind) => `[data-markdown="${kind}-block"]`;
const EXPAND = (kind: DiagramKind) => `[data-md-action="${kind}-expand"]`;
const POPUP_CONTENT = '[data-diagram-panzoom-content]';

function extractDiagramCss(): string {
    const css = readFileSync(indexCssPath, 'utf-8');
    const start = css.indexOf('[data-markdown="mermaid-block"] {');
    if (start === -1) throw new Error('mermaid-block rule not found in index.css');
    const end = css.indexOf('input[data-terminal-hidden-input', start);
    if (end === -1) throw new Error('terminal-input terminator not found after diagram CSS');
    return css.slice(start, end).trim();
}

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

// The inline diagram re-decorates as it settles (two preview sites, morphdom), so a single click
// can land during a re-render and miss the block lookup. Re-clicking the expand button is
// idempotent (opening an already-open popup is a no-op), so poll-click until the popup attaches.
async function openViaExpand(page: Page, kind: DiagramKind): Promise<void> {
    await expect
        .poll(async () => {
            await clickAction(page, EXPAND(kind));
            return page.locator(POPUP_CONTENT).count();
        }, { timeout: 30_000, intervals: [300, 700, 1000, 1000, 1500] })
        .toBeGreaterThan(0);
}

async function assertPopupKind(page: Page, kind: DiagramKind): Promise<void> {
    // The dialog mounts (lazy chunk) attached first; it only gains layout size once the diagram
    // paints, so gate visibility on the painted svg (long bound) rather than the empty container.
    await page.waitForSelector(POPUP_CONTENT, { state: 'attached', timeout: 15_000 });
    await page.waitForSelector(`${POPUP_CONTENT} ${BLOCK(kind)} svg`, { timeout: RENDER_BOUND_MS });
    const contents = await page.evaluate(
        ({ contentSel, kindBlockSel, otherBlockSel }) => {
            const el = document.querySelector(contentSel);
            return {
                kindSvgCount: el ? el.querySelectorAll(`${kindBlockSel} svg`).length : 0,
                otherBlockCount: el ? el.querySelectorAll(otherBlockSel).length : 0,
            };
        },
        {
            contentSel: POPUP_CONTENT,
            kindBlockSel: BLOCK(kind),
            otherBlockSel: BLOCK(kind === 'plantuml' ? 'mermaid' : 'plantuml'),
        },
    );
    expect(contents.kindSvgCount).toBeGreaterThan(0);
    expect(contents.otherBlockCount).toBe(0);
}

test.describe('Task .22.6 AC6 — fullscreen popup in a REAL FilesView markdown preview (real Chromium)', () => {
    test('mermaid: expand in the FilesView preview opens the popup (kind=mermaid); dialog lazy until then', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);

        // FilesView loaded the markdown file (readFile IO mock) and rendered the inline diagram.
        await page.waitForSelector(`${BLOCK('mermaid')} svg`, { timeout: RENDER_BOUND_MS });
        await page.waitForSelector(EXPAND('mermaid'), { timeout: 15_000 });

        expect(await page.locator(POPUP_CONTENT).count()).toBe(0);
        expect(await getImagePreviewOpen(page)).toBe(false);

        await openViaExpand(page, 'mermaid');

        await assertPopupKind(page, 'mermaid');
        expect(await getImagePreviewOpen(page)).toBe(true);
    });

    test('plantuml: expand in the FilesView preview opens the popup (kind=plantuml)', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 90_000);
        await mount(page);

        await page.waitForSelector(`${BLOCK('plantuml')} svg`, { timeout: RENDER_BOUND_MS });
        await page.waitForSelector(EXPAND('plantuml'), { timeout: 15_000 });

        expect(await page.locator(POPUP_CONTENT).count()).toBe(0);

        await openViaExpand(page, 'plantuml');

        await assertPopupKind(page, 'plantuml');
        expect(await getImagePreviewOpen(page)).toBe(true);
    });
});
