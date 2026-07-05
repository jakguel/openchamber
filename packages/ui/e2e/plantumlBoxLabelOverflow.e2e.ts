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

/** PATH-boxed container title (openchamber-5ki.39.1). A `package` title is drawn inside a
 * `<g class="cluster">` whose background is a `<path>` (folder shape), NOT a `<rect>`. The long
 * package name makes the container size to its title, so — with the wide-metric override — the
 * painted title overflows the path box the same way a rect label does. The pre-fix code only
 * scanned `<rect>`, so this title was skipped and stayed overflowing; Direction A fits it to the
 * cluster's background `<path>`. The inner rectangle carries a multiline label so the diagram also
 * exercises the plain-rect path within the same container. */
const PATH_BOX_DIAGRAM = [
    '@startuml',
    'package "ObservabilityAndMonitoringDefinitionLongTitle" {',
    '  rectangle "Observability /\\nMonitoringDefinition" as OBS',
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

/**
 * FULLSCREEN surface (story openchamber-f9d.26, AC-S1 second half).
 *
 * The fullscreen popup (ToolOutputDialog.tsx) renders the SAME production pipeline
 * (SimpleMarkdownRenderer -> decorate.ts -> renderPlantuml -> @plantuml/core), but wraps the
 * renderer's OUTER container with className `markdown-plantuml-fullscreen` (see
 * ToolOutputDialog.tsx: the class is passed to SimpleMarkdownRenderer, which applies it to the
 * `break-words w-full min-w-0` div — the direct parent of the `[data-markdown-content]` node) and
 * mounts it inside a DiagramPanZoomViewport. fitBoxText runs in decorate.ts on
 * `[data-markdown="plantuml-block"]` for EVERY surface, so the fix already protects fullscreen; the
 * inline block above only proved it for the inline preview. This block adds the missing e2e
 * EVIDENCE that boxed labels are contained on the fullscreen surface too.
 *
 * FAITHFUL rendering: `applyFullscreenSurface` adds `markdown-plantuml-fullscreen` to the EXACT
 * wrapper production targets (the parent of `[data-markdown-content]`) BEFORE the render fires, so
 * decorate.ts/fitBoxText measure the labels within the REAL fullscreen CSS cascade
 * (index.css `.markdown-plantuml-fullscreen [data-markdown="plantuml-block"] …` rules), not after
 * the fact. The DiagramPanZoomViewport only applies a CSS transform for pan/zoom; getBBox() reports
 * geometry in the SVG's own user-coordinate space and is transform-invariant, so the containment
 * metric is identical to what the popup paints — reproducing the viewport transform would change
 * nothing measurable. The SAME wide-metric CSS forcing (letter-spacing) is used, so the fullscreen
 * case is as deterministic as the inline one (overflow pre-fix, condensed by textLength post-fix).
 */
async function applyFullscreenSurface(page: Page): Promise<void> {
    await page.evaluate(() => {
        // `[data-markdown-content]` exists from mount (empty until setMarkdown); its parent is the
        // renderer's outer container — the exact node ToolOutputDialog puts the fullscreen class on.
        const content = document.querySelector('[data-markdown-content]');
        const wrapper = content?.parentElement;
        if (!wrapper) {
            throw new Error('markdown renderer wrapper ([data-markdown-content] parent) not found');
        }
        wrapper.classList.add('markdown-plantuml-fullscreen');
    });
}

test.describe('PlantUML box-label overflow — FULLSCREEN surface (openchamber-f9d.26.1)', () => {
    test('AC-S1 fullscreen guard: the fullscreen class genuinely wraps the rendered plantuml block', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await applyFullscreenSurface(page);
        await setMarkdown(page, fence('plantuml', DIAGRAM));
        await waitForRenderedPlantuml(page);

        // Prove this really is the fullscreen surface: the block resolves through the
        // `.markdown-plantuml-fullscreen` ancestor selector (otherwise the GREEN below is vacuous —
        // it would just be re-proving the inline path under a different describe name).
        const wraps = await page.evaluate(
            (blockSel) => !!document.querySelector(`.markdown-plantuml-fullscreen ${blockSel}`),
            BLOCK,
        );
        expect(
            wraps,
            'markdown-plantuml-fullscreen is not an ancestor of the plantuml block — not the fullscreen surface',
        ).toBe(true);
    });

    test('AC-S1 fullscreen GREEN: every boxed label fits inside its rect after the fit pass', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await applyFullscreenSurface(page);
        await setMarkdown(page, fence('plantuml', DIAGRAM));
        await waitForRenderedPlantuml(page);

        const result = await measureBoxOverflow(page, { stripFit: false });

        // Same three guards as the inline GREEN, now on the fullscreen surface.
        expect(result.boxedCount, 'no boxed <text> found in the fullscreen render').toBeGreaterThan(0);
        expect(
            result.withTextLength,
            'fitBoxText set no textLength on the fullscreen surface — the overflow was not detected/condensed',
        ).toBeGreaterThan(0);
        expect(
            result.overflows,
            `fullscreen boxed labels still overflow after fit: ${JSON.stringify(result.overflows.slice(0, 5))}`,
        ).toEqual([]);
    });

    test('AC-S1 fullscreen RED-on-revert: stripping the fit attributes reintroduces box overflow', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await applyFullscreenSurface(page);
        await setMarkdown(page, fence('plantuml', DIAGRAM));
        await waitForRenderedPlantuml(page);

        // Revert the fitBoxText call on the fullscreen surface: remove textLength/lengthAdjust,
        // re-measure. getBBox is transform-invariant, so the overflow returns exactly as inline.
        const reverted = await measureBoxOverflow(page, { stripFit: true });

        expect(reverted.boxedCount).toBeGreaterThan(0);
        expect(
            reverted.overflows.length,
            'expected >=1 fullscreen box overflow once the fit attributes are stripped (RED-on-revert)',
        ).toBeGreaterThan(0);
    });
});

