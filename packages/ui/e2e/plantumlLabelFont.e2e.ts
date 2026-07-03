/**
 * Playwright real-Chromium proof — PlantUML edge-label FONT fix (openchamber-f9d.23.3).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.23   Task: openchamber-f9d.23.3
 *
 * ROOT CAUSE this test locks in: PlantUML relation/edge <text> nodes carry NO font-family, so they
 * inherit `.markdown-content { font-family: var(--font-sans) }`. In this project --font-sans is
 * actually "IBM Plex Mono", …, monospace (design-system.css `@theme inline`). The @plantuml/core
 * engine measured label placement with PROPORTIONAL (sans-serif) metrics, so rendering the labels
 * in a monospace face drifts them off their ortho relation axes. The fix is a single SCOPED CSS
 * rule in index.css:  `[data-markdown="plantuml-block"] svg text { font-family: "Helvetica", Arial,
 * sans-serif; }`  — block-scoped so it also covers the fullscreen surface (which wraps the same
 * [data-markdown="plantuml-block"]).
 *
 * WHY this is a faithful, meaningful test (would FAIL if the fix were reverted):
 *  - It mounts the REAL production markdown pipeline (SimpleMarkdownRenderer -> decorate.ts ->
 *    renderPlantuml -> @plantuml/core) via the shared fixtures/plantuml-pipeline harness. NOTHING
 *    under src/ is mocked.
 *  - It injects the ACTUAL SHIPPING CSS compiled into packages/web/dist (the built index.css +
 *    design-system.css bundle). That bundle carries BOTH the offending `.markdown-content` monospace
 *    cascade AND the scoped fix. So the assertion runs against the true cascade the app ships.
 *  - A meaningfulness guard proves the monospace cascade is genuinely active (a body <p> computes to
 *    IBM Plex Mono). Without the fix rule, the svg <text> would inherit that SAME monospace family —
 *    which is exactly what the font-family assertions forbid.
 *
 * WHY real Chromium (not jsdom): @plantuml/core needs a real layout engine — jsdom getBBox() = 0,
 * and getComputedStyle only resolves the CSS cascade in a live document.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright, it pulls a mismatched runner):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium plantumlLabelFont --workers=1
 *
 * REQUIRES: packages/web/dist built first (`bun run build`) so the injected CSS contains the fix.
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'plantuml-pipeline');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');
// packages/ui/e2e -> ../../web/dist == packages/web/dist (the shipping bundle).
const webDist = path.resolve(currentDir, '..', '..', 'web', 'dist');
const webAssets = path.join(webDist, 'assets');

const reproPath =
    '/var/folders/vj/lcj_zjls6sddv8qcbw1kj7y00000gp/T/opencode/plantuml-repro-jiyan.puml';

const BLOCK = '[data-markdown="plantuml-block"]';
const PL_HOST = `${BLOCK} [data-markdown="plantuml"]`;
const PL_TEXT = `${PL_HOST} svg text`;

/** Generous but BOUNDED — the first engine load compiles ~8.6MB of WASM, then lays out ~90 ortho
 * relations. A perpetual spinner (or a broken cascade) blows this bound, so the wait is a real
 * pass/fail signal, not a sleep. */
const RENDER_BOUND_MS = 90_000;

const DIAGRAM_SCALE_MAX = 1.4; // mirrors diagramScale.ts DIAGRAM_SCALE_MAX

/** A minimal crow's-foot + ortho ER fallback, used only if the canonical repro file is absent.
 * Still exercises several LABELED ortho relations so the font/placement assertions stay meaningful. */
const FALLBACK_REPRO = [
    '@startuml',
    'hide circle',
    'hide empty members',
    'skinparam linetype ortho',
    'Platform ||--o{ Node : hostet',
    'Platform ||--o{ Cluster : enthaelt',
    'Service ||--o{ SLO : hat',
    'SLA ||--o{ SLO : aggregiert',
    'Incident }o--|| Service : betrifft',
    'DRProcedure }o--|| Service : schuetzt',
    'Postmortem }o--|| Incident : analysiert',
    '@enduml',
].join('\n');

/** Single-token relation labels present in the canonical repro (and the fallback). Single tokens
 * are rendered as one <text> node, so they are robust to identify vs. multi-word labels. */
const KNOWN_LABEL_TOKENS = [
    'hostet',
    'aggregiert',
    'betrifft',
    'analysiert',
    'erfordert',
    'nutzt',
    'Quelle',
    'Ziel',
    'schuetzt',
    'schützt',
    'enthält',
    'enthaelt',
    'hat',
];

