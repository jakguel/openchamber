/**
 * Story openchamber-5ki.44 (T6, openchamber-5ki.44.13) — real-renderer END-TO-END proof.
 *
 * Ties T1..T5 together through the REAL @plantuml/core engine + the real production error-surfacing
 * path (renderPlantuml -> extractPlantumlError wiring from T4), the real render queue (5-min
 * negative cache) and the real cache-key builder. NO internal src/ mocks and NO fabricated engine
 * SVG: the harness (fixtures/plantuml-error-surface) imports the production modules unchanged and
 * runs them in real Chromium, because @plantuml/core needs a browser (canvas/getBBox) and the
 * extractor's DOMParser boundary is browser-only — a plain bun:test cannot invoke either.
 *
 * Under proof:
 *   AC-T6a  invalid snippet surfaces the engine's EXACT offending token `diamond "some label" as X`
 *           on line 3 (asserts the SPECIFIC substring — a regression to the generic constant FAILS,
 *           because 'Invalid PlantUML diagram source' does not contain that token or "line 3").
 *   AC-T6b  a valid snippet renders a real <svg>.
 *   AC-T6c  editing the source to a valid diagram re-renders (NEW cache key) — NOT the stale
 *           negative-cached error; the negative cache is proven active (same key is not re-rendered).
 *   AC-T6d  a no-citation / malformed / drift input falls back to 'Invalid PlantUML diagram source'
 *           with no throw and no svg.
 *
 * RUN:
 *   packages/ui/node_modules/.bin/playwright test \
 *     --config packages/ui/playwright.config.ts --project=chromium plantumlErrorSurface --workers=1
 */
import { test, expect, type Request } from '@playwright/test';
import { createServer } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'plantuml-error-surface');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');

const OFFENDING_TOKEN = 'diamond "some label" as X';
const FALLBACK_CONSTANT = 'Invalid PlantUML diagram source';

type DriftProbe = {
    id: string;
    error: string;
    hasSvg: boolean;
    threw: boolean;
    isFallback: boolean;
};

type HarnessResult = {
    done: boolean;
    invalidError: string;
    invalidHasSvg: boolean;
    validHasSvg: boolean;
    validIsSvg: boolean;
    negFirstError: string;
    negCachedError: string;
    correctedHasSvg: boolean;
    correctedError: string;
    correctedKeyDiffers: boolean;
    callsAfterFirst: number;
    callsAfterCached: number;
    callsAfterCorrected: number;
    drift: DriftProbe[];
    driftFallbackId: string;
    driftFallbackError: string;
    driftFallbackHasSvg: boolean;
    driftFallbackThrew: boolean;
    error?: string;
};

test.describe('PlantUML error surfacing — real engine end-to-end (line/token, valid render, negative cache, fallback)', () => {
    test('invalid→exact token/line, valid→svg, corrected→re-render, drift→constant', async ({ page }) => {
        test.setTimeout(180_000);

        // Offline guard: nothing must leave localhost during the real render.
        const externalRequests: string[] = [];
        page.on('request', (req: Request) => {
            const url = req.url();
            if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url) && /^https?:/.test(url)) {
                externalRequests.push(url);
            }
        });

        const server = await createServer({ root: fixtureRoot, configFile: fixtureConfig, logLevel: 'error' });
        try {
            await server.listen();
            const url = server.resolvedUrls?.local?.[0];
            expect(url, 'dev server url').toBeTruthy();
            await page.goto(url!);

            await page.waitForFunction(
                () => (window as unknown as { __result?: HarnessResult }).__result?.done === true,
                { timeout: 120_000 },
            );
            const result = (await page.evaluate(
                () => (window as unknown as { __result: HarnessResult }).__result,
            )) as HarnessResult;
            console.log('[PLANTUML_ERROR_SURFACE_RESULT]', JSON.stringify(result));
            console.log('[PLANTUML_ERROR_SURFACE_EXTERNAL_REQUESTS]', JSON.stringify(externalRequests));

            expect(result.error, `harness error: ${result.error}`).toBeFalsy();

            // AC-T6a — the surfaced detail carries the engine's EXACT offending token AND line 3.
            // Asserting the SPECIFIC substrings (not merely non-empty): a regression to the generic
            // constant would drop both and fail here.
            expect(result.invalidHasSvg, 'invalid snippet yields NO svg (error affordance)').toBe(false);
            expect(result.invalidError, 'invalid detail must contain the exact offending token').toContain(OFFENDING_TOKEN);
            expect(result.invalidError, 'invalid detail must cite line 3 (no-theme)').toContain('line 3');
            expect(result.invalidError, 'invalid detail must NOT be the generic fallback constant').not.toBe(FALLBACK_CONSTANT);

            // AC-T6b — a valid snippet renders a real <svg>.
            expect(result.validHasSvg, 'valid snippet renders an svg').toBe(true);
            expect(result.validIsSvg, 'valid render is real <svg> markup').toBe(true);

            // AC-T6c — corrected source re-renders past the negative cache (new cache key).
            expect(result.correctedKeyDiffers, 'edited source yields a different cache key').toBe(true);
            expect(result.negFirstError, 'first invalid render surfaces the exact token').toContain(OFFENDING_TOKEN);
            expect(result.negCachedError, 'repeat of the same key is served from the negative cache (same error)').toBe(
                result.negFirstError,
            );
            expect(result.callsAfterFirst, 'first invalid enqueue runs exactly one real render').toBe(1);
            expect(result.callsAfterCached, 'same-key repeat does NOT re-render (negative cache active)').toBe(1);
            expect(result.callsAfterCorrected, 'corrected source (new key) runs a fresh real render').toBe(2);
            expect(result.correctedHasSvg, 'corrected source re-renders to an svg, NOT the cached error').toBe(true);
            expect(result.correctedError, 'corrected source carries no error').toBe('');

            // AC-T6d — a no-citation / malformed / drift input falls back to the constant, no throw.
            expect(
                result.driftFallbackId,
                `at least one drift candidate must fall back to the constant. Probes: ${JSON.stringify(result.drift)}`,
            ).not.toBe('');
            expect(result.driftFallbackError, 'drift fallback surfaces the generic constant').toBe(FALLBACK_CONSTANT);
            expect(result.driftFallbackThrew, 'drift fallback must NOT throw').toBe(false);
            expect(result.driftFallbackHasSvg, 'drift fallback yields no svg').toBe(false);

            // Offline: the real render never left localhost.
            expect(externalRequests, 'no external network requests during real render').toEqual([]);
        } finally {
            await server.close();
        }
    });
});