/**
 * PATH-boxed container-title fit (openchamber-5ki.39.1 — Direction A).
 *
 * The prior fit pass only scanned `<rect>`, so a package/cluster/container TITLE — drawn inside a
 * `<g class="cluster">` whose background is a `<path>`/`<polygon>` (folder/frame shape), never a
 * `<rect>` — was skipped and kept overflowing. Direction A fits each `<text>` to the largest-area
 * direct background shape (rect|path|polygon) of its nearest ancestor entity/cluster group.
 *
 * This measurement mirrors the production selection so it can see PATH-boxed titles the rect-only
 * `measureBoxOverflow` above cannot: for each `<text>` it walks up to the nearest `g.entity`/
 * `g.cluster` and takes that group's largest-area direct rect|path|polygon child as the fit box
 * (the background CHILD bbox, not the group's inflated bbox). It reports the box's shape tag so the
 * test can prove the `<path>` case is genuinely exercised (non-vacuous) and that Direction A — not
 * the old rect-only code — condensed the container title.
 */
function measureGroupBoxOverflow(
    page: Page,
    opts: { stripFit: boolean },
): Promise<{
    boxedCount: number;
    withTextLength: number;
    pathBoxedCount: number;
    pathBoxedWithTextLength: number;
    overflows: Array<{ t: string; shape: string; textW: number; usable: number }>;
}> {
    return page.evaluate(
        ({ hostSel, stripFit, padPx }) => {
            const svg = document.querySelector<SVGSVGElement>(`${hostSel} svg`);
            if (!svg) {
                return {
                    boxedCount: 0,
                    withTextLength: 0,
                    pathBoxedCount: 0,
                    pathBoxedWithTextLength: 0,
                    overflows: [],
                };
            }

            const texts = Array.from(svg.querySelectorAll<SVGGraphicsElement>('text'));
            if (stripFit) {
                for (const t of texts) {
                    t.removeAttribute('textLength');
                    t.removeAttribute('lengthAdjust');
                }
            }

            const nearestGroup = (el: Element): Element | null => {
                let node: Element | null = el.parentElement;
                while (node && node !== svg) {
                    if (node.matches('g.entity, g.cluster')) return node;
                    node = node.parentElement;
                }
                return null;
            };

            type Box = { x: number; y: number; width: number; height: number };
            const bgShape = (group: Element): { tag: string; box: Box } | null => {
                const shapes = Array.from(
                    group.querySelectorAll<SVGGraphicsElement>(
                        ':scope > rect, :scope > path, :scope > polygon',
                    ),
                );
                let best: { tag: string; box: Box } | null = null;
                let maxArea = 0;
                for (const s of shapes) {
                    const b = s.getBBox();
                    if (b.width <= 0 || b.height <= 0) continue;
                    const area = b.width * b.height;
                    if (area > maxArea) {
                        maxArea = area;
                        best = {
                            tag: s.tagName.toLowerCase(),
                            box: { x: b.x, y: b.y, width: b.width, height: b.height },
                        };
                    }
                }
                return best;
            };

            let boxedCount = 0;
            let withTextLength = 0;
            let pathBoxedCount = 0;
            let pathBoxedWithTextLength = 0;
            const overflows: Array<{ t: string; shape: string; textW: number; usable: number }> = [];

            for (const t of texts) {
                const tb = t.getBBox();
                if (tb.width <= 0) continue;
                const group = nearestGroup(t);
                if (!group) continue;
                const bg = bgShape(group);
                if (!bg) continue;

                const cx = tb.x + tb.width / 2;
                const cy = tb.y + tb.height / 2;
                if (
                    cx < bg.box.x ||
                    cx > bg.box.x + bg.box.width ||
                    cy < bg.box.y ||
                    cy > bg.box.y + bg.box.height
                ) {
                    continue;
                }

                boxedCount += 1;
                const hasTextLength = !!t.getAttribute('textLength');
                if (hasTextLength) withTextLength += 1;
                const isPathBox = bg.tag === 'path' || bg.tag === 'polygon';
                if (isPathBox) {
                    pathBoxedCount += 1;
                    if (hasTextLength) pathBoxedWithTextLength += 1;
                }

                // Usable width uses a SMALLER pad than the fix (3px) so a correctly condensed label
                // (width == box.width-6) comfortably clears this threshold (box.width-4).
                const usable = bg.box.width - padPx * 2;
                if (tb.width > usable) {
                    overflows.push({
                        t: (t.textContent ?? '').trim(),
                        shape: bg.tag,
                        textW: tb.width,
                        usable,
                    });
                }
            }

            return { boxedCount, withTextLength, pathBoxedCount, pathBoxedWithTextLength, overflows };
        },
        { hostSel: PL_HOST, stripFit: opts.stripFit, padPx: 2 },
    );
}

