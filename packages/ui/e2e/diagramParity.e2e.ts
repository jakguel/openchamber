/**
 * Playwright real-Chromium PARITY proof — Story D VALIDATION (openchamber-f9d.17.4).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.17   Task: openchamber-f9d.17.4
 *
 * Proves PlantUML inline diagrams reached FULL parity with Mermaid after Story D's three impl
 * tasks (.17.1 CSS margin + fullscreen variant, .17.2 plantuml-expand magnify button, .17.3
 * fullscreen popup branches on diagram.kind), PLUS a Mermaid no-regression check. Every module
 * is the production implementation — the diagram-parity fixture mounts the REAL
 * SimpleMarkdownRenderer + the REAL ToolOutputDialog wired with the genuine ChatMessage
 * onShowPopup state-setter pattern (no internal src/ mock). The REAL shipped diagram CSS is
 * injected from src/index.css, so a reverted margin/fullscreen rule makes the assertion fail.
 *
 * The five parity pieces, each with a non-vacuous assertion that fails if it regresses:
 *   AC1  PlantUML whole-SVG body-text scaling — the [data-md-diagram="plantuml"] host carries
 *        data-md-diagram-scale ≈ clamp(bodyPx / intrinsicFontPx) and a matching transform:scale.
 *   AC2  PlantUML block vertical margin — computed margin-top/bottom > 0 (my-4 parity).
 *   AC3  magnify -> real popup -> pan/zoom — clicking plantuml-expand opens the fullscreen popup
 *        which renders a REAL plantuml svg (NOT a mermaid block/error); wheel zooms and drag pans
 *        clamped to the viewport+100px bound.
 *   AC4  Mermaid no-regression — the SAME scaling/margin/magnify/pan-zoom assertions still pass.
 *   AC5  real Chromium (svg.getBBox() > 0, impossible in jsdom) with no internal mocks.
 *
 * WHY real Chromium (not jsdom): mermaid + @plantuml/core need a real layout engine; jsdom's
 * getBBox() returns 0 so a rendered diagram — and every scale/margin/pan measurement here — is
 * meaningless there.
 *
 * WHY the PlantUML waits are generous but BOUNDED: the first engine load compiles ~8.6MB of WASM.
 * The waits are real pass/fail signals (a diagram that never renders blows the bound), not sleeps.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright, it pulls a mismatched runner):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium diagramParity
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
        __applyDiagramBodyScale?: () => void;
        __parityReady?: boolean;
    }
}

const RENDER_BOUND_MS = 60_000;
const CONTAINER_BODY_PX = 15;
const SCALE_MIN = 0.6;
const SCALE_MAX = 1.4;

const PLANTUML_SRC = '@startuml\nAlphaOne -> BetaTwo : ping\n@enduml';
const MERMAID_SRC = 'graph TD\n  A[Start] --> B[Middle]\n  B --> C[End]';

const plantumlFence = (src: string): string => '```plantuml\n' + src + '\n```';
const mermaidFence = (src: string): string => '```mermaid\n' + src + '\n```';

type DiagramKind = 'mermaid' | 'plantuml';

const BLOCK = (kind: DiagramKind) => `[data-markdown="${kind}-block"]`;
const HOST = (kind: DiagramKind) => `[data-md-diagram="${kind}"]`;
const EXPAND = (kind: DiagramKind) => `[data-md-action="${kind}-expand"]`;
const POPUP = '[data-testid="diagram-panzoom"]';
const POPUP_CONTENT = '[data-diagram-panzoom-content]';

/** Extract the REAL contiguous diagram CSS (mermaid + plantuml, inline block + fullscreen popup)
 *  from the shipped index.css — injecting the actual source text (not a hand-copied copy) means
 *  the margin/fullscreen assertions track exactly what ships. */
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

