import { test, expect, type Page, type Request } from '@playwright/test';
import { createServer } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'plantuml-engine');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');

type SanitizeChecks = {
    blockedScript: boolean;
    blockedForeignObject: boolean;
    strippedRemoteImage: boolean;
    strippedRemoteUse: boolean;
    strippedRemoteUrl: boolean;
    preservedDataSprite: boolean;
    preservedFragmentUrl: boolean;
};

type HarnessResult = {
    done: boolean;
    engineLoaded: boolean;
    vizPresent: boolean;
    vizScriptCount: number;
    singleton: boolean;
    lightSig: string;
    darkSig: string;
    darkDiffersLight: boolean;
    invalidHasSvg: boolean;
    invalidError: string;
    c4HasSvg: boolean;
    c4IsError: boolean;
    stdlibPresent: boolean;
    stdlibScriptCount: number;
    sanitize: SanitizeChecks;
    error?: string;
};

test.describe('PlantUML engine modules — real Chromium (loader/render/error/sanitize/stdlib)', () => {
    test('loads viz-before-plantuml once, renders dark!=light, flags invalid, sanitizes, resolves C4 offline', async ({ page }) => {
        test.setTimeout(180_000);

        const externalRequests: string[] = [];
        const stdlibRequests: string[] = [];
        page.on('request', (req: Request) => {
            const url = req.url();
            if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url) && /^https?:/.test(url)) {
                externalRequests.push(url);
            }
            if (/stdlib|c4|\.min\.js|\.puml|\.spm/i.test(url)) stdlibRequests.push(url);
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
            console.log('[PLANTUML_ENGINE_RESULT]', JSON.stringify(result));
            console.log('[PLANTUML_ENGINE_EXTERNAL_REQUESTS]', JSON.stringify(externalRequests));
            console.log('[PLANTUML_ENGINE_STDLIB_REQUESTS]', JSON.stringify(stdlibRequests));

            expect(result.error, `harness error: ${result.error}`).toBeFalsy();

            // AC1 loader: viz-global present, exactly one script injected, singleton shares one load.
            expect(result.engineLoaded, 'engine loaded').toBe(true);
            expect(result.vizPresent, 'window.Viz present (viz-global before plantuml)').toBe(true);
            expect(result.vizScriptCount, 'exactly one viz-global script (no double-inject)').toBe(1);
            expect(result.singleton, 'concurrent loads share one engine instance').toBe(true);

            // AC2 dark: the {dark:true} 4th options arg is honored — dark palette differs from light.
            expect(result.darkDiffersLight, 'dark SVG palette differs from light').toBe(true);

            // AC3 error affordance: invalid source resolves to {error}, never a spinner, never a diagram.
            expect(result.invalidHasSvg, 'invalid source yields NO svg').toBe(false);
            expect(result.invalidError.length, 'invalid source yields an error message').toBeGreaterThan(0);

            // AC4 sanitize: strips script/foreignObject/remote refs/url() but preserves data sprites + fragment refs.
            expect(result.sanitize.blockedScript, 'sanitize removes <script>').toBe(true);
            expect(result.sanitize.blockedForeignObject, 'sanitize removes <foreignObject>').toBe(true);
            expect(result.sanitize.strippedRemoteImage, 'sanitize strips remote <image> href').toBe(true);
            expect(result.sanitize.strippedRemoteUse, 'sanitize strips remote <use> xlink:href').toBe(true);
            expect(result.sanitize.strippedRemoteUrl, 'sanitize strips remote CSS url()').toBe(true);
            expect(result.sanitize.preservedDataSprite, 'sanitize preserves inline data: sprite imagery').toBe(true);
            expect(result.sanitize.preservedFragmentUrl, 'sanitize preserves same-document url(#fragment)').toBe(true);

            // AC5 stdlib: C4 renders a REAL diagram (not an error diagram) from injected globals,
            // one stdlib script, and ZERO fetches for the lib (no external + no same-origin c4.min.js).
            expect(result.c4HasSvg, 'C4 diagram renders from injected stdlib').toBe(true);
            expect(result.c4IsError, 'C4 render is a real diagram, NOT an error diagram').toBe(false);
            expect(result.stdlibPresent, 'window.PLANTUML_STDLIB_JSON/_INFO populated for C4').toBe(true);
            expect(result.stdlibScriptCount, 'exactly one C4 stdlib script (no double-inject)').toBe(1);
            expect(externalRequests, 'no external network requests during render').toEqual([]);
            const engineLibFetches = stdlibRequests.filter((u) => /\/c4\.min\.js(\?|$)/.test(u) && !/@fs\//.test(u));
            expect(engineLibFetches, 'engine performs ZERO same-origin c4.min.js fetches').toEqual([]);
        } finally {
            await server.close();
        }
    });
});
