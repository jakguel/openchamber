/**
 * Playwright real-Chromium proof — task openchamber-f9d.25.1 (the fullscreen diagram popup —
 * BOTH mermaid and plantuml — must have a SOLID background equal to the markdown text/content
 * background token, never transparent, in light AND dark mode).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.25   Task: openchamber-f9d.25.1
 *
 * Reuses the REAL diagram-parity fixture (fixtures/diagram-parity) — the SAME harness as
 * diagramParity.e2e.ts: it mounts the REAL SimpleMarkdownRenderer + the REAL ToolOutputDialog
 * (fullscreen popup) inside the REAL ThemeSystemProvider (so the theme CSS vars, including
 * --surface-background, actually resolve). The REAL shipped diagram CSS is injected from
 * src/index.css, so a reverted `background: transparent` on the fullscreen surface makes these
 * assertions fail. NOTHING under src/ is mocked.
 *
 * The markdown text background: `.markdown-content` itself paints no background — the markdown
 * TEXT sits on the message surface, which is --surface-background (the same token MessageBody's
 * share-as-image path reads as the message background). The inline diagram CARD uses
 * --surface-elevated to lift itself off the text; Jiyan asked for the fullscreen surface to match
 * the markdown TEXT background specifically, i.e. --surface-background.
 *
 * AC1: the fullscreen diagram surface (block + svg) computed background-color is a SOLID color
 *      (alpha == 1, never rgba(0,0,0,0)/transparent) AND is EXACTLY the resolved
 *      var(--surface-background) — proven by a probe element painted with that same token. If the
 *      rule still said `transparent`, the surface would be rgba(0,0,0,0) != the probe and this
 *      fails; a hardcoded color would also != the token-probe and fail (AC3, no hardcode).
 * AC2: the surface tracks the token PER THEME — overriding --surface-background to a light value
 *      then a dark value repaints the surface to each, proving it resolves per theme (not baked).
 *
 * WHY real Chromium (not jsdom): @plantuml/core + mermaid need a real layout engine (getBBox()==0
 * in jsdom) and getComputedStyle must resolve CSS custom properties against a real cascade.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright, it pulls a mismatched runner):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium diagramFullscreenBackground --workers=1
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'diagram-parity');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');
const indexCssPath = path.resolve(currentDir, '..', 'src', 'index.css');

declare global {
    interface Window {
        __setMarkdown?: (markdown: string) => void;
        __parityReady?: boolean;
    }
}

const RENDER_BOUND_MS = 60_000;

type DiagramKind = 'mermaid' | 'plantuml';

const PLANTUML_SRC = '@startuml\nAlphaOne -> BetaTwo : ping\n@enduml';
const MERMAID_SRC = 'graph TD\n  A[Start] --> B[Middle]\n  B --> C[End]';

const fence = (kind: DiagramKind, src: string): string => '```' + kind + '\n' + src + '\n```';
const BLOCK = (kind: DiagramKind) => `[data-markdown="${kind}-block"]`;
const EXPAND = (kind: DiagramKind) => `[data-md-action="${kind}-expand"]`;
const POPUP = '[data-testid="diagram-panzoom"]';
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/** Extract the REAL contiguous diagram CSS (mermaid + plantuml, inline block + fullscreen popup)
 *  from the shipped index.css — injecting the actual source text (not a hand-copied copy) means
 *  the fullscreen-background assertions track exactly what ships. */
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
    await page.waitForFunction(() => window.__parityReady === true, { timeout: 20_000 });
    await page.addStyleTag({ content: diagramCss });
}

async function setMarkdown(page: Page, markdown: string): Promise<void> {
    await page.evaluate((md) => window.__setMarkdown?.(md), markdown);
}

/** Open the fullscreen popup for a kind and wait for ITS re-rendered svg (the popup renders a
 *  fresh async diagram, so gate on the painted svg inside the popup before measuring). */
