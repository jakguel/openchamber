/**
 * Playwright real-browser boundary proof — useServicesMenuModel lazy-fetch + display-mode
 * persistence + rate-limit derivation (AC4 of openchamber-5ki.48.12).
 *
 * Story: openchamber-5ki.48  Task: openchamber-5ki.48.12  (refactor)
 * Commit under test: 94ae9f7d — the shared quota/usage derivation was extracted OUT of
 * Header.tsx into the new hook packages/ui/src/components/layout/useServicesMenuModel.tsx.
 * Review passed AC1/AC2/AC3/AC5 and failed ONLY AC4 ("quota lazy-fetch semantics
 * preserved") as a verification-evidence gap: the completion recorded typecheck+lint only,
 * with NO runtime/integration/e2e/manual evidence for the two moved I/O-boundary handlers.
 * This suite is that missing runtime evidence.
 *
 * WHAT IS PROVEN (real hook, real store, real persistence layer; only the true HTTP network
 * boundary is stubbed via page.route — no src/ module is mocked):
 *
 *   (a) handleUsageRefresh() triggers OUTBOUND HTTP to the provider quota-fetch endpoint.
 *       The real call chain is handleUsageRefresh -> useQuotaStore.fetchAllQuotas ->
 *       fetchProviderQuota(providerId) -> runtimeFetch(`/api/quota/${providerId}`) -> HTTP.
 *       Non-vacuous: ZERO /api/quota/** requests fire on mount (the hook does not auto-fetch);
 *       >=1 fire only AFTER the call. If the refactored handler stopped calling fetchAllQuotas,
 *       the post-call count stays 0 and this fails.
 *
 *   (b) handleDisplayModeChange('remaining') persists through updateDesktopSettings AND updates
 *       the real useQuotaStore.displayMode. The real chain is handleDisplayModeChange ->
 *       setQuotaDisplayMode(mode) (synchronous store write) + updateDesktopSettings({ usageDisplayMode })
 *       -> coalesced PUT /api/config/settings -> HTTP. Non-vacuous: the PUT body field
 *       usageDisplayMode is asserted to equal "remaining" (not merely that a request fired), and
 *       the live store displayMode is asserted to flip from its default "usage" to "remaining".
 *
 *   (c) rateLimitGroups (the moved useMemo) derives the expected group shape from seeded
 *       useQuotaStore state. Non-vacuous / discriminating: seeding provider 'claude' with a
 *       'weekly' window yields exactly the group {claude, entries:[['weekly',...]]}; RE-seeding
 *       with a DIFFERENT provider 'codex' + a DIFFERENT window 'monthly' yields a DIFFERENT
 *       observable group ({codex, entries:[['monthly',...]]}) and no longer the claude group —
 *       so the assertion cannot pass against a constant/stale derivation.
 *
 * WHY a self-contained in-memory-bundled harness (no live server / no agent): identical
 * technique to sessionSwitchFlicker.e2e.ts — the modules are bundled with Vite (extension-less
 * virtual entry so Vite's default loader compiles it; hence React.createElement, no JSX), and
 * mounted with page.addScriptTag. The ONLY injected values are the RuntimeAPIs external-I/O stub
 * and the SyncProvider sdk stub; every quota/persistence/derivation code path is the real
 * production code. A TINY probe consumes the real useServicesMenuModel({ isDesktopApp: false })
 * inside the real provider stack (I18n / RuntimeAPI / ThemeSystem / Sync) and exposes the hook's
 * returned handleUsageRefresh / handleDisplayModeChange / rateLimitGroups on window.
 *
 * WHY chromium only: this is store + fetch + persistence behavior, not a browser-engine-specific
 * layout/paint concern, so a single engine is sufficient (unlike the Firefox-specific flicker).
 *
 * RUN:
 *   packages/ui/node_modules/.bin/playwright install chromium   # one-time
 *   bunx playwright test --config packages/ui/playwright.config.ts --project=chromium \
 *     servicesMenuModelBoundary
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const uiSrc = path.resolve(uiRoot, 'src');

const ORIGIN = 'https://svc-e2e.local';

type UsageWindowLike = {
    usedPercent: number | null;
    remainingPercent: number | null;
    windowSeconds: number | null;
    resetAfterSeconds: number | null;
    resetAt: number | null;
    resetAtFormatted: string | null;
    resetAfterFormatted: string | null;
};

type RateLimitGroupLike = {
    providerId: string;
    providerName: string;
    entries: Array<[string, UsageWindowLike]>;
    error?: string;
};

type SvcGlobals = {
    __svc: {
        refresh: () => void;
        setMode: (mode: 'usage' | 'remaining') => Promise<void>;
        getGroups: () => RateLimitGroupLike[];
    };
    __quota: {
        getState: () => { displayMode: 'usage' | 'remaining' };
        setState: (partial: Record<string, unknown>) => void;
    };
};

// The virtual entry mounts a minimal Probe that consumes the REAL useServicesMenuModel inside the
// REAL provider stack and exposes the hook's boundary handlers + derivation via a render-updated
// ref (so every window.__svc call reads the LATEST hook output after each re-render). Seeding is
// done from the test through the real useQuotaStore.setState (the store's own public API).
const VIRTUAL_ENTRY = [
    "import * as React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { I18nProvider } from '@/lib/i18n';",
    "import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';",
    "import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';",
    "import { SyncProvider } from '@/sync/sync-context';",
    "import { useServicesMenuModel } from '@/components/layout/useServicesMenuModel';",
    "import { useQuotaStore } from '@/stores/useQuotaStore';",
    "",
    "const apis = { files: {}, editor: {}, runtime: { isVSCode: false } };",
    "const noopResult = function () { return Promise.resolve({ data: undefined, error: undefined }); };",
    "const sdk = new Proxy({}, { get: function () { return new Proxy(noopResult, { get: function () { return noopResult; } }); } });",
    "",
    "function Probe() {",
    "  // The REAL hook. isDesktopApp:false mirrors the web/mobile surface that owns the mobile menu.",
    "  var model = useServicesMenuModel({ isDesktopApp: false });",
    "  // Keep the latest hook output reachable from window at CALL time (handlers change identity",
    "  // across renders as isUsageRefreshSpinning flips); reading through the ref avoids stale closures.",
    "  var latestRef = React.useRef(model);",
    "  latestRef.current = model;",
    "  React.useLayoutEffect(function () {",
    "    window.__svc = {",
    "      refresh: function () { latestRef.current.handleUsageRefresh(); },",
    "      setMode: function (mode) { return latestRef.current.handleDisplayModeChange(mode); },",
    "      getGroups: function () { return latestRef.current.rateLimitGroups; },",
    "    };",
    "    window.__quota = useQuotaStore;",
    "    var host = document.getElementById('host');",
    "    if (host) host.setAttribute('data-svc', 'ready');",
    "  }, []);",
    "  // A render-time signature of the derived groups lets the test wait for the re-render that",
    "  // a store seed triggers before reading getGroups() (guarantees the memo recomputed).",
    "  var sig = model.rateLimitGroups.map(function (g) {",
    "    return g.providerId + ':' + g.entries.map(function (e) { return e[0]; }).join(',');",
    "  }).join('|');",
    "  return React.createElement('div', { id: 'svc-probe', 'data-sig': sig }, 'ready');",
    "}",
    "",
    "window.__svcTest = {",
    "  mount: function (container) {",
    "    var tree = React.createElement(I18nProvider, null,",
    "      React.createElement(RuntimeAPIProvider, { apis: apis },",
    "        React.createElement(ThemeSystemProvider, null,",
    "          React.createElement(SyncProvider, { sdk: sdk, directory: '/harness' },",
    "            React.createElement(Probe, null)))));",
    "    createRoot(container).render(tree);",
    "  },",
    "};",
].join('\n');

async function bundleHarness(): Promise<string> {
    const virtualId = '\0svc-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        worker: { format: 'es' },
        plugins: [
            {
                name: 'svc-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'svc-e2e-entry' || id.endsWith('svc-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return VIRTUAL_ENTRY;
                },
            },
            {
                // Server-only @opencode-ai/sdk utils (spawnSync etc.) sit, unreachable, in the static
                // graph. Node builtins are external I/O — the sanctioned stub boundary — never invoked
                // on the browser quota/persistence render path under test.
                name: 'svc-e2e-node-builtin-stub',
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
            lib: { entry: 'svc-e2e-entry', formats: ['es'] },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('svc-e2e bundle produced no JS chunk');
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
    settingsRequests: RecordedRequest[];
}

/**
 * Register the true-network-boundary stubs (page.route) BEFORE mount, then bundle+inject the real
 * hook and mount the probe. Returns the request logs the assertions read. The ONLY stubbed thing is
 * HTTP — the quota fetch endpoint, the desktop-settings PUT, and a 404 fallback for any other
 * /api/** the real provider stack happens to touch (e.g. the SyncProvider event stream).
 */