/** Render an inline diagram, wait for the REAL painted svg, then apply the shared body-text
 *  scaling contract and wait for the stamp. The scaling is exercised via the production
 *  applyDiagramBodyScale function (exposed at the app boundary — NOT a mock), invoked on the
 *  settled svg exactly as the sanctioned mermaid scaling test (mermaidInlineFit) invokes it.
 *  PlantUML paints async, so this proves the generic [data-md-diagram] selector scales a real
 *  plantuml svg toward the body font-size; a regressed selector or an untagged host stamps
 *  nothing and this fails. */
async function renderScaledInlineDiagram(page: Page, kind: DiagramKind, fence: string): Promise<void> {
    await setMarkdown(page, fence);
    await page.waitForSelector(`${BLOCK(kind)} ${HOST(kind)} svg`, { timeout: RENDER_BOUND_MS });
    await page.evaluate(() => window.__applyDiagramBodyScale?.());
    await page.waitForFunction(
        (hostSel) => {
            const host = document.querySelector(hostSel);
            const svg = host?.querySelector('svg');
            const attr = host?.getAttribute('data-md-diagram-scale');
            return !!svg && attr != null && Number.isFinite(Number.parseFloat(attr));
        },
        HOST(kind),
        { timeout: 10_000 },
    );
}

/** Read the intrinsic svg font px the SAME way diagramScale.readIntrinsicSvgFontPx does, plus the
 *  stamped scale + the computed host transform — so AC1/AC4 can prove the scale is toward body px. */
function measureScale(page: Page, kind: DiagramKind) {
    return page.evaluate(
        ({ hostSel }) => {
            const host = document.querySelector(hostSel) as HTMLElement | null;
            const svg = host?.querySelector('svg') as SVGElement | null;
            const readIntrinsic = (el: SVGElement | null): number => {
                if (!el) return NaN;
                const textEl = el.querySelector('text');
                if (textEl) {
                    const computed = Number.parseFloat(getComputedStyle(textEl).fontSize);
                    if (Number.isFinite(computed) && computed > 0) return computed;
                    const attr = Number.parseFloat(textEl.getAttribute('font-size') ?? '');
                    if (Number.isFinite(attr) && attr > 0) return attr;
                }
                const rootComputed = Number.parseFloat(getComputedStyle(el).fontSize);
                return Number.isFinite(rootComputed) && rootComputed > 0 ? rootComputed : NaN;
            };
            return {
                hasScaleAttr: host?.hasAttribute('data-md-diagram-scale') ?? false,
                appliedScale: host ? Number.parseFloat(host.getAttribute('data-md-diagram-scale') ?? 'NaN') : NaN,
                hostTransform: host ? getComputedStyle(host).transform : '',
                intrinsicFontPx: readIntrinsic(svg),
                svgBBoxWidth: svg && 'getBBox' in svg ? (svg as SVGGraphicsElement).getBBox().width : -1,
            };
        },
        { hostSel: HOST(kind) },
    );
}

function measureBlockMargin(page: Page, kind: DiagramKind) {
    return page.evaluate((blockSel) => {
        const block = document.querySelector(blockSel) as HTMLElement | null;
        if (!block) return { marginTop: -1, marginBottom: -1 };
        const style = getComputedStyle(block);
        return {
            marginTop: Number.parseFloat(style.marginTop),
            marginBottom: Number.parseFloat(style.marginBottom),
        };
    }, BLOCK(kind));
}

function readPopupTransform(page: Page): Promise<string> {
    return page.evaluate((sel) => {
        const content = document.querySelector(sel) as HTMLElement | null;
        return content?.style.transform ?? '';
    }, POPUP_CONTENT);
}

function parseTransform(transform: string): { x: number; y: number; scale: number } {
    const translate = transform.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/);
    const scale = transform.match(/scale\(\s*(-?[\d.]+)\s*\)/);
    return {
        x: translate ? Number.parseFloat(translate[1]) : NaN,
        y: translate ? Number.parseFloat(translate[2]) : NaN,
        scale: scale ? Number.parseFloat(scale[1]) : NaN,
    };
}

