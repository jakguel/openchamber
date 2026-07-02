/**
 * Playwright real-Chromium INTEGRATION proof — Story C VALIDATION (openchamber-f9d.16.6).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.16   Task: openchamber-f9d.16.6
 *
 * Proves the FULL PlantUML path through the ACTUAL markdown pipeline — NOT the C0 standalone
 * engine harness (plantumlEngine.e2e.ts calls the engine directly). Here a real markdown string
 * with ```plantuml fenced blocks is fed to the REAL production component tree:
 *
 *   SimpleMarkdownRenderer (MarkdownRendererImpl.tsx)
 *     -> useMorphdomMarkdown  (renderMarkdownBlocks + morphdom re-decoration)
 *     -> useDecorateContext   (createPlantumlQueue: single-flight + latest-only backpressure)
 *     -> decorate.ts decoratePlantuml  ([data-markdown=plantuml-block] + spinner/error affordance)
 *     -> renderQueue.ts       (serialize, dedup by key, generation guard)
 *     -> renderPlantuml.ts -> loadEngine.ts  (lazy dynamic import of @plantuml/core)
 *
 * Every module is the production implementation (see fixtures/plantuml-pipeline): the `@` alias
 * resolves each `@/...` import to real src, NOTHING under src/ is mocked. Removing/breaking any
 * behavior (render, error affordance, per-source queue keying, latest-only supersede, chunk
 * isolation, offline-ness) makes the corresponding assertion fail.
 *
 * WHY real Chromium (not jsdom): @plantuml/core needs a real layout engine — jsdom's getBBox()
 * returns 0 so a rendered diagram is meaningless there.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright, it pulls a mismatched runner):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium plantumlIntegration
 */

import { test, expect, type Page, type Request } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'plantuml-pipeline');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');
const uiRoot = path.resolve(currentDir, '..');
const webDist = path.resolve(uiRoot, '..', 'web', 'dist');

declare global {
    interface Window {
        __plSetMarkdown?: (markdown: string) => void;
        __plReady?: boolean;
    }
}

const BLOCK = '[data-markdown="plantuml-block"]';
const LOADING = '[data-markdown="plantuml-loading"]';
const ERROR = '[data-markdown="plantuml-error"]';

/** Generous but BOUNDED — the first engine load compiles ~8.6MB of WASM. A perpetual spinner
 * (the bug AC2 guards) blows this bound, so the wait is a real pass/fail signal, not a sleep. */
const RENDER_BOUND_MS = 60_000;

const fence = (src: string): string => '```plantuml\n' + src + '\n```';

// Distinguishable sources: each participant name lands as an <svg><text> node, so the painted
// diagram is identifiable by which names its svg contains.
const SEQ_ALPHA = '@startuml\nAlphaOne -> BetaTwo : first\n@enduml';
const SEQ_GAMMA = '@startuml\nGammaThree -> DeltaFour : second\n@enduml';
const SEQ_EPSILON = '@startuml\nEpsilonFive -> ZetaSix : third\n@enduml';
const SEQ_OTHER = '@startuml\nManny -> Olive : distinct\n@enduml';
const INVALID = '@startuml\ncomponent {\n!!! not valid <<<>>>\n@enduml';

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

/** Off-origin request collector for AC6 — installed before navigation so the engine load is seen. */
function trackExternalRequests(page: Page): string[] {
    const external: string[] = [];
    page.on('request', (req: Request) => {
        const url = req.url();
        if (/^https?:/.test(url) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) {
            external.push(url);
        }
    });
    return external;
}

async function mount(page: Page): Promise<void> {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__plReady === true, { timeout: 20_000 });
}

async function setMarkdown(page: Page, markdown: string): Promise<void> {
    await page.evaluate((md) => window.__plSetMarkdown?.(md), markdown);
}

/** Text content of the first plantuml block's rendered svg (empty string if none yet). */
function blockSvgText(page: Page, index = 0): Promise<string> {
    return page.evaluate(
        ({ sel, i }) => {
            const blocks = document.querySelectorAll(sel);
            const svg = blocks[i]?.querySelector('svg');
            return svg ? (svg.textContent ?? '') : '';
        },
        { sel: BLOCK, i: index },
    );
}