test.describe('PlantUML PATH-boxed container-title overflow — real Chromium (openchamber-5ki.39.1)', () => {
    test('AC2 GREEN: a package title in a <path> box is condensed to fit its background shape', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, fence('plantuml', PATH_BOX_DIAGRAM));
        await waitForRenderedPlantuml(page);

        const result = await measureGroupBoxOverflow(page, { stripFit: false });

        expect(result.boxedCount, 'no boxed <text> found in the rendered diagram').toBeGreaterThan(0);
        // Non-vacuous: the container title really is boxed by a <path>/<polygon>, not a <rect>.
        expect(
            result.pathBoxedCount,
            'no <path>/<polygon>-boxed title found — the container-title case is not exercised',
        ).toBeGreaterThan(0);
        // Direction A condensed the PATH-boxed title. The old rect-only code set no textLength here,
        // so this assertion fails if the fix is reverted to scanning <rect> only.
        expect(
            result.pathBoxedWithTextLength,
            'no textLength on any path-boxed title — Direction A did not condense the container title',
        ).toBeGreaterThan(0);
        // Core GREEN: nothing overflows its background shape after the fit pass.
        expect(
            result.overflows,
            `labels still overflow their background shape after fit: ${JSON.stringify(result.overflows.slice(0, 5))}`,
        ).toEqual([]);
    });

    test('AC4 RED-on-revert: stripping the fit attributes reintroduces the path-box title overflow', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, fence('plantuml', PATH_BOX_DIAGRAM));
        await waitForRenderedPlantuml(page);

        // Simulate reverting the fitBoxText call: remove textLength/lengthAdjust, re-measure.
        const reverted = await measureGroupBoxOverflow(page, { stripFit: true });

        expect(reverted.pathBoxedCount).toBeGreaterThan(0);
        const pathOverflows = reverted.overflows.filter(
            (o) => o.shape === 'path' || o.shape === 'polygon',
        );
        expect(
            pathOverflows.length,
            'expected the <path>-boxed container title to overflow once the fit attributes are stripped (RED-on-revert)',
        ).toBeGreaterThan(0);
    });
});