/** Drive magnify -> popup -> pan/zoom for one diagram kind and assert the whole parity path. The
 *  popup renders a fresh async diagram, so wait for ITS svg before touching the pan/zoom surface. */
async function assertMagnifyPopupPanZoom(page: Page, kind: DiagramKind): Promise<void> {
    expect(await page.locator(POPUP).count()).toBe(0);

    await page.evaluate((sel) => {
        const btn = document.querySelector(sel) as HTMLElement | null;
        btn?.click();
    }, EXPAND(kind));

    await page.waitForSelector(POPUP, { timeout: 10_000 });
    await page.waitForSelector(`${POPUP} ${BLOCK(kind)} svg`, { timeout: RENDER_BOUND_MS });

    const popupContents = await page.evaluate(
        ({ popupSel, kindBlockSel, otherBlockSel }) => {
            const popup = document.querySelector(popupSel);
            return {
                kindSvgCount: popup ? popup.querySelectorAll(`${kindBlockSel} svg`).length : 0,
                otherBlockCount: popup ? popup.querySelectorAll(otherBlockSel).length : 0,
            };
        },
        {
            popupSel: POPUP,
            kindBlockSel: BLOCK(kind),
            otherBlockSel: BLOCK(kind === 'plantuml' ? 'mermaid' : 'plantuml'),
        },
    );
    expect(popupContents.kindSvgCount).toBeGreaterThan(0);
    expect(popupContents.otherBlockCount).toBe(0);

    const initial = parseTransform(await readPopupTransform(page));
    expect(initial.x).toBe(0);
    expect(initial.y).toBe(0);
    expect(initial.scale).toBe(1);

    const box = await page.locator(POPUP).boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -600);
    await page.waitForFunction((sel) => {
        const c = document.querySelector(sel) as HTMLElement | null;
        return !!c && Number.parseFloat((c.style.transform.match(/scale\(([\d.]+)\)/) ?? ['', '1'])[1]) > 1;
    }, POPUP_CONTENT);
    const zoomed = parseTransform(await readPopupTransform(page));
    expect(zoomed.scale).toBeGreaterThan(1);

    const geometry = await page.evaluate(
        ({ popupSel, contentSel }) => {
            const container = document.querySelector(popupSel) as HTMLElement;
            const content = document.querySelector(contentSel) as HTMLElement;
            const scale = Number.parseFloat((content.style.transform.match(/scale\(([\d.]+)\)/) ?? ['', '1'])[1]);
            const maxX = Math.max(0, (content.offsetWidth * scale - container.clientWidth) / 2) + 100;
            const maxY = Math.max(0, (content.offsetHeight * scale - container.clientHeight) / 2) + 100;
            return { maxX, maxY };
        },
        { popupSel: POPUP, contentSel: POPUP_CONTENT },
    );

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 5000, cy + 5000, { steps: 6 });
    await page.mouse.up();

    const dragged = parseTransform(await readPopupTransform(page));
    expect(dragged.x).toBeGreaterThan(0);
    expect(dragged.y).toBeGreaterThan(0);
    expect(dragged.x).toBeLessThanOrEqual(geometry.maxX + 1);
    expect(dragged.y).toBeLessThanOrEqual(geometry.maxY + 1);
    expect(dragged.x).toBeCloseTo(geometry.maxX, 0);
    expect(dragged.y).toBeCloseTo(geometry.maxY, 0);
}