async function openFullscreen(page: Page, kind: DiagramKind): Promise<void> {
    await setMarkdown(page, fence(kind, kind === 'plantuml' ? PLANTUML_SRC : MERMAID_SRC));
    await page.waitForSelector(`${BLOCK(kind)} svg`, { timeout: RENDER_BOUND_MS });
    await page.waitForSelector(EXPAND(kind), { timeout: 15_000 });

    expect(await page.locator(POPUP).count()).toBe(0);
    await page.evaluate((sel) => {
        const btn = document.querySelector(sel) as HTMLElement | null;
        btn?.click();
    }, EXPAND(kind));

    await page.waitForSelector(POPUP, { timeout: 10_000 });
    await page.waitForSelector(`${POPUP} ${BLOCK(kind)} svg`, { timeout: RENDER_BOUND_MS });
}

/** Read the computed background-color of the fullscreen block + its svg, plus the resolved
 *  var(--surface-background) via a throwaway probe painted with exactly that token. */
function measureFullscreenBackground(page: Page, kind: DiagramKind) {
    return page.evaluate((blockSel) => {
        const popup = document.querySelector('[data-testid="diagram-panzoom"]');
        const block = popup?.querySelector(blockSel) as HTMLElement | null;
        const svg = block?.querySelector('svg') as SVGElement | null;

        const probe = document.createElement('div');
        probe.style.background = 'var(--surface-background)';
        document.body.appendChild(probe);
        const probeBg = getComputedStyle(probe).backgroundColor;
        probe.remove();

        return {
            blockBg: block ? getComputedStyle(block).backgroundColor : 'NO-BLOCK',
            svgBg: svg ? getComputedStyle(svg).backgroundColor : 'NO-SVG',
            probeBg,
        };
    }, BLOCK(kind));
}

/** Read the computed background-color of just the fullscreen block (for the per-theme override). */
function measureBlockBg(page: Page, kind: DiagramKind): Promise<string> {
    return page.evaluate((blockSel) => {
        const popup = document.querySelector('[data-testid="diagram-panzoom"]');
        const block = popup?.querySelector(blockSel) as HTMLElement | null;
        return block ? getComputedStyle(block).backgroundColor : 'NO-BLOCK';
    }, BLOCK(kind));
}

function assertSolidSurfaceBackground(kind: DiagramKind): void {
    test(`${kind} fullscreen surface (block + svg) is a solid var(--surface-background), not transparent`, async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 90_000);
        await mount(page);
        await openFullscreen(page, kind);

        const m = await measureFullscreenBackground(page, kind);

        // The token resolves to a real, solid color (setup + no-undefined guard).
        expect(m.probeBg).not.toBe(TRANSPARENT);
        expect(m.probeBg).not.toBe('transparent');

        // AC1: the fullscreen surface is SOLID (never transparent) ...
        expect(m.blockBg).not.toBe(TRANSPARENT);
        expect(m.blockBg).not.toBe('transparent');
        expect(m.svgBg).not.toBe(TRANSPARENT);
        expect(m.svgBg).not.toBe('transparent');

        // ... and EXACTLY the markdown-text background token (AC1 correct token + AC3 no hardcode).
        expect(m.blockBg).toBe(m.probeBg);
        expect(m.svgBg).toBe(m.probeBg);
    });

    test(`${kind} fullscreen surface tracks --surface-background PER THEME (light + dark)`, async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 90_000);
        await mount(page);
        await openFullscreen(page, kind);

        // A "light theme" background value: the rule references the token, so the surface must
        // repaint to it (proves it is not a baked color).
        const LIGHT = 'rgb(250, 249, 245)';
        await page.addStyleTag({ content: `:root { --surface-background: ${LIGHT} !important; }` });
        expect(await measureBlockBg(page, kind)).toBe(LIGHT);

        // A "dark theme" background value: the later tag wins the cascade, and the surface tracks it.
        const DARK = 'rgb(16, 15, 15)';
        await page.addStyleTag({ content: `:root { --surface-background: ${DARK} !important; }` });
        expect(await measureBlockBg(page, kind)).toBe(DARK);
    });
}

test.describe('Task .25.1 — fullscreen diagram popup has a solid markdown-text background (real Chromium)', () => {
    assertSolidSurfaceBackground('mermaid');
    assertSolidSurfaceBackground('plantuml');
});
