/**
 * Playwright real-browser boundary proof — FooterServicesMenu I/O side-effects
 * (AC7 boundary-verification gate of openchamber-5ki.48.14).
 *
 * Story: openchamber-5ki.48  Task: openchamber-5ki.48.14  (feature)
 * Commit that built the component: b3b6ae4b. Review passed AC1-AC6 and failed ONLY
 * AC7 on two concrete issues: (1) three empty `catch { // ignore }` blocks in
 * handleDevShutdown (fixed in the same commit as this suite — replaced with
 * contextual best-effort console.warn logging, control flow unchanged) and
 * (2) the file adds boundary I/O (dev-shutdown / system shutdown runtimeFetch, and
 * forceKillTerminal) with only typecheck/lint evidence. This suite is that missing
 * runtime evidence.
 *
 * WHAT IS PROVEN (the REAL FooterServicesMenu, real stores, real provider stack;
 * ONLY the true HTTP/terminal network boundary is stubbed via page.route — no src/
 * module is mocked):
 *
 *   (b) Invoking the dev-shutdown menu item (web + localhost surface) fires the three
 *       cleanup boundary calls: POST /api/terminal/force-kill (forceKillTerminal),
 *       POST /api/system/dev-shutdown, and — because the stub returns dev-shutdown
 *       non-ok — the fallback POST /api/system/shutdown. Non-vacuous: if the handler
 *       stopped calling any of these boundaries, the corresponding assertion fails.
 *
 *   (c) (reinforces AC4) Opening the menu with an EMPTY useQuotaStore fires the lazy
 *       fetchAllQuotas (>=1 GET /api/quota/<provider>), and re-opening after the store
 *       has results does NOT fetch again. Non-vacuous: zero quota requests before the
 *       first open; >=1 after; and exactly the same count after a cached re-open — so
 *       removing the lazy-fetch OR the cached-guard both fail.
 *
 * WHY a self-contained in-memory-bundled harness (no live server / no agent): identical
 * technique to servicesMenuModelBoundary.e2e.ts (task .12) and sessionSwitchFlicker.e2e.ts
 * — the modules are bundled with Vite (extension-less virtual entry so Vite compiles it;
 * hence React.createElement, no JSX) and mounted with page.addScriptTag. The ONLY injected
 * values are the RuntimeAPIs external-I/O stub and the SyncProvider sdk stub; every
 * quota / desktop-detection / shutdown code path is the real production code. The web+localhost
 * runtime surface is selected purely by window globals + navigation origin set BEFORE mount,
 * never by mocking a src/ module.
 *
 * WHY chromium only: this is store + fetch + DOM-interaction behavior, not a
 * browser-engine-specific layout concern, so a single engine is sufficient.
 *
 * RUN:
 *   packages/ui/node_modules/.bin/playwright install chromium   # one-time
 *   packages/ui/node_modules/.bin/playwright test \
 *     --config packages/ui/playwright.config.ts --project=chromium footerServicesMenuBoundary
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const uiSrc = path.resolve(uiRoot, 'src');

const ORIGIN_WEB = 'http://localhost:7317';

// The virtual entry mounts the REAL FooterServicesMenu inside the REAL provider stack
// (I18n / RuntimeAPI / ThemeSystem / Sync) and exposes the real useQuotaStore on window so
// the cached-reopen test can seed it through the store's own public setState. Nothing about
// the component is stubbed; the runtime surface is chosen entirely by window globals.
const VIRTUAL_ENTRY = [
    "import * as React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { I18nProvider } from '@/lib/i18n';",
    "import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';",
    "import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';",
    "import { SyncProvider } from '@/sync/sync-context';",
    "import { FooterServicesMenu } from '@/components/session/sidebar/FooterServicesMenu';",
    "import { useQuotaStore } from '@/stores/useQuotaStore';",
    "",
    "const apis = { files: {}, editor: {}, runtime: { isVSCode: false } };",
    "const noopResult = function () { return Promise.resolve({ data: undefined, error: undefined }); };",
    "const sdk = new Proxy({}, { get: function () { return new Proxy(noopResult, { get: function () { return noopResult; } }); } });",
    "",
    "window.__quota = useQuotaStore;",
    "",
    "window.__footerTest = {",
    "  mount: function (container) {",
    "    var tree = React.createElement(I18nProvider, null,",
    "      React.createElement(RuntimeAPIProvider, { apis: apis },",
    "        React.createElement(ThemeSystemProvider, null,",
    "          React.createElement(SyncProvider, { sdk: sdk, directory: '/harness' },",
    "            React.createElement('div', { id: 'footer-probe' },",
    "              React.createElement(FooterServicesMenu, null))))));",
    "    createRoot(container).render(tree);",
    "    var host = document.getElementById('host');",
    "    if (host) host.setAttribute('data-footer', 'ready');",
    "  },",
    "};",
].join('\n');

async function bundleHarness(): Promise<string> {
    const virtualId = '\0footer-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        worker: { format: 'es' },
        plugins: [
            {
                name: 'footer-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'footer-e2e-entry' || id.endsWith('footer-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return VIRTUAL_ENTRY;
                },
            },
            {
                // Server-only @opencode-ai/sdk utils (spawnSync etc.) sit, unreachable, in the static
                // graph. Node builtins are external I/O — the sanctioned stub boundary — never invoked
                // on the browser render path under test.
                name: 'footer-e2e-node-builtin-stub',
                enforce: 'pre',
                resolveId(id) {
                    return id.startsWith('node:') ? `\0nodestub:${id}` : null;
                },
                load(id) {
                    if (!id.startsWith('\0nodestub:')) return null;
                    return [
                        "const noop = () => { throw new Error('node builtin unavailable in browser test'); };",
                        "export const spawnSync = noop, spawn = noop, exec = noop, execSync = noop, execFile = noop, execFileSync = noop, fork = noop;",
                        "export const readFileSync = noop, writeFileSync = noop, existsSync = noop, promises = {};",
                        "export const homedir = noop, platform = noop, tmpdir = noop, release = noop, arch = noop, cpus = noop;",
                        "export const join = noop, resolve = noop, dirname = noop, basename = noop, extname = noop, sep = '/';",
                        "export const createHash = noop, randomBytes = noop, randomUUID = noop;",
                        "export default {};",
                    ].join('\n');
                },
            },
        ],
        build: {
            write: false,
            lib: { entry: 'footer-e2e-entry', formats: ['es'] },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('footer-e2e bundle produced no JS chunk');
    return chunk.code;
}

let harnessBundle: Promise<string> | null = null;
function getHarnessBundle(): Promise<string> {
    if (!harnessBundle) harnessBundle = bundleHarness();
    return harnessBundle;
}

interface RecordedRequest {
    method: string;
    url: string;
    body: string | null;
}

interface HarnessHandle {
    quotaRequests: RecordedRequest[];
    forceKillRequests: RecordedRequest[];
    devShutdownRequests: RecordedRequest[];
    shutdownRequests: RecordedRequest[];
}

interface HarnessConfig {
    origin: string;
    globals: Record<string, unknown>;
}

/**
 * Register the true-network-boundary stubs (page.route) BEFORE mount, inject the window
 * globals that select the runtime surface, then bundle+inject the real component and mount it.
 * The ONLY stubbed things are HTTP endpoints; everything else is the real production code.
 */