test.describe('PlantUML markdown pipeline — real Chromium integration (Story C VALIDATION)', () => {
    test('AC1: a ```plantuml fence renders [data-markdown=plantuml-block] > svg within the bound', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 30_000);
        await mount(page);
        await setMarkdown(page, fence(SEQ_ALPHA));

        // The real decorate pass creates the block synchronously (placeholder), then the async
        // queue paints the engine svg into it.
        await page.waitForSelector(BLOCK, { timeout: 15_000 });
        await page.waitForSelector(`${BLOCK} svg`, { timeout: RENDER_BOUND_MS });

        const measured = await page.evaluate(
            ({ blockSel, loadingSel }) => {
                const block = document.querySelector(blockSel);
                const svg = block?.querySelector('svg') ?? null;
                return {
                    blockCount: document.querySelectorAll(blockSel).length,
                    hasSvg: !!svg,
                    svgTextLen: (svg?.textContent ?? '').trim().length,
                    // A real diagram has geometry; a getBBox=0 environment (jsdom) could not produce this.
                    svgRectCount: svg ? svg.querySelectorAll('rect,path,line,polygon').length : 0,
                    spinnerGone: !block?.querySelector(loadingSel),
                };
            },
            { blockSel: BLOCK, loadingSel: LOADING },
        );

        expect(measured.blockCount).toBe(1);
        expect(measured.hasSvg).toBe(true);
        expect(measured.svgTextLen).toBeGreaterThan(0);
        expect(measured.svgRectCount).toBeGreaterThan(0);
        // The svg replaced the placeholder — no lingering spinner in a successfully rendered block.
        expect(measured.spinnerGone).toBe(true);

        // The rendered diagram is THIS source's diagram (its participant names are in the svg).
        const svgText = await blockSvgText(page);
        expect(svgText).toContain('AlphaOne');
        expect(svgText).toContain('BetaTwo');
    });

    test('AC2: invalid source shows an in-place error affordance, never a perpetual spinner', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 30_000);
        await mount(page);
        await setMarkdown(page, fence(INVALID));

        await page.waitForSelector(BLOCK, { timeout: 15_000 });
        // The placeholder is REPLACED by an error node within the bound — proving the render
        // settled (engine timeout/error path), it did not spin forever.
        await page.waitForSelector(`${BLOCK} ${ERROR}`, { timeout: RENDER_BOUND_MS });

        const measured = await page.evaluate(
            ({ blockSel, loadingSel, errorSel }) => {
                const block = document.querySelector(blockSel);
                return {
                    hasError: !!block?.querySelector(errorSel),
                    errorTextLen: (block?.querySelector(errorSel)?.textContent ?? '').trim().length,
                    spinnerGone: !block?.querySelector(loadingSel),
                    hasSvg: !!block?.querySelector('svg'),
                };
            },
            { blockSel: BLOCK, loadingSel: LOADING, errorSel: ERROR },
        );

        expect(measured.hasError).toBe(true);
        expect(measured.errorTextLen).toBeGreaterThan(0);
        // The definitive anti-perpetual-spinner assertion: the loading placeholder is gone.
        expect(measured.spinnerGone).toBe(true);
        // An invalid diagram must not present a (false) success svg.
        expect(measured.hasSvg).toBe(false);
    });

    test('AC3: two adjacent plantuml blocks render DISTINCT diagrams (serialized queue, per-source key)', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 30_000);
        await mount(page);
        await setMarkdown(page, `${fence(SEQ_ALPHA)}\n\n${fence(SEQ_OTHER)}`);

        await page.waitForFunction(
            (sel) => {
                const blocks = document.querySelectorAll(sel);
                return blocks.length === 2 && [...blocks].every((b) => !!b.querySelector('svg'));
            },
            BLOCK,
            { timeout: RENDER_BOUND_MS },
        );

        const first = await blockSvgText(page, 0);
        const second = await blockSvgText(page, 1);

        // Each block painted ITS OWN source (proves the queue keys per-source and does not
        // cross-contaminate the two adjacent renders).
        expect(first).toContain('AlphaOne');
        expect(first).toContain('BetaTwo');
        expect(first).not.toContain('Manny');

        expect(second).toContain('Manny');
        expect(second).toContain('Olive');
        expect(second).not.toContain('AlphaOne');

        // ...and the two rendered diagrams are genuinely different content.
        expect(first).not.toBe(second);
    });

    test('AC4: rapid streaming edits to the same block end with ONLY the latest source painted', async ({ page }) => {
        // KNOWN PRODUCTION BUG surfaced by this integration proof (openchamber-f9d.16.6 finding).
        // A plantuml block NEVER repaints after its source changes: re-decoration perpetually
        // spins. Root cause: useMorphdomMarkdown re-decorates into a DETACHED `temp` node
        // (decorateMarkdown(temp, ctx) -> decoratePlantuml enqueues against temp's block), then
        // morphdom(el, temp, {childrenOnly}) reuses the LIVE node and discards temp. When the
        // async render resolves, renderQueue.isEligible(tempNode,...) is false (tempNode
        // !isConnected), so the generation guard drops the paint and the live node keeps its
        // placeholder spinner. Mermaid is immune (synchronous render: the svg exists on `temp`
        // BEFORE morphdom copies it into the live node). This also breaks a theme toggle, which
        // re-decorates every block. Fix belongs in decorate.ts/useMorphdomMarkdown (a SEPARATE
        // task) — this is a TEST-ONLY task, production code is untouched.
        //
        // The assertions below encode the CORRECT latest-only backpressure behavior, so this
        // reproduction is expected to FAIL until the pipeline is fixed. When the fix lands the
        // block will settle on the latest source, this test will PASS, Playwright will flag the
        // now-unexpected pass, and THIS test.fail annotation must be removed.
        test.fail(
            true,
            'KNOWN BUG: plantuml block never repaints after a source change (async render dropped by the generation guard because decorate enqueues against the detached morphdom temp node). Fix pending in decorate.ts/useMorphdomMarkdown.',
        );
        test.setTimeout(RENDER_BOUND_MS + 60_000);
        await mount(page);

        // First source renders through fully (engine warmed, block established).
        await setMarkdown(page, fence(SEQ_ALPHA));
        await page.waitForFunction(
            (sel) => (document.querySelectorAll(sel)[0]?.querySelector('svg')?.textContent ?? '').includes('AlphaOne'),
            BLOCK,
            { timeout: RENDER_BOUND_MS },
        );

        // Now fire rapid edits to the SAME block: S2 then S3 back-to-back across two frames, so
        // S2 is still queued/in-flight when S3 supersedes it. Latest-only backpressure must drop
        // the stale S2 (and the already-painted S1) so the FINAL paint is S3 — never a stale win.
        await page.evaluate(
            ({ s2, s3 }) => {
                const md = (src: string) => '```plantuml\n' + src + '\n```';
                window.__plSetMarkdown?.(md(s2));
                // rAF keeps them in distinct render passes (real streaming) but still same window.
                requestAnimationFrame(() => window.__plSetMarkdown?.(md(s3)));
            },
            { s2: SEQ_GAMMA, s3: SEQ_EPSILON },
        );

        // The block must settle on the LATEST source (this is where the bug bites: it never does).
        await page.waitForFunction(
            (sel) => (document.querySelectorAll(sel)[0]?.querySelector('svg')?.textContent ?? '').includes('EpsilonFive'),
            BLOCK,
            { timeout: 25_000 },
        );

        // Give any stale earlier render a chance to (wrongly) win, then assert it did not.
        await page.waitForTimeout(1_500);

        const finalText = await blockSvgText(page);
        expect(finalText).toContain('EpsilonFive');
        expect(finalText).toContain('ZetaSix');
        // The definitive latest-only assertions: no earlier source's diagram survived.
        expect(finalText).not.toContain('AlphaOne');
        expect(finalText).not.toContain('GammaThree');
        // Exactly one block throughout (no duplication from the re-render churn).
        expect(await page.locator(BLOCK).count()).toBe(1);
    });

    test('AC6: no external (off-origin) network requests occur during render (offline proof)', async ({ page }) => {
        test.setTimeout(RENDER_BOUND_MS + 30_000);
        const external = trackExternalRequests(page);
        await mount(page);
        await setMarkdown(page, fence(SEQ_ALPHA));
        await page.waitForSelector(`${BLOCK} svg`, { timeout: RENDER_BOUND_MS });

        // Everything (engine, viz-global, C4 stdlib) is bundled/inlined and served same-origin
        // by the dev server; a real diagram rendered while ZERO requests left the origin.
        expect(external, `unexpected off-origin requests: ${external.join(', ')}`).toEqual([]);
    });
});

