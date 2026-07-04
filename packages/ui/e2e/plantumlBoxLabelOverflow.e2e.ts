/**
 * Playwright real-Chromium proof — PlantUML BOX-LABEL overflow fit pass (openchamber-f9d.26.1).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.26   Task: openchamber-f9d.26.1
 *
 * ROOT CAUSE this test locks in: @plantuml/core sizes its boxes with the engine's own logical font
 * metrics (it ships no font files and ignores `skinparam defaultFontName`), while the browser
 * paints the labels with the CSS font. On platforms where the painted glyphs run wider than the
 * engine assumed, a boxed label spills past its rect. The fix (fitBoxText.ts, wired in decorate.ts
 * right after setHtml and before applyDiagramHostBodyScale) measures the real painted text and,
 * only where it overflows its enclosing rect, condenses it with SVG `textLength` +
 * `lengthAdjust="spacingAndGlyphs"` so it fits — reacting to the ACTUAL metrics, cross-platform.
 *
 * Determinism on macOS+Helvetica (which does NOT overflow naturally): this test injects a wide
 * metric override (`letter-spacing`) on the plantuml <text> so a boxed multi-line label reliably
 * overflows its box PRE-fix. `textLength` forces the total advance regardless of letter-spacing, so
 * the fixed labels still fit; stripping the fit attributes brings the overflow back (RED-on-revert).
 *
 * WHY this is a faithful test (fails if the fix is reverted): it mounts the REAL production pipeline
 * (SimpleMarkdownRenderer -> decorate.ts -> renderPlantuml -> @plantuml/core) via the shared
 * fixtures/plantuml-pipeline harness. NOTHING under src/ is mocked. Real Chromium is required
 * because @plantuml/core needs a real layout engine and getBBox() is meaningless under jsdom.
 *
 * RUN (workspace-local runner — NOT bunx):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium plantumlBoxLabelOverflow --workers=1
 *
 * REQUIRES: packages/web/dist built first (`bun run build`) so the injected CSS carries the real
 * font cascade the labels paint with.
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'plantuml-pipeline');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');
const webDist = path.resolve(currentDir, '..', '..', 'web', 'dist');
const webAssets = path.join(webDist, 'assets');

const BLOCK = '[data-markdown="plantuml-block"]';
const PL_HOST = `${BLOCK} [data-markdown="plantuml"]`;

const RENDER_BOUND_MS = 90_000;

/** Multi-line boxed labels (the `\n` splits each into its own <text>). Long lines like
 * "VulnerabilityRecord" / "MonitoringDefinition" are the ones that overflow their box once the
 * wide-metric override is applied. */
const DIAGRAM = [
    '@startuml',
    'package "Querschnitt" {',
    '  rectangle "Observability /\\nMonitoringDefinition" as OBS',
    '  rectangle "Change / Release" as CHG',
    '  rectangle "BackupPolicy /\\nRestoreEvidence" as BKP',
    '  rectangle "AccessPolicy / SecretRecord /\\nVulnerabilityRecord" as SEC',
    '  rectangle "CapacityRecord" as CAP',
    '}',
    '@enduml',
].join('\n');

/** Widens the PAINTED glyph advance so the engine-sized boxes overflow deterministically even on
 * macOS+Helvetica. textLength (the fix) overrides total advance, so fixed labels still fit. */
const WIDE_METRIC_CSS = `${BLOCK} svg text { letter-spacing: 1.5px !important; }`;

const fence = (lang: string, src: string): string => '```' + lang + '\n' + src + '\n```';

let shippingCss = '';
let server: ViteDevServer | null = null;
let baseUrl = '';

