/**
 * Task C0 (openchamber-f9d.16.1) — BLOCKING PlantUML spike, real-Chromium proof.
 *
 * Drives the standalone harness in packages/ui/spike-plantuml under BOTH `vite dev`
 * (createServer) AND a production `vite build` + `vite preview`, loading each in real
 * Chromium. jsdom is INVALID for @plantuml/core (getBBox returns 0 → mis-sized SVG).
 *
 * Proves:
 *   AC3 loader: viz-global.js (global `Viz`) loads BEFORE plantuml.js and a plantuml
 *       source renders to <svg> in dev AND prod.
 *   AC2 dark:   render(..., {dark:true}) yields a different background than light.
 *   AC2 error:  an invalid source resolves to an error affordance (never a perpetual spinner).
 *   AC4 chunk:  the ~7MB engine lands in a separate async chunk, not the baseline entry.
 *   offline:    no network request leaves localhost (no plantuml.com / CDN fetch).
 *
 * RUN: bunx playwright test --config packages/ui/playwright.config.ts --project=chromium plantumlSpike
 */
import { test, expect, type Page, type Request } from '@playwright/test';
import { createServer, build, preview } from 'vite';
import * as path from 'node:path';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(__dirname, '..', 'spike-plantuml');
const spikeConfig = path.resolve(spikeRoot, 'vite.config.ts');

type SpikeResult = {
    done: boolean;
    vizPresent: boolean;
    engineLoaded: boolean;
    light: { hasSvg: boolean; sig: string };
    dark: { hasSvg: boolean; sig: string };
    darkDiffersLight: boolean;
    rtsLight: { ok: boolean; sig: string; error: string };
    rtsDark: { ok: boolean; sig: string; error: string };
    rtsDarkDiffersLight: boolean;
    rtsAcceptsDarkArg: boolean;
    c4: { hasSvg: boolean; text: string };
    renderErr: { hasSvg: boolean; isError: boolean };
    rtsErr: { ok: boolean; isError: boolean; error: string };
    error?: string;
};

async function collectResult(page: Page): Promise<{ result: SpikeResult; externalRequests: string[] }> {
    const externalRequests: string[] = [];
    page.on('request', (req: Request) => {
        const url = req.url();
        if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url) && /^https?:/.test(url)) {
            externalRequests.push(url);
        }
    });
    await page.waitForFunction(() => (window as unknown as { __spikeResult?: SpikeResult }).__spikeResult?.done === true, {
        timeout: 90_000,
    });
    const result = (await page.evaluate(() => (window as unknown as { __spikeResult: SpikeResult }).__spikeResult)) as SpikeResult;
    console.log('[SPIKE_RESULT]', JSON.stringify(result));
    console.log('[SPIKE_EXTERNAL_REQUESTS]', JSON.stringify(externalRequests));
    return { result, externalRequests };
}