/**
 * AC5 is a build-manifest assertion, not a browser render. It proves the ~8.6MB engine stays a
 * lazy async-only chunk in the SHIPPING packages/web production bundle (carved out by f9d.16.5,
 * commit eae5ff0e) — so the baseline bundle is unaffected. `PSystemBuilder` is a unique engine
 * sentinel that only @plantuml/core defines.
 */
test.describe('PlantUML chunk isolation — packages/web production bundle (AC5)', () => {
    const SENTINEL = 'PSystemBuilder';
    const ENTRY_HTML = ['index.html', 'mobile.html', 'mini-chat.html'];
    const PLANTUML_CHUNK_PREFIX = 'vendor-plantuml-core';

    test('the engine sentinel lives ONLY in an async-only chunk, absent from every entry bundle', () => {
        // Reuse f9d.16.5's committed build output. If it is genuinely absent this asserts loudly
        // rather than silently passing — a missing artifact is a real gap, not a green.
        expect(existsSync(webDist), `packages/web/dist missing — build packages/web first (bun run build)`).toBe(true);
        const assetsDir = path.join(webDist, 'assets');
        expect(existsSync(assetsDir), 'packages/web/dist/assets missing').toBe(true);

        // 1. Collect the JS chunks each ENTRY HTML statically references (script src +
        //    modulepreload/link href). Vite modulepreloads the full static-import graph, so this
        //    is the complete set of baseline (non-lazy) chunks.
        const jsRefRe = /(?:src|href)="([^"]+\.js)"/g;
        const staticEntryChunks = new Set<string>();
        for (const htmlName of ENTRY_HTML) {
            const htmlPath = path.join(webDist, htmlName);
            expect(existsSync(htmlPath), `entry ${htmlName} missing in dist`).toBe(true);
            const html = readFileSync(htmlPath, 'utf-8');
            for (let m = jsRefRe.exec(html); m !== null; m = jsRefRe.exec(html)) {
                staticEntryChunks.add(path.basename(m[1]));
            }
        }
        // Sanity: entries really do reference baseline chunks (guards a broken parse yielding
        // a vacuous empty set that would pass everything below).
        expect(staticEntryChunks.size).toBeGreaterThan(0);

        // 2. No entry statically references the plantuml engine chunk.
        const plantumlInEntries = [...staticEntryChunks].filter((c) => c.startsWith(PLANTUML_CHUNK_PREFIX));
        expect(plantumlInEntries, 'engine chunk is statically referenced by an entry HTML').toEqual([]);

        // 3. The engine sentinel appears in EXACTLY ONE chunk, and that chunk is the async-only
        //    vendor-plantuml-core chunk (proves the engine is present AND isolated — not missing).
        const allChunks = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
        const chunksWithSentinel = allChunks.filter((f) =>
            readFileSync(path.join(assetsDir, f), 'utf-8').includes(SENTINEL),
        );
        expect(chunksWithSentinel.length, `sentinel ${SENTINEL} found in ${chunksWithSentinel.length} chunks: ${chunksWithSentinel.join(', ')}`).toBe(1);
        expect(chunksWithSentinel[0].startsWith(PLANTUML_CHUNK_PREFIX)).toBe(true);

        // 4. The sentinel chunk is NOT a baseline chunk (async-only).
        expect(staticEntryChunks.has(chunksWithSentinel[0])).toBe(false);

        // 5. Strongest baseline-clean proof: NONE of the statically-loaded entry chunks contain
        //    the engine sentinel.
        for (const chunk of staticEntryChunks) {
            const chunkPath = path.join(assetsDir, chunk);
            if (!existsSync(chunkPath)) continue;
            const contents = readFileSync(chunkPath, 'utf-8');
            expect(contents.includes(SENTINEL), `baseline chunk ${chunk} contains engine sentinel ${SENTINEL}`).toBe(false);
        }
    });
});