async function mountHarness(page: Page, config: HarnessConfig): Promise<HarnessHandle> {
    const bundle = await getHarnessBundle();
    const handle: HarnessHandle = {
        quotaRequests: [],
        forceKillRequests: [],
        devShutdownRequests: [],
        shutdownRequests: [],
    };

    const record = (bucket: RecordedRequest[], route: import('@playwright/test').Route, body: string) => {
        const req = route.request();
        bucket.push({ method: req.method(), url: req.url(), body: req.postData() });
        void route.fulfill({ status: 200, contentType: 'application/json', body });
    };

    // Lowest priority: swallow any other /api/** so background provider-stack traffic does not hit
    // the real network. Registered FIRST so the specific routes below take precedence.
    await page.route('**/api/**', (route) =>
        route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );

    // (c) provider quota-fetch endpoint.
    await page.route('**/api/quota/**', (route) =>
        record(
            handle.quotaRequests,
            route,
            JSON.stringify({ providerId: 'stub', providerName: 'stub', ok: true, configured: true, usage: { windows: {} }, fetchedAt: 0 }),
        ),
    );

    // (b) terminal force-kill boundary (forceKillTerminal).
    await page.route('**/api/terminal/force-kill**', (route) => record(handle.forceKillRequests, route, '{}'));

    // (b) dev-shutdown boundary — return NON-ok so the real code falls through to the shutdown fallback.
    await page.route('**/api/system/dev-shutdown**', (route) => {
        const req = route.request();
        handle.devShutdownRequests.push({ method: req.method(), url: req.url(), body: req.postData() });
        void route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });

    // (b) shutdown fallback boundary.
    await page.route('**/api/system/shutdown**', (route) => record(handle.shutdownRequests, route, '{}'));

    await page.route(`${config.origin}/`, (route) =>
        route.fulfill({
            contentType: 'text/html',
            body:
                `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#host{width:640px}</style></head>` +
                `<body><div id="host"></div></body></html>`,
        }),
    );

    // Select the runtime surface (Electron+remote vs web+localhost) via window globals set before
    // any page script runs — this is configuration, not a module mock.
    await page.addInitScript((globals) => {
        for (const [key, value] of Object.entries(globals)) {
            (window as unknown as Record<string, unknown>)[key] = value;
        }
    }, config.globals);

    await page.goto(`${config.origin}/`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({
        content:
            "window.process = window.process || { env: { NODE_ENV: 'production' }, platform: 'browser', " +
            "cwd: function () { return '/'; }, nextTick: function (f) { setTimeout(f, 0); } };",
    });
    await page.addScriptTag({ content: bundle, type: 'module' });
    await page.waitForFunction(() => typeof (window as unknown as { __footerTest?: unknown }).__footerTest !== 'undefined');
    await page.evaluate(() => {
        const host = document.getElementById('host') as HTMLElement;
        (window as unknown as { __footerTest: { mount: (c: HTMLElement) => void } }).__footerTest.mount(host);
    });
    await page.waitForFunction(() => document.getElementById('host')?.getAttribute('data-footer') === 'ready');
    await page.locator('#footer-probe button').first().waitFor({ state: 'attached' });
    return handle;
}

const WEB_LOCALHOST: HarnessConfig = {
    origin: ORIGIN_WEB,
    globals: {},
};

test.describe('FooterServicesMenu boundary proof — dev-shutdown fallback + lazy quota fetch (AC7)', () => {
    test.describe.configure({ mode: 'serial' });

    test('(b) invoking the dev-shutdown item fires force-kill + dev-shutdown + shutdown-fallback boundary calls', async ({ page }) => {
        const handle = await mountHarness(page, WEB_LOCALHOST);

        // None of the shutdown boundaries fire until the item is invoked.
        expect(handle.forceKillRequests.length).toBe(0);
        expect(handle.devShutdownRequests.length).toBe(0);
        expect(handle.shutdownRequests.length).toBe(0);

        // Open the real menu, then invoke the (localhost-only) "Stop OpenChamber" item.
        await page.locator('#footer-probe button').first().click();
        const shutdownItem = page.getByRole('menuitem').first();
        await shutdownItem.waitFor({ state: 'visible' });
        await shutdownItem.click();

        await expect
            .poll(() => handle.forceKillRequests.length, {
                message: 'REGRESSION: dev-shutdown did NOT call forceKillTerminal (POST /api/terminal/force-kill).',
                timeout: 5000,
            })
            .toBeGreaterThan(0);
        expect(handle.forceKillRequests[0].method).toBe('POST');

        await expect
            .poll(() => handle.devShutdownRequests.length, {
                message: 'REGRESSION: dev-shutdown did NOT POST /api/system/dev-shutdown.',
                timeout: 5000,
            })
            .toBeGreaterThan(0);
        expect(handle.devShutdownRequests[0].method).toBe('POST');

        // The stub returned dev-shutdown non-ok, so the real fallback POST /api/system/shutdown must fire.
        await expect
            .poll(() => handle.shutdownRequests.length, {
                message:
                    'REGRESSION: dev-shutdown non-ok did NOT fall through to the POST /api/system/shutdown fallback.',
                timeout: 5000,
            })
            .toBeGreaterThan(0);
        expect(handle.shutdownRequests[0].method).toBe('POST');
    });

    test('(c) opening with empty quota fires lazy fetchAllQuotas; a cached re-open does NOT re-fetch', async ({ page }) => {
        const handle = await mountHarness(page, WEB_LOCALHOST);

        // Lazy: mounting must not have fetched quotas.
        expect(
            handle.quotaRequests.length,
            'REGRESSION: a quota fetch fired WITHOUT opening the menu — lazy fetch-on-open semantics broken.',
        ).toBe(0);

        // First open (usage tab is default on the web surface, quota store empty) -> lazy fetch.
        await page.locator('#footer-probe button').first().click();
        await expect
            .poll(() => handle.quotaRequests.length, {
                message: 'REGRESSION: opening the menu with empty quota did NOT trigger the lazy fetchAllQuotas.',
                timeout: 5000,
            })
            .toBeGreaterThan(0);
        for (const req of handle.quotaRequests) {
            expect(req.method).toBe('GET');
            expect(req.url).toContain('/api/quota/');
        }
        const afterFirstOpen = handle.quotaRequests.length;

        // Close the menu.
        await page.keyboard.press('Escape');
        await page.getByRole('menuitem').first().waitFor({ state: 'detached' });

        // Seed the REAL store so results is non-empty (deterministic cached state) via its own setState.
        await page.evaluate(() => {
            (window as unknown as { __quota: { setState: (p: Record<string, unknown>) => void } }).__quota.setState({
                results: [
                    {
                        providerId: 'claude',
                        providerName: 'Claude',
                        ok: true,
                        configured: true,
                        usage: { windows: { weekly: { usedPercent: 10, remainingPercent: 90, windowSeconds: null, resetAfterSeconds: null, resetAt: null, resetAtFormatted: null, resetAfterFormatted: null } } },
                        fetchedAt: 0,
                    },
                ],
                dropdownProviderIds: ['claude'],
            });
        });

        // Cached re-open must NOT fetch again.
        await page.locator('#footer-probe button').first().click();
        await page.getByRole('menuitem').first().waitFor({ state: 'visible' });
        // Give any (regressed) fetch a chance to fire before asserting no growth.
        await page.waitForTimeout(750);
        expect(
            handle.quotaRequests.length,
            'REGRESSION: re-opening the menu with a populated quota store re-fetched — the cached-guard (quotaResults.length === 0) was removed.',
        ).toBe(afterFirstOpen);
    });
});
