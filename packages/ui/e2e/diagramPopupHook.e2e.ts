/**
 * Playwright real-Chromium proof — task openchamber-f9d.22.6 (fullscreen popup off-chat).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.22   Task: openchamber-f9d.22.6
 *
 * Under test: the EXTRACTED useDiagramPopup() hook that wires the fullscreen pan/zoom dialog
 * into the 4 non-chat SimpleMarkdownRenderer surfaces (FilesView, MobileFilesSurface, PlanView,
 * SkillsPage). Before this fix, those surfaces passed no onShowPopup, so mermaid/plantuml
 * expand was a no-op everywhere except chat.
 *
 * The fixture (fixtures/diagram-popup-hook) mounts a surface wired EXACTLY like the 4 production
 * surfaces: one useDiagramPopup() instance, its onShowPopup threaded into the REAL
 * SimpleMarkdownRenderer, its popupElement rendered once. The assertions drive the genuine
 * expand-button -> real interaction hook -> onShowPopup -> lazy ToolOutputDialog path. There is
 * NO manual hook invocation and NO manual popup state — a regression in the hook (no-op
 * onShowPopup, popupElement never mounting, missing setImagePreviewOpen parity, missing unmount
 * cleanup) makes a specific assertion fail.
 *
 * WHY real Chromium (not jsdom): mermaid + @plantuml/core need a real layout engine; jsdom's
 * getBBox() returns 0 so a rendered diagram is meaningless there.
 *
 * WHY the PlantUML waits are generous but BOUNDED: the first engine load compiles ~8.6MB of WASM.
 * The waits are real pass/fail signals (a diagram that never renders blows the bound), not sleeps.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright, it pulls a mismatched runner):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium diagramPopupHook
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'diagram-popup-hook');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');
const indexCssPath = path.resolve(currentDir, '..', 'src', 'index.css');

declare global {
    interface Window {
        __setMarkdown?: (markdown: string) => void;
        __setSurfaceMounted?: (mounted: boolean) => void;
        __getImagePreviewOpen?: () => boolean;
        __hookReady?: boolean;
    }
}

const RENDER_BOUND_MS = 60_000;

const PLANTUML_SRC = '@startuml\nAlphaOne -> BetaTwo : ping\n@enduml';
const MERMAID_SRC = 'graph TD\n  A[Start] --> B[Middle]\n  B --> C[End]';

const plantumlFence = (src: string): string => '```plantuml\n' + src + '\n```';
const mermaidFence = (src: string): string => '```mermaid\n' + src + '\n```';

type DiagramKind = 'mermaid' | 'plantuml';

const BLOCK = (kind: DiagramKind) => `[data-markdown="${kind}-block"]`;
const EXPAND = (kind: DiagramKind) => `[data-md-action="${kind}-expand"]`;
const POPUP_CONTENT = '[data-diagram-panzoom-content]';

/** Extract the REAL contiguous diagram CSS (mermaid + plantuml) from the shipped index.css so the
 *  inline block/host render the way they ship — the popup open path is React state, but injecting
 *  the real CSS keeps the fixture faithful to production layout. */
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
    await page.waitForFunction(() => window.__hookReady === true, { timeout: 20_000 });
    await page.addStyleTag({ content: diagramCss });
}

async function setMarkdown(page: Page, markdown: string): Promise<void> {
    await page.evaluate((md) => window.__setMarkdown?.(md), markdown);
}

function getImagePreviewOpen(page: Page): Promise<boolean> {
    return page.evaluate(() => window.__getImagePreviewOpen?.() ?? false);
}

/** Click a decorate toolbar action button directly (the toolbar is opacity-0 until hover; a
 *  synthetic .click() fires the production hook's listener without needing hover visibility). */
async function clickAction(page: Page, selector: string): Promise<void> {
    await page.evaluate((sel) => {
        const btn = document.querySelector(sel) as HTMLElement | null;
        btn?.click();
    }, selector);
}