test.describe('Story D — PlantUML/Mermaid inline diagram parity (real Chromium)', () => {
    test('AC1: a plantuml-block svg is whole-SVG scaled toward the container body font-size', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await renderScaledInlineDiagram(page, 'plantuml', plantumlFence(PLANTUML_SRC));

        const m = await measureScale(page, 'plantuml');
        expect(m.hasScaleAttr).toBe(true);
        expect(Number.isFinite(m.appliedScale)).toBe(true);
        expect(m.appliedScale).toBeGreaterThanOrEqual(SCALE_MIN);
        expect(m.appliedScale).toBeLessThanOrEqual(SCALE_MAX);
        // Non-vacuous "toward body font-size": the stamped scale equals clamp(bodyPx/intrinsic).
        expect(Number.isFinite(m.intrinsicFontPx)).toBe(true);
        const expected = Math.min(SCALE_MAX, Math.max(SCALE_MIN, CONTAINER_BODY_PX / m.intrinsicFontPx));
        expect(m.appliedScale).toBeCloseTo(expected, 2);
        // A scale != 1 must actually stamp a transform:scale on the host (matrix, not "none").
        if (Math.abs(m.appliedScale - 1) > 0.005) {
            expect(m.hostTransform).not.toBe('none');
            expect(m.hostTransform).toContain('matrix');
        }
    });

    test('AC2: [data-markdown=plantuml-block] has a non-zero vertical margin (mermaid parity)', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, plantumlFence(PLANTUML_SRC));
        await page.waitForSelector(BLOCK('plantuml'), { timeout: 15_000 });

        const margin = await measureBlockMargin(page, 'plantuml');
        expect(margin.marginTop).toBeGreaterThan(0);
        expect(margin.marginBottom).toBeGreaterThan(0);
    });

    test('AC3: the plantuml magnify button opens a REAL plantuml fullscreen popup with pan/zoom', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 90_000);
        await mount(page);
        await setMarkdown(page, plantumlFence(PLANTUML_SRC));
        await page.waitForSelector(`${BLOCK('plantuml')} svg`, { timeout: RENDER_BOUND_MS });
        await page.waitForSelector(EXPAND('plantuml'), { timeout: 15_000 });

        await assertMagnifyPopupPanZoom(page, 'plantuml');
    });

    test('AC4: mermaid no-regression — scaling, margin, magnify popup, pan/zoom still pass', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await renderScaledInlineDiagram(page, 'mermaid', mermaidFence(MERMAID_SRC));

        const m = await measureScale(page, 'mermaid');
        expect(m.hasScaleAttr).toBe(true);
        expect(Number.isFinite(m.appliedScale)).toBe(true);
        expect(m.appliedScale).toBeGreaterThanOrEqual(SCALE_MIN);
        expect(m.appliedScale).toBeLessThanOrEqual(SCALE_MAX);
        expect(Number.isFinite(m.intrinsicFontPx)).toBe(true);
        const expected = Math.min(SCALE_MAX, Math.max(SCALE_MIN, CONTAINER_BODY_PX / m.intrinsicFontPx));
        expect(m.appliedScale).toBeCloseTo(expected, 2);

        const margin = await measureBlockMargin(page, 'mermaid');
        expect(margin.marginTop).toBeGreaterThan(0);
        expect(margin.marginBottom).toBeGreaterThan(0);

        await page.waitForSelector(EXPAND('mermaid'), { timeout: 15_000 });
        await assertMagnifyPopupPanZoom(page, 'mermaid');
    });

    test('AC5: runs in real Chromium (svg.getBBox() > 0) with no internal mocks', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, plantumlFence(PLANTUML_SRC));
        await page.waitForSelector(`${BLOCK('plantuml')} ${HOST('plantuml')} svg`, { timeout: RENDER_BOUND_MS });

        // getBBox() returns a real, non-zero geometry ONLY under a real layout engine; jsdom
        // reports 0, so a passing measurement here is proof this parity suite ran in Chromium.
        const bboxWidth = await page.evaluate((hostSel) => {
            const svg = document.querySelector(`${hostSel} svg`) as SVGGraphicsElement | null;
            return svg && 'getBBox' in svg ? svg.getBBox().width : 0;
        }, HOST('plantuml'));
        expect(bboxWidth).toBeGreaterThan(0);
    });
});