function assertRendered(result: SpikeResult, externalRequests: string[], mode: string): void {
    expect(result.error, `[${mode}] harness error: ${result.error}`).toBeFalsy();
    expect(result.engineLoaded, `[${mode}] engine loaded`).toBe(true);
    expect(result.vizPresent, `[${mode}] window.Viz present (viz-global before plantuml)`).toBe(true);

    // Loader proof: a real SVG rendered from plantuml source.
    expect(result.light.hasSvg, `[${mode}] light render produced svg`).toBe(true);
    expect(result.dark.hasSvg, `[${mode}] dark render produced svg`).toBe(true);
    expect(result.rtsLight.ok, `[${mode}] renderToString light ok`).toBe(true);

    // Dark proof: render({dark:true}) reliably differs from light.
    expect(result.darkDiffersLight, `[${mode}] render() dark sig differs from light`).toBe(true);

    // renderToString dark-path proof (regression guard): fail if renderToString ever reverts to
    // light-only. (a) the 4th {dark} options arg is accepted+honored, (b) the dark call produced
    // an SVG, (c) its palette differs from the light call (dark actually applied, not a no-op).
    expect(result.rtsAcceptsDarkArg, `[${mode}] renderToString honors the 4th {dark} options arg`).toBe(true);
    expect(result.rtsDark.ok, `[${mode}] renderToString dark render produced an SVG`).toBe(true);
    expect(result.rtsDarkDiffersLight, `[${mode}] renderToString dark palette differs from light`).toBe(true);

    // Error affordance: an invalid source resolves (never a perpetual spinner) and is DETECTED
    // as an error. Empirically neither API uses onError for syntax errors — both return an
    // error-diagram SVG, so error detection is content-based (isPlantumlError signature).
    expect(result.renderErr.hasSvg, `[${mode}] render(invalid) resolved (no perpetual spinner)`).toBe(true);
    expect(result.renderErr.isError, `[${mode}] render(invalid) detected as error SVG`).toBe(true);
    expect(result.rtsErr.isError, `[${mode}] renderToString(invalid) detected as error SVG`).toBe(true);

    // C4 stdlib injection resolves from the pre-populated global (offline sprite include).
    expect(result.c4.hasSvg, `[${mode}] C4 diagram rendered from injected stdlib`).toBe(true);

    // Offline: nothing left localhost.
    expect(externalRequests, `[${mode}] no external network requests`).toEqual([]);
}

function assertChunkIsolation(): void {
    const manifestPath = path.resolve(spikeRoot, 'dist', '.vite', 'manifest.json');
    expect(existsSync(manifestPath), 'build manifest exists').toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, { file: string; isEntry?: boolean }>;

    const entry = Object.values(manifest).find((e) => e.isEntry);
    expect(entry, 'entry chunk present in manifest').toBeTruthy();
    const entrySize = statSync(path.resolve(spikeRoot, 'dist', entry!.file)).size;

    const assetsDir = path.resolve(spikeRoot, 'dist', 'assets');
    const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    const sizes = jsFiles.map((f) => ({ f, size: statSync(path.resolve(assetsDir, f)).size }));
    const engineChunk = sizes.find((s) => s.size > 2_000_000);

    // The baseline entry must be tiny; the 7MB engine must be its own async chunk.
    expect(entrySize, `entry chunk must stay small (was ${entrySize})`).toBeLessThan(500_000);
    expect(engineChunk, `a >2MB engine chunk exists: ${JSON.stringify(sizes)}`).toBeTruthy();
    expect(engineChunk!.f, 'engine chunk is NOT the entry chunk').not.toBe(path.basename(entry!.file));
}

test.describe('PlantUML C0 spike — real Chromium loader/dark/error proof', () => {
    test('vite DEV: loads viz-global before plantuml.js and renders SVG', async ({ page }) => {
        test.setTimeout(180_000);
        const server = await createServer({ root: spikeRoot, configFile: spikeConfig, logLevel: 'error' });
        try {
            await server.listen();
            const url = server.resolvedUrls?.local?.[0];
            expect(url, 'dev server url').toBeTruthy();
            await page.goto(url!);
            const { result, externalRequests } = await collectResult(page);
            assertRendered(result, externalRequests, 'dev');
        } finally {
            await server.close();
        }
    });

    test('vite BUILD + PREVIEW: same loader works in prod, engine is a separate chunk', async ({ page }) => {
        test.setTimeout(180_000);
        await build({ root: spikeRoot, configFile: spikeConfig, logLevel: 'error' });
        assertChunkIsolation();
        const previewServer = await preview({ root: spikeRoot, configFile: spikeConfig, logLevel: 'error' });
        try {
            const url = previewServer.resolvedUrls?.local?.[0];
            expect(url, 'preview server url').toBeTruthy();
            await page.goto(url!);
            const { result, externalRequests } = await collectResult(page);
            assertRendered(result, externalRequests, 'prod');
        } finally {
            await new Promise<void>((resolve) => previewServer.httpServer.close(() => resolve()));
        }
    });
});