test.beforeAll(async () => {
    expect(
        existsSync(webAssets),
        `packages/web/dist/assets missing — run \`bun run build\` before this e2e (the injected CSS carries the real plantuml font cascade the labels paint with)`,
    ).toBe(true);

    const cssFiles = readdirSync(webAssets).filter((f) => f.endsWith('.css'));
    expect(cssFiles.length, 'no compiled .css in packages/web/dist/assets').toBeGreaterThan(0);
    shippingCss = cssFiles.map((f) => readFileSync(path.join(webAssets, f), 'utf-8')).join('\n');

    server = await createServer({
        root: fixtureRoot,
        configFile: fixtureConfig,
        logLevel: 'error',
        // Distinct port so a serial full-suite run never collides on strictPort.
        server: { port: 5300, strictPort: true },
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

async function mount(page: Page): Promise<void> {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__plReady === true, { timeout: 20_000 });
    await page.addStyleTag({ content: shippingCss });
    await page.addStyleTag({ content: WIDE_METRIC_CSS });
}

async function setMarkdown(page: Page, markdown: string): Promise<void> {
    await page.evaluate((md) => window.__plSetMarkdown?.(md), markdown);
}

async function waitForRenderedPlantuml(page: Page): Promise<void> {
    await page.waitForSelector(`${PL_HOST} svg`, { timeout: RENDER_BOUND_MS });
    await page.waitForFunction(
        (sel) => {
            const svg = document.querySelector(sel);
            return !!svg && svg.querySelectorAll('text').length > 0;
        },
        `${PL_HOST} svg`,
        { timeout: RENDER_BOUND_MS },
    );
}

/**
 * For every boxed <text> (a <text> whose bbox centre lies inside some <rect>), report whether it
 * horizontally overflows the usable inner width of its SMALLEST enclosing rect. `stripFit` first
 * removes the fit attributes, simulating the fitBoxText call being reverted.
 */
function measureBoxOverflow(
    page: Page,
    opts: { stripFit: boolean },
): Promise<{
    boxedCount: number;
    withTextLength: number;
    overflows: Array<{ t: string; textW: number; usable: number }>;
}> {
    return page.evaluate(
        ({ hostSel, stripFit, padPx }) => {
            const svg = document.querySelector<SVGSVGElement>(`${hostSel} svg`);
            if (!svg) return { boxedCount: 0, withTextLength: 0, overflows: [] };

            const texts = Array.from(svg.querySelectorAll<SVGGraphicsElement>('text'));
            if (stripFit) {
                for (const t of texts) {
                    t.removeAttribute('textLength');
                    t.removeAttribute('lengthAdjust');
                }
            }

            type Box = { x: number; y: number; width: number; height: number };
            const boxes: Box[] = [];
            for (const rect of Array.from(svg.querySelectorAll<SVGGraphicsElement>('rect'))) {
                const b = rect.getBBox();
                if (b.width <= 0 || b.height <= 0) continue;
                boxes.push({ x: b.x, y: b.y, width: b.width, height: b.height });
            }

            let boxedCount = 0;
            let withTextLength = 0;
            const overflows: Array<{ t: string; textW: number; usable: number }> = [];

            for (const t of texts) {
                const tb = t.getBBox();
                if (tb.width <= 0) continue;
                const cx = tb.x + tb.width / 2;
                const cy = tb.y + tb.height / 2;

                let box: Box | null = null;
                let area = Number.POSITIVE_INFINITY;
                for (const c of boxes) {
                    if (cx < c.x || cx > c.x + c.width || cy < c.y || cy > c.y + c.height) continue;
                    const a = c.width * c.height;
                    if (a < area) {
                        area = a;
                        box = c;
                    }
                }
                if (!box) continue;

                boxedCount += 1;
                if (t.getAttribute('textLength')) withTextLength += 1;

                // Usable width uses a SMALLER pad than the fix (3px) so a correctly condensed
                // label (width == box.width-6) comfortably clears this threshold (box.width-4).
                const usable = box.width - padPx * 2;
                if (tb.width > usable) {
                    overflows.push({ t: (t.textContent ?? '').trim(), textW: tb.width, usable });
                }
            }

            return { boxedCount, withTextLength, overflows };
        },
        { hostSel: PL_HOST, stripFit: opts.stripFit, padPx: 2 },
    );
}

test.describe('PlantUML box-label overflow — real Chromium (openchamber-f9d.26.1)', () => {
    test('AC4 GREEN: every boxed label fits inside its rect after the fit pass', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, fence('plantuml', DIAGRAM));
        await waitForRenderedPlantuml(page);

        const result = await measureBoxOverflow(page, { stripFit: false });

        // The diagram genuinely has boxed labels to protect (guards against a vacuous pass).
        expect(result.boxedCount, 'no boxed <text> found in the rendered diagram').toBeGreaterThan(0);
        // The fit pass actually fired on the wide-metric overflow (>=1 label got a textLength).
        expect(
            result.withTextLength,
            'fitBoxText set no textLength — the overflow was not detected/condensed',
        ).toBeGreaterThan(0);
        // Core GREEN: zero boxed label overflows its rect usable width.
        expect(
            result.overflows,
            `boxed labels still overflow after fit: ${JSON.stringify(result.overflows.slice(0, 5))}`,
        ).toEqual([]);
    });

    test('AC4 RED-on-revert: stripping the fit attributes reintroduces box overflow', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, fence('plantuml', DIAGRAM));
        await waitForRenderedPlantuml(page);

        // Simulate reverting the fitBoxText call: remove textLength/lengthAdjust, re-measure.
        const reverted = await measureBoxOverflow(page, { stripFit: true });

        expect(reverted.boxedCount).toBeGreaterThan(0);
        // Without the fit pass, the wide-metric labels overflow their boxes (the bug returns).
        expect(
            reverted.overflows.length,
            'expected >=1 box overflow once the fit attributes are stripped (RED-on-revert)',
        ).toBeGreaterThan(0);
    });
});
