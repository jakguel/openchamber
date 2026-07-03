/**
 * Playwright real-Chromium proof — PlantUML theme picker (openchamber-f9d.24.15).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.24   Task: openchamber-f9d.24.15
 *
 * Proves the theme picker end-to-end through the REAL production pipeline (fixtures/plantuml-pipeline,
 * `@` -> real src, NOTHING under src/ mocked): the persisted useUIStore.plantumlTheme setter (the exact
 * setter the Settings -> Appearance Select calls) flows through the reactive selector at
 * MarkdownRendererImpl.tsx:1121 -> the DecorateContext memo -> the plantumlTheme cache key (cacheKey.ts)
 * -> spliceTheme (applyTheme.ts) -> renderPlantuml, LIVE-repainting an already-rendered block offline.
 *
 * Signature colors are EMPIRICALLY confirmed against the vendored .puml bodies (upstream 597262b7):
 *   toy      participant BackgroundColor FF6F61  -> rendered fill="#FF6F61"
 *   sunlust  $colors.font "#657b83" (solarized)  -> rendered fill="#657B83"  (uppercased by the engine)
 * Both are absent from the default 'none' render, so each assertion flips iff the theme was applied.
 *
 * RUN (workspace-local runner — bunx pulls a mismatched runner; jsdom getBBox=0 can't render):
 *   packages/ui/node_modules/.bin/playwright test --config packages/ui/playwright.config.ts \
 *     --project=chromium plantumlThemeSelection --workers=1
 */

import { test, expect, type Page, type Request } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'plantuml-pipeline');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');

declare global {
    interface Window {
        __plSetMarkdown?: (markdown: string) => void;
        __plSetTheme?: (theme: 'none' | 'plain' | 'mono' | 'sunlust' | 'toy' | 'reddress-lightblue') => void;
        __plReady?: boolean;
    }
}

const BLOCK = '[data-markdown="plantuml-block"]';
const SVG = `${BLOCK} [data-markdown="plantuml"] svg`;
const RENDER_BOUND_MS = 60_000;

const TOY_FILL = 'fill="#FF6F61"';
const SUNLUST_FILL = 'fill="#657B83"';

const fence = (src: string): string => '```plantuml\n' + src + '\n```';
const SEQ = '@startuml\nAlphaOne -> BetaTwo : first\n@enduml';

let server: ViteDevServer | null = null;
let baseUrl = '';

test.beforeAll(async () => {
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
    await page.waitForFunction(() => window.__plReady === true, { timeout: 20_000 });
}

function blockSvgHtml(page: Page): Promise<string> {
    return page.evaluate((sel) => document.querySelector(sel)?.outerHTML ?? '', SVG);
}

test.describe('PlantUML theme picker — real Chromium (openchamber-f9d.24.15)', () => {
    test('AC1: choosing "Toy" in the real Settings Select live-repaints the block to fill="#FF6F61"', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);

        await page.evaluate((md) => window.__plSetMarkdown?.(md), fence(SEQ));
        await page.waitForFunction(
            (sel) => (document.querySelector(sel)?.textContent ?? '').includes('AlphaOne'),
            SVG,
            { timeout: RENDER_BOUND_MS },
        );

        const beforeHtml = await blockSvgHtml(page);
        expect(beforeHtml.length).toBeGreaterThan(0);
        expect(beforeHtml).not.toContain('FF6F61');

        // Drive the ACTUAL Appearance -> "PlantUML Theme" control (OpenChamberVisualSettings):
        // open the real Select by its aria-label, then click the real "Toy" option — no store shim.
        const trigger = page.getByRole('combobox', { name: 'Select PlantUML theme' });
        await trigger.click();
        await page.getByRole('option', { name: 'Toy', exact: true }).click();

        await page.waitForFunction(
            ({ sel, needle }) => (document.querySelector(sel)?.outerHTML ?? '').includes(needle),
            { sel: SVG, needle: TOY_FILL },
            { timeout: RENDER_BOUND_MS },
        );

        const afterHtml = await blockSvgHtml(page);
        expect(afterHtml).toContain(TOY_FILL);
        expect(afterHtml).not.toBe(beforeHtml);
        expect(await page.locator(BLOCK).count()).toBe(1);
    });

    test('AC2: the sunlust preprocessor theme renders a distinctive fill="#657B83"', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);

        await page.evaluate(() => window.__plSetTheme?.('sunlust'));
        await page.evaluate((md) => window.__plSetMarkdown?.(md), fence(SEQ));

        await page.waitForSelector(SVG, { timeout: RENDER_BOUND_MS });
        await page.waitForFunction(
            ({ sel, needle }) => (document.querySelector(sel)?.outerHTML ?? '').includes(needle),
            { sel: SVG, needle: SUNLUST_FILL },
            { timeout: RENDER_BOUND_MS },
        );

        const html = await blockSvgHtml(page);
        expect(html).toContain(SUNLUST_FILL);
        expect(html).not.toContain('FF6F61');
    });

    test('AC3: a themed render issues zero off-origin network requests (offline invariant)', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 30_000);
        const external: string[] = [];
        page.on('request', (req: Request) => {
            const url = req.url();
            if (/^https?:/.test(url) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) {
                external.push(url);
            }
        });

        await mount(page);
        await page.evaluate(() => window.__plSetTheme?.('toy'));
        await page.evaluate((md) => window.__plSetMarkdown?.(md), fence(SEQ));
        await page.waitForFunction(
            ({ sel, needle }) => (document.querySelector(sel)?.outerHTML ?? '').includes(needle),
            { sel: SVG, needle: TOY_FILL },
            { timeout: RENDER_BOUND_MS },
        );

        expect(external, `unexpected off-origin requests: ${external.join(', ')}`).toEqual([]);
    });
});