async function mountHarness(page: Page): Promise<HarnessHandle> {
    const bundle = await getHarnessBundle();
    const handle: HarnessHandle = { quotaRequests: [], settingsRequests: [] };

    // Lowest priority: swallow any other /api/** so background provider-stack traffic does not hit
    // the real network. Registered FIRST so the specific routes below take precedence.
    await page.route('**/api/**', (route) =>
        route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );

    // (a) provider quota-fetch endpoint: record every outbound request, fulfill with a minimal valid
    // ProviderResult so fetchProviderQuota resolves cleanly.
    await page.route('**/api/quota/**', (route) => {
        const req = route.request();
        handle.quotaRequests.push({ method: req.method(), url: req.url(), body: req.postData() });
        void route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                providerId: 'stub',
                providerName: 'stub',
                ok: true,
                configured: true,
                usage: { windows: {} },
                fetchedAt: 0,
            }),
        });
    });

    // (b) desktop-settings persistence endpoint: record method + body, fulfill so the coalesced PUT
    // in _flushSettingsUpdate completes.
    await page.route('**/api/config/settings**', (route) => {
        const req = route.request();
        handle.settingsRequests.push({ method: req.method(), url: req.url(), body: req.postData() });
        void route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ usageDisplayMode: 'remaining' }),
        });
    });

    await page.route(`${ORIGIN}/`, (route) =>
        route.fulfill({
            contentType: 'text/html',
            body:
                `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#host{width:640px}</style></head>` +
                `<body><div id="host"></div></body></html>`,
        }),
    );

    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({
        content:
            "window.process = window.process || { env: { NODE_ENV: 'production' }, platform: 'browser', " +
            "cwd: function () { return '/'; }, nextTick: function (f) { setTimeout(f, 0); } };",
    });
    await page.addScriptTag({ content: bundle, type: 'module' });
    await page.waitForFunction(() => typeof (window as unknown as { __svcTest?: unknown }).__svcTest !== 'undefined');
    await page.evaluate(() => {
        const host = document.getElementById('host') as HTMLElement;
        (window as unknown as { __svcTest: { mount: (c: HTMLElement) => void } }).__svcTest.mount(host);
    });
    await page.waitForFunction(() => document.getElementById('host')?.getAttribute('data-svc') === 'ready');
    await page.locator('#svc-probe').waitFor({ state: 'attached' });
    return handle;
}