const MERMAID = 'graph LR\n  Alpha -->|edgelabel| Beta\n  Beta --> Gamma';

const fence = (lang: string, src: string): string => '```' + lang + '\n' + src + '\n```';

function reproSource(): string {
    if (existsSync(reproPath)) {
        const raw = readFileSync(reproPath, 'utf-8').trim();
        if (raw.length > 0) return raw;
    }
    return FALLBACK_REPRO;
}

/** The concatenated shipping CSS (built index.css bundle). Read once in beforeAll and injected into
 * the fixture page so the REAL cascade — offending monospace rule + scoped fix — is present. */
let shippingCss = '';

let server: ViteDevServer | null = null;
let baseUrl = '';

test.beforeAll(async () => {
    // Fail LOUDLY if the shipping bundle is missing — the whole point is to assert against real CSS.
    expect(
        existsSync(webAssets),
        `packages/web/dist/assets missing — run \`bun run build\` before this e2e (it must contain the built index.css with the plantuml font fix)`,
    ).toBe(true);

    const cssFiles = readdirSync(webAssets).filter((f) => f.endsWith('.css'));
    expect(cssFiles.length, 'no compiled .css in packages/web/dist/assets').toBeGreaterThan(0);
    shippingCss = cssFiles.map((f) => readFileSync(path.join(webAssets, f), 'utf-8')).join('\n');

    // Sanity: the built CSS actually carries BOTH sides of the cascade this test reasons about —
    // the scoped fix AND the monospace token it overrides. A stale build (fix not compiled) fails
    // here rather than producing a misleading green.
    expect(
        /\[data-markdown=["']?plantuml-block["']?\][^{]*svg[^{]*text[^{]*\{[^}]*font-family/i.test(shippingCss),
        'built CSS does not contain the scoped `[data-markdown="plantuml-block"] svg text { font-family }` fix — rebuild packages/web',
    ).toBe(true);
    expect(
        /IBM Plex Mono/i.test(shippingCss),
        'built CSS does not define the monospace --font-sans token — unexpected bundle',
    ).toBe(true);

    server = await createServer({
        root: fixtureRoot,
        configFile: fixtureConfig,
        logLevel: 'error',
        // Distinct port from plantumlIntegration.e2e.ts (5198) so a serial full-suite run never
        // collides on strictPort.
        server: { port: 5297, strictPort: true },
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
    // Inject the real shipping cascade BEFORE any render so diagramScale (which reads the first
    // <text> font-size during paint) and the font-family cascade both run against real CSS.
    await page.addStyleTag({ content: shippingCss });
}

async function setMarkdown(page: Page, markdown: string): Promise<void> {
    await page.evaluate((md) => window.__plSetMarkdown?.(md), markdown);
}

async function waitForRenderedPlantuml(page: Page): Promise<void> {
    await page.waitForSelector(`${PL_HOST} svg`, { timeout: RENDER_BOUND_MS });
    // Wait until the svg actually has painted <text> nodes (labels/entities), not just an empty svg.
    await page.waitForFunction(
        (sel) => {
            const svg = document.querySelector(sel);
            return !!svg && svg.querySelectorAll('text').length > 0;
        },
        `${PL_HOST} svg`,
        { timeout: RENDER_BOUND_MS },
    );
}

/** Computed font-family of every plantuml <text>, paired with its trimmed text. */
function textFontInfo(page: Page): Promise<Array<{ t: string; ff: string }>> {
    return page.$$eval(PL_TEXT, (nodes) =>
        nodes.map((n) => ({
            t: (n.textContent ?? '').trim(),
            ff: getComputedStyle(n as Element).fontFamily,
        })),
    );
}

const isProportionalSans = (ff: string): boolean => {
    const f = ff.toLowerCase();
    return (
        !f.includes('plex') &&
        !f.includes('mono') &&
        (f.includes('helvetica') || f.includes('arial') || f.includes('sans-serif'))
    );
};

test.describe('PlantUML label font — real Chromium (openchamber-f9d.23.3)', () => {
    test('AC4: every PlantUML svg <text> resolves to a proportional sans-serif, NOT IBM Plex Mono/monospace', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);

        // Body <p> BEFORE the diagram proves the monospace cascade is genuinely active — this is the
        // exact family the label <text> would inherit if the scoped fix were absent.
        await setMarkdown(page, `Body text paragraph.\n\n${fence('plantuml', reproSource())}`);
        await waitForRenderedPlantuml(page);

        const paragraphFont = await page.$eval('.markdown-content p', (p) =>
            getComputedStyle(p).fontFamily,
        );
        // Meaningfulness guard: the container cascade IS monospace (IBM Plex Mono). Without the fix,
        // svg <text> inherits THIS — so the assertions below would fail.
        expect(paragraphFont.toLowerCase()).toContain('plex');

        const fonts = await textFontInfo(page);
        expect(fonts.length, 'no <text> rendered in the plantuml svg').toBeGreaterThan(0);

        // Core AC4: NO plantuml <text> may render in a monospace / IBM Plex face.
        const monoOffenders = fonts.filter(
            (x) => x.ff.toLowerCase().includes('plex') || x.ff.toLowerCase().includes('mono'),
        );
        expect(
            monoOffenders,
            `plantuml <text> still inheriting monospace: ${JSON.stringify(monoOffenders.slice(0, 5))}`,
        ).toEqual([]);

        // ...and every <text> is positively a proportional sans-serif (the forced family).
        const nonSans = fonts.filter((x) => !isProportionalSans(x.ff));
        expect(
            nonSans,
            `plantuml <text> not resolving to a proportional sans-serif: ${JSON.stringify(nonSans.slice(0, 5))}`,
        ).toEqual([]);

        // Specifically the RELATION LABELS (the drifting elements) are covered: several known
        // single-token labels are present and each is sans-serif.
        const labelHits = fonts.filter((x) => KNOWN_LABEL_TOKENS.includes(x.t));
        expect(
            labelHits.length,
            `expected several relation labels among rendered <text>; found: ${labelHits.length}`,
        ).toBeGreaterThanOrEqual(3);
        for (const label of labelHits) {
            expect(isProportionalSans(label.ff), `label "${label.t}" font ${label.ff}`).toBe(true);
        }
    });

    test('AC1: relation labels fit within the diagram bounds (no monospace overflow off their axes)', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, fence('plantuml', reproSource()));
        await waitForRenderedPlantuml(page);

        // Placement of PlantUML labels is baked into the SVG x/y by the engine (no runtime JS
        // repositioning), so once the browser renders them in the SAME proportional metrics the
        // engine used, they sit on their edges. The robust, non-brittle geometric signal for that:
        // no label <text> paints wider than the diagram viewport (a monospace face would balloon
        // label widths past the engine-computed slots and spill them off the ortho lines).
        const overflow = await page.evaluate(
            ({ hostSel, tokens }) => {
                const svg = document.querySelector<SVGSVGElement>(`${hostSel} svg`);
                if (!svg) return { ok: false, reason: 'no svg', svgW: 0, maxLabelW: 0 };
                const svgW = svg.getBoundingClientRect().width;
                let maxLabelW = 0;
                let widest = '';
                const texts = Array.from(svg.querySelectorAll('text'));
                for (const t of texts) {
                    const s = (t.textContent ?? '').trim();
                    if (!tokens.includes(s)) continue;
                    const w = (t as SVGGraphicsElement).getBoundingClientRect().width;
                    if (w > maxLabelW) {
                        maxLabelW = w;
                        widest = s;
                    }
                }
                return { ok: true, reason: '', svgW, maxLabelW, widest };
            },
            { hostSel: PL_HOST, tokens: KNOWN_LABEL_TOKENS },
        );

        expect(overflow.ok, overflow.reason).toBe(true);
        expect(overflow.svgW, 'svg has zero width').toBeGreaterThan(0);
        // A single relation label must be a small fraction of the whole diagram width — never
        // spilling across it. Generous ceiling (half the diagram) still catches monospace ballooning.
        expect(
            overflow.maxLabelW,
            `label "${overflow.widest}" width ${overflow.maxLabelW}px vs svg ${overflow.svgW}px`,
        ).toBeLessThan(overflow.svgW * 0.5);
    });

    test('AC5: diagramScale still reads a sane intrinsic font-size and sets a positive host scale', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);
        await setMarkdown(page, fence('plantuml', reproSource()));
        await waitForRenderedPlantuml(page);

        const scaleInfo = await page.evaluate((hostSel) => {
            const host = document.querySelector<HTMLElement>(hostSel);
            const svg = host?.querySelector('svg') ?? null;
            const firstText = svg?.querySelector('text') ?? null;
            const intrinsicPx = firstText
                ? Number.parseFloat(getComputedStyle(firstText).fontSize)
                : NaN;
            const scaleAttr = host?.getAttribute('data-md-diagram-scale') ?? null;
            return { intrinsicPx, scaleAttr };
        }, PL_HOST);

        // The font-family fix does NOT touch font-size, so diagramScale's input (the first <text>
        // computed font-size) must stay a sane px — proving the scale pipeline is intact.
        expect(Number.isFinite(scaleInfo.intrinsicPx)).toBe(true);
        expect(scaleInfo.intrinsicPx).toBeGreaterThan(4);
        expect(scaleInfo.intrinsicPx).toBeLessThan(48);

        // The host scale attribute is present (intrinsic was readable -> not removed) and a positive,
        // finite value that never exceeds the legibility upscale ceiling.
        expect(scaleInfo.scaleAttr, 'data-md-diagram-scale not set on host').not.toBeNull();
        const scale = Number.parseFloat(scaleInfo.scaleAttr ?? 'NaN');
        expect(Number.isFinite(scale)).toBe(true);
        expect(scale).toBeGreaterThan(0);
        expect(scale).toBeLessThanOrEqual(DIAGRAM_SCALE_MAX + 0.001);
    });

    test('AC2 + AC3: labels stay sans-serif in DARK theme and on the fullscreen surface', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 90_000);
        await mount(page);

        // DARK theme: flip via the real theme system, render, assert labels are still sans-serif.
        await page.evaluate(() => window.__plSetDark?.(true));
        await setMarkdown(page, fence('plantuml', reproSource()));
        await waitForRenderedPlantuml(page);

        const darkFonts = await textFontInfo(page);
        expect(darkFonts.length).toBeGreaterThan(0);
        const darkOffenders = darkFonts.filter((x) => !isProportionalSans(x.ff));
        expect(
            darkOffenders,
            `dark-theme plantuml <text> not sans-serif: ${JSON.stringify(darkOffenders.slice(0, 5))}`,
        ).toEqual([]);

        // FULLSCREEN surface: the enlarged popup wraps the SAME [data-markdown="plantuml-block"] in
        // an ancestor carrying `.markdown-plantuml-fullscreen`. The scoped fix is block-scoped, so it
        // must still apply there. Add that class to an ancestor and re-check the computed cascade.
        await page.evaluate((blockSel) => {
            const block = document.querySelector(blockSel);
            const host = block?.closest('.markdown-content')?.parentElement ?? document.body;
            host.classList.add('markdown-plantuml-fullscreen');
        }, BLOCK);

        const fullscreenFonts = await textFontInfo(page);
        expect(fullscreenFonts.length).toBeGreaterThan(0);
        const fsOffenders = fullscreenFonts.filter((x) => !isProportionalSans(x.ff));
        expect(
            fsOffenders,
            `fullscreen plantuml <text> not sans-serif: ${JSON.stringify(fsOffenders.slice(0, 5))}`,
        ).toEqual([]);
    });

    test('AC6: Mermaid is unaffected — the scoped fix cannot select a mermaid diagram', async ({
        page,
    }) => {
        test.setTimeout(RENDER_BOUND_MS + 30_000);
        await mount(page);
        await setMarkdown(page, fence('mermaid', MERMAID));

        // The mermaid render lands under its OWN block selector, and paints <text> with its own font.
        await page.waitForSelector('[data-markdown="mermaid-block"] svg text', {
            timeout: RENDER_BOUND_MS,
        });

        const measured = await page.evaluate(
            ({ plBlock, plText }) => {
                const mermaidTexts = Array.from(
                    document.querySelectorAll('[data-markdown="mermaid-block"] svg text'),
                );
                return {
                    plantumlBlockCount: document.querySelectorAll(plBlock).length,
                    // The fix selector targets ONLY plantuml blocks; against a mermaid render it
                    // matches nothing.
                    fixSelectorMatchCount: document.querySelectorAll(plText).length,
                    mermaidTextCount: mermaidTexts.length,
                    mermaidFont:
                        mermaidTexts.length > 0
                            ? getComputedStyle(mermaidTexts[0] as Element).fontFamily
                            : '',
                };
            },
            { plBlock: BLOCK, plText: PL_TEXT },
        );

        // No plantuml block exists for a mermaid-only render, and the plantuml-scoped fix selector
        // matches zero nodes — so mermaid's own SVG font is entirely untouched by this change.
        expect(measured.plantumlBlockCount).toBe(0);
        expect(measured.fixSelectorMatchCount).toBe(0);
        expect(measured.mermaidTextCount).toBeGreaterThan(0);
        expect(measured.mermaidFont.length).toBeGreaterThan(0);
    });
});