/** Assert the popup opened for exactly this diagram kind (proves diagram.kind routing through the
 *  real ToolOutputDialog): the popup renders THIS kind's svg and NOT the other kind's block. */
async function assertPopupKind(page: Page, kind: DiagramKind): Promise<void> {
    await page.waitForSelector(POPUP_CONTENT, { timeout: 15_000 });
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

test.describe('Task .22.6 — useDiagramPopup fullscreen on non-chat surfaces (real Chromium)', () => {
    test('mermaid: expand opens the fullscreen popup with kind=mermaid; dialog is lazy until then', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, mermaidFence(MERMAID_SRC));
        await page.waitForSelector(`${BLOCK('mermaid')} svg`, { timeout: RENDER_BOUND_MS });
        await page.waitForSelector(EXPAND('mermaid'), { timeout: 15_000 });

        // Closed by default: popupElement is null, so the ToolOutputDialog chunk is not mounted.
        expect(await page.locator(POPUP_CONTENT).count()).toBe(0);
        expect(await getImagePreviewOpen(page)).toBe(false);

        await clickAction(page, EXPAND('mermaid'));

        await assertPopupKind(page, 'mermaid');
        // Global-shortcut suppression parity: opening the preview flips isImagePreviewOpen.
        expect(await getImagePreviewOpen(page)).toBe(true);
    });

    test('mermaid: clicking a non-expand toolbar action (copy) does NOT open the popup', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 30_000);
        await mount(page);
        await setMarkdown(page, mermaidFence(MERMAID_SRC));
        await page.waitForSelector(`${BLOCK('mermaid')} svg`, { timeout: RENDER_BOUND_MS });
        await page.waitForSelector('[data-md-action="mermaid-copy"]', { timeout: 15_000 });

        await clickAction(page, '[data-md-action="mermaid-copy"]');
        // Give any errant state update a chance to land before asserting the negative.
        await page.waitForTimeout(300);

        expect(await page.locator(POPUP_CONTENT).count()).toBe(0);
        expect(await getImagePreviewOpen(page)).toBe(false);
    });

    test('unmounting a surface with the popup open resets isImagePreviewOpen to false', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 30_000);
        await mount(page);
        await setMarkdown(page, mermaidFence(MERMAID_SRC));
        await page.waitForSelector(`${BLOCK('mermaid')} svg`, { timeout: RENDER_BOUND_MS });
        await page.waitForSelector(EXPAND('mermaid'), { timeout: 15_000 });

        await clickAction(page, EXPAND('mermaid'));
        await page.waitForSelector(POPUP_CONTENT, { timeout: 15_000 });
        expect(await getImagePreviewOpen(page)).toBe(true);

        // Simulate route navigation: the surface (and its useDiagramPopup) unmounts.
        await page.evaluate(() => window.__setSurfaceMounted?.(false));
        await page.waitForSelector('[data-surface-unmounted="true"]', { state: 'attached', timeout: 10_000 });
        // The popupElement is gone too once the surface unmounts.
        await page.waitForSelector(POPUP_CONTENT, { state: 'detached', timeout: 10_000 });

        // The unmount cleanup must have reset the flag, or global shortcuts stay dead app-wide.
        expect(await getImagePreviewOpen(page)).toBe(false);
    });

    test('plantuml: expand opens the fullscreen popup with kind=plantuml', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 90_000);
        await mount(page);
        await setMarkdown(page, plantumlFence(PLANTUML_SRC));
        await page.waitForSelector(`${BLOCK('plantuml')} svg`, { timeout: RENDER_BOUND_MS });
        await page.waitForSelector(EXPAND('plantuml'), { timeout: 15_000 });

        expect(await page.locator(POPUP_CONTENT).count()).toBe(0);

        await clickAction(page, EXPAND('plantuml'));

        await assertPopupKind(page, 'plantuml');
        expect(await getImagePreviewOpen(page)).toBe(true);
    });
});