/** Seed the REAL useQuotaStore via its own setState, then wait for the derived-group signature. */
async function seedQuota(
    page: Page,
    seed: { results: unknown[]; dropdownProviderIds: string[] },
    expectedSig: string,
): Promise<void> {
    await page.evaluate((s) => {
        (window as unknown as SvcGlobals).__quota.setState({
            results: s.results,
            dropdownProviderIds: s.dropdownProviderIds,
        });
    }, seed);
    await page.waitForFunction(
        (sig) => document.getElementById('svc-probe')?.getAttribute('data-sig') === sig,
        expectedSig,
    );
}

function usageWindow(usedPercent: number): UsageWindowLike {
    return {
        usedPercent,
        remainingPercent: usedPercent === null ? null : 100 - usedPercent,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
    };
}

function providerResult(providerId: string, providerName: string, windowKey: string, usedPercent: number) {
    return {
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage: { windows: { [windowKey]: usageWindow(usedPercent) } },
        fetchedAt: 0,
    };
}

test.describe('useServicesMenuModel boundary proof — lazy quota fetch + display-mode persistence + rate-limit derivation (AC4)', () => {
    test.describe.configure({ mode: 'serial' });

    test('(a) handleUsageRefresh triggers an outbound /api/quota fetch — zero before the call, >=1 after (non-vacuous)', async ({ page }) => {
        const handle = await mountHarness(page);

        // The hook does NOT auto-fetch: mounting the real probe must not have hit the quota endpoint.
        expect(
            handle.quotaRequests.length,
            'REGRESSION: a quota fetch fired WITHOUT calling handleUsageRefresh — lazy semantics broken (something auto-fetches on mount).',
        ).toBe(0);

        // Call the REAL hook handler.
        await page.evaluate(() => (window as unknown as SvcGlobals).__svc.refresh());

        // fetchAllQuotas loops every QUOTA_PROVIDERS -> one /api/quota/<id> per provider.
        await expect
            .poll(() => handle.quotaRequests.length, {
                message:
                    'REGRESSION: handleUsageRefresh did NOT trigger any outbound /api/quota request — the moved handler no longer calls fetchAllQuotas.',
                timeout: 5000,
            })
            .toBeGreaterThan(0);

        // Every recorded request is a GET against the provider quota-fetch path (the true boundary).
        for (const req of handle.quotaRequests) {
            expect(req.method).toBe('GET');
            expect(req.url).toContain('/api/quota/');
        }
    });

    test('(b) handleDisplayModeChange("remaining") persists via PUT /api/config/settings (body usageDisplayMode) AND flips the live store', async ({ page }) => {
        const handle = await mountHarness(page);

        // Default display mode is "usage".
        expect(await page.evaluate(() => (window as unknown as SvcGlobals).__quota.getState().displayMode)).toBe('usage');

        await page.evaluate(() => (window as unknown as SvcGlobals).__svc.setMode('remaining'));

        // setQuotaDisplayMode runs synchronously inside the handler before the awaited persist.
        expect(
            await page.evaluate(() => (window as unknown as SvcGlobals).__quota.getState().displayMode),
            'REGRESSION: handleDisplayModeChange did not update useQuotaStore.displayMode.',
        ).toBe('remaining');

        // updateDesktopSettings coalesces into a debounced PUT /api/config/settings.
        await expect
            .poll(() => handle.settingsRequests.filter((r) => r.method === 'PUT').length, {
                message:
                    'REGRESSION: handleDisplayModeChange did NOT persist through updateDesktopSettings — no PUT /api/config/settings fired.',
                timeout: 5000,
            })
            .toBeGreaterThan(0);

        const put = handle.settingsRequests.find((r) => r.method === 'PUT');
        expect(put, 'expected a PUT to /api/config/settings').toBeTruthy();
        expect(put!.url).toContain('/api/config/settings');
        const body = JSON.parse(put!.body ?? '{}') as { usageDisplayMode?: string };
        // Non-vacuous: the persisted body must carry the exact mode the handler was called with.
        expect(
            body.usageDisplayMode,
            'REGRESSION: the persisted settings PUT did not carry usageDisplayMode:"remaining".',
        ).toBe('remaining');
    });

    test('(c) rateLimitGroups derives the seeded provider/window group — and a DIFFERENT seed yields a DIFFERENT group (discriminating)', async ({ page }) => {
        await mountHarness(page);

        // Seed A: provider 'claude' with a 'weekly' window at 42% used.
        await seedQuota(
            page,
            { results: [providerResult('claude', 'Claude', 'weekly', 42)], dropdownProviderIds: ['claude'] },
            'claude:weekly',
        );

        const groupsA = await page.evaluate(() => (window as unknown as SvcGlobals).__svc.getGroups());
        expect(groupsA.length).toBe(1);
        expect(groupsA[0].providerId).toBe('claude');
        expect(groupsA[0].providerName).toBe('Claude');
        expect(groupsA[0].entries.length).toBe(1);
        expect(groupsA[0].entries[0][0]).toBe('weekly');
        expect(groupsA[0].entries[0][1].usedPercent).toBe(42);

        // Seed B: a DIFFERENT provider ('codex') + a DIFFERENT window ('monthly') at 99% used.
        // If the derivation were constant/stale, the observable group would not change.
        await seedQuota(
            page,
            { results: [providerResult('codex', 'Codex', 'monthly', 99)], dropdownProviderIds: ['codex'] },
            'codex:monthly',
        );

        const groupsB = await page.evaluate(() => (window as unknown as SvcGlobals).__svc.getGroups());
        expect(groupsB.length).toBe(1);
        expect(groupsB[0].providerId).toBe('codex');
        expect(groupsB[0].providerName).toBe('Codex');
        expect(groupsB[0].entries[0][0]).toBe('monthly');
        expect(groupsB[0].entries[0][1].usedPercent).toBe(99);
        // The claude group is gone — proving the group set tracks the seeded input, not a constant.
        expect(groupsB.some((g) => g.providerId === 'claude')).toBe(false);
    });
});
