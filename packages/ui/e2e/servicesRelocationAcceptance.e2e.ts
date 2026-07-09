/**
 * Playwright real-browser ACCEPTANCE proof for the whole services-relocation change
 * (story openchamber-5ki.48, final task openchamber-5ki.48.17).
 *
 * This is the end-to-end acceptance surface for moving the provider-usage "Services" button
 * out of the top-right Header cluster into the left-nav SidebarFooter, re-anchoring its popup
 * to the viewport's left edge above the trigger, and removing the footer Update button. Every
 * predecessor task (.12-.16) is merged and review-passed; this suite mounts the REAL assembled
 * production components (Header + SidebarFooter/FooterServicesMenu) inside the REAL provider
 * stack and asserts the acceptance behavior. NO src/ module is mocked — the ONLY stubbed thing
 * is the HTTP network boundary via page.route.
 *
 * WHAT IS PROVEN (each assertion fails if the corresponding production wiring regressed):
 *
 *   AC1 (relocation): in the assembled DESKTOP composition, the real top-right Header cluster
 *        renders NO Services button (the services aria-label is absent from the real Header
 *        region), the real left-nav SidebarFooter renders the right-aligned cloud Services
 *        button, and the footer has NO Update button. Non-vacuous: a Services button reappearing
 *        in the Header, the footer trigger vanishing, or the Update button returning each fails.
 *
 *   AC2 (re-anchor geometry): clicking the footer cloud button opens the popup pinned to the
 *        viewport left edge (getBoundingClientRect().left ~0) and ABOVE the trigger
 *        (popup.bottom <= trigger.top). Both are asserted. Non-vacuous: without the leftEdgeAnchor
 *        the popup would anchor near the trigger's own x (~right of the footer), far from 0.
 *
 *   AC3 (shortcut + lazy fetch): starting with the sidebar COLLAPSED (real useUIStore
 *        setSidebarOpen(false)), a REAL window keydown for toggle_services_menu opens the same
 *        popup AND forces the sidebar open (proving the collapsed-survival path ran); and
 *        fetchAllQuotas fires EXACTLY ONCE (one batch, distinct provider URLs) on first open and
 *        NOT again on a cached re-open. Non-vacuous: 0 quota requests before, one batch after, and
 *        no growth on the seeded re-open.
 *
 *   NO-DOUBLE-POLL (deferred here from task .15): with BOTH the real Header AND the real
 *        FooterServicesMenu mounted in a DESKTOP + REMOTE config, the remote update-check endpoint
 *        (/api/openchamber/update-check) is requested by EXACTLY ONE owner — count === 1. If the
 *        Header's old poll had survived .15, a second owner would fire and this count would be 2.
 *
 * WHY a self-contained in-memory-bundled harness (no live server / no agent): identical technique
 * to servicesMenuModelBoundary.e2e.ts (.12), footerServicesMenuBoundary.e2e.ts (.14),
 * footerServicesPlacement.e2e.ts (.15), and sessionSwitchFlicker.e2e.ts — the modules are bundled
 * with Vite (extension-less virtual entry so Vite compiles it; hence React.createElement, no JSX)
 * and mounted with page.addScriptTag. The ONLY injected values are the RuntimeAPIs external-I/O
 * stub and the SyncProvider sdk stub; the Header, SidebarFooter, and FooterServicesMenu under test
 * are the real production code. The runtime surface (web+localhost vs Electron+remote) is chosen
 * purely by window globals + navigation origin set BEFORE mount — never by mocking a src/ module.
 *
 * WHY chromium only: this is store + fetch + DOM-geometry + keyboard behavior, not a
 * browser-engine-specific layout concern, so a single engine is sufficient.
 *
 * RUN:
 *   packages/ui/node_modules/.bin/playwright install chromium   # one-time
 *   packages/ui/node_modules/.bin/playwright test \
 *     --config packages/ui/playwright.config.ts --project=chromium servicesRelocationAcceptance
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const uiSrc = path.resolve(uiRoot, 'src');

const ORIGIN_WEB = 'http://localhost:7319';
const ORIGIN_DESKTOP = 'https://svc-reloc-e2e.local';

// Web (non-Electron) aria-label used by the FooterServicesMenu cloud trigger — see
// packages/ui/src/lib/i18n/messages/en.ts 'header.services.open'.
const SERVICES_WEB_LABEL = 'Open services, usage and MCP';
// The former SidebarFooter Update button aria-label ('sessions.sidebar.footer.actions.update'),
// removed in task .16 — asserting its absence is discriminating (it would match if it returned).
const UPDATE_LABEL = 'Update';
// Default toggle_services_menu combo (packages/ui/src/lib/shortcuts.ts) — asserted for sanity so
// the fired keydown tracks the real shortcut config.
const TOGGLE_SERVICES_COMBO = 'mod+shift+s';

// The virtual entry mounts the REAL assembled composition: the real Header (top-right desktop
// action cluster) in #header-region and the real SidebarFooter (which renders the real
// FooterServicesMenu behind its own !mobileVariant gate) in #footer-region, all inside the REAL
// provider stack (I18n / RuntimeAPI / ThemeSystem / Sync). The real useUIStore / useQuotaStore /
// getEffectiveShortcutCombo are exposed on window so the tests can drive the real stores and read
// the real shortcut config. Nothing in src/ is stubbed.
const VIRTUAL_ENTRY = [
    "import * as React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { I18nProvider } from '@/lib/i18n';",
    "import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';",
    "import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';",
    "import { SyncProvider } from '@/sync/sync-context';",
    "import { Header } from '@/components/layout/Header';",
    "import { SidebarFooter } from '@/components/session/sidebar/SidebarFooter';",
    "import { useUIStore } from '@/stores/useUIStore';",
    "import { useQuotaStore } from '@/stores/useQuotaStore';",
    "import { getEffectiveShortcutCombo } from '@/lib/shortcuts';",
    "",
    "const apis = { files: {}, editor: {}, runtime: { isVSCode: false } };",
    "const noopResult = function () { return Promise.resolve({ data: undefined, error: undefined }); };",
    "const sdk = new Proxy({}, { get: function () { return new Proxy(noopResult, { get: function () { return noopResult; } }); } });",
    "const noop = function () {};",
    "",
    "window.__ui = useUIStore;",
    "window.__quota = useQuotaStore;",
    "window.__combo = function () { return getEffectiveShortcutCombo('toggle_services_menu', useUIStore.getState().shortcutOverrides); };",
    "",
    "window.__acceptanceTest = {",
    "  mount: function (container, layout) {",
    "    var footer = React.createElement('div', { id: 'footer-region' },",
    "      React.createElement(SidebarFooter, { onOpenSettings: noop, onOpenShortcuts: noop, onOpenAbout: noop }));",
    "    var body;",
    "    if (layout === 'footer-bottom') {",
    "      // Footer-only, pinned to the viewport bottom-left via INLINE styles (the harness ships no",
    "      // Tailwind CSS) so there is room ABOVE the trigger for the JS-positioned popup to open with",
    "      // side='top' instead of colliding with the viewport top and flipping below.",
    "      body = React.createElement('div', { id: 'footer-anchor', style: { position: 'fixed', left: '0px', bottom: '0px', width: '320px' } }, footer);",
    "    } else {",
    "      // Assembled: the real Header (top-right desktop action cluster) + the real SidebarFooter",
    "      // (relocated cloud trigger) — proves both sides of the relocation and the single-owner poll.",
    "      body = React.createElement('div', { id: 'app-shell', style: { width: '1280px' } },",
    "        React.createElement('div', { id: 'header-region' }, React.createElement(Header, null)),",
    "        React.createElement('div', { id: 'sidebar-region', style: { width: '320px' } }, footer));",
    "    }",
    "    var tree = React.createElement(I18nProvider, null,",
    "      React.createElement(RuntimeAPIProvider, { apis: apis },",
    "        React.createElement(ThemeSystemProvider, null,",
    "          React.createElement(SyncProvider, { sdk: sdk, directory: '/harness' }, body))));",
    "    createRoot(container).render(tree);",
    "    var host = document.getElementById('host');",
    "    if (host) host.setAttribute('data-acceptance', 'ready');",
    "  },",
    "};",
].join('\n');

async function bundleHarness(): Promise<string> {
    const virtualId = '\0svc-reloc-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        worker: { format: 'es' },
        plugins: [
            {
                name: 'svc-reloc-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'svc-reloc-e2e-entry' || id.endsWith('svc-reloc-e2e-entry') ? virtualId : null;
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
                name: 'svc-reloc-e2e-node-builtin-stub',
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
            lib: { entry: 'svc-reloc-e2e-entry', formats: ['es'] },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('svc-reloc-e2e bundle produced no JS chunk');
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
}

interface HarnessHandle {
    updateCheckRequests: RecordedRequest[];
    quotaRequests: RecordedRequest[];
}

interface HarnessConfig {
    origin: string;
    globals: Record<string, unknown>;
}

const WEB_LOCALHOST: HarnessConfig = {
    origin: ORIGIN_WEB,
    globals: {},
};

// Electron shell pointed at a REMOTE instance — this is the surface that owned the old Header
// Services button and that activates the remote update-check poll. Same globals proven by
// footerServicesMenuBoundary.e2e.ts (task .14) to fire the update-check.
const DESKTOP_REMOTE: HarnessConfig = {
    origin: ORIGIN_DESKTOP,
    globals: {
        __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
        __OPENCHAMBER_API_BASE_URL__: 'https://remote.example',
        __OPENCHAMBER_LOCAL_ORIGIN__: ORIGIN_DESKTOP,
    },
};

/**
 * Register the true-network-boundary stubs (page.route) BEFORE mount, inject the window globals
 * that select the runtime surface, then bundle+inject the real assembled composition and mount it.
 * The ONLY stubbed things are HTTP endpoints; everything else is real production code.
 */
async function mountHarness(page: Page, config: HarnessConfig, layout: 'assembled' | 'footer-bottom'): Promise<HarnessHandle> {
    const bundle = await getHarnessBundle();
    const handle: HarnessHandle = { updateCheckRequests: [], quotaRequests: [] };

    // Lowest priority: swallow any other /api/** so background provider-stack traffic does not hit
    // the real network. Registered FIRST so the specific routes below take precedence.
    await page.route('**/api/**', (route) =>
        route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );

    // Remote update-check endpoint (the single-owner poll under the no-double-poll assertion).
    await page.route('**/api/openchamber/update-check**', (route) => {
        const req = route.request();
        handle.updateCheckRequests.push({ method: req.method(), url: req.url() });
        void route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ available: false, currentVersion: '0.0.0' }),
        });
    });

    // Provider quota-fetch endpoint (the lazy fetch-on-open under AC3).
    await page.route('**/api/quota/**', (route) => {
        const req = route.request();
        handle.quotaRequests.push({ method: req.method(), url: req.url() });
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

    await page.route(`${config.origin}/`, (route) =>
        route.fulfill({
            contentType: 'text/html',
            body:
                `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#host{width:1280px}</style></head>` +
                `<body><div id="host"></div></body></html>`,
        }),
    );

    // Select the runtime surface (web+localhost vs Electron+remote) via window globals set before
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
    await page.waitForFunction(() => typeof (window as unknown as { __acceptanceTest?: unknown }).__acceptanceTest !== 'undefined');
    await page.evaluate((lyt) => {
        const host = document.getElementById('host') as HTMLElement;
        (window as unknown as { __acceptanceTest: { mount: (c: HTMLElement, l: string) => void } }).__acceptanceTest.mount(host, lyt);
    }, layout);
    await page.waitForFunction(() => document.getElementById('host')?.getAttribute('data-acceptance') === 'ready');
    if (layout === 'assembled') {
        // The real Header rendered its DESKTOP action cluster (role="tablist"), and the footer
        // rendered — waiting on both makes the AC1 presence/absence assertions non-vacuous.
        await page.locator('#header-region [role="tablist"]').first().waitFor({ state: 'attached' });
    }
    await page.locator('#footer-region button').first().waitFor({ state: 'attached' });
    return handle;
}

test.describe('services relocation acceptance — real Header + real SidebarFooter (story 5ki.48)', () => {
    test.describe.configure({ mode: 'serial' });

    test('AC1 — no Services button in the real Header cluster; right-aligned cloud Services button in the footer; no footer Update button', async ({ page }) => {
        await mountHarness(page, WEB_LOCALHOST, 'assembled');

        // (relocation, header side) The real top-right Header action cluster renders NO Services
        // button. Scoped to the real Header region so it cannot accidentally match the footer's
        // relocated trigger. Fails if a Services button reappeared in the Header.
        await expect(
            page.locator('#header-region').getByRole('button', { name: SERVICES_WEB_LABEL }),
            'REGRESSION: a Services button reappeared in the top-right Header cluster — relocation undone.',
        ).toHaveCount(0);

        // (relocation, footer side) The real SidebarFooter renders the relocated cloud Services
        // button (web aria-label). Fails if the footer trigger vanished or lost its label.
        const footerServices = page.locator('#footer-region').getByRole('button', { name: SERVICES_WEB_LABEL });
        await expect(
            footerServices,
            'REGRESSION: the relocated cloud Services button is missing from the SidebarFooter.',
        ).toHaveCount(1);
        await expect(footerServices).toBeVisible();

        // (relocation, no Update button) The footer Update button was removed in .16.
        await expect(
            page.locator('#footer-region').getByRole('button', { name: UPDATE_LABEL, exact: true }),
            'REGRESSION: the footer Update button is back — it was removed in task .16.',
        ).toHaveCount(0);

        // (right-aligned) The production SidebarFooter wraps the FooterServicesMenu in a
        // <div className="ml-auto flex items-center"> — ml-auto is what pushes the trigger to the
        // right of the left-aligned runtime buttons. Assert that structural wrapper (the harness
        // ships no Tailwind CSS, so rendered geometry cannot prove this). Fails if ml-auto were dropped.
        const inMlAutoWrapper = await page.evaluate((label) => {
            const footer = document.getElementById('footer-region');
            const btn = footer?.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null;
            if (!footer || !btn) return null;
            let el: HTMLElement | null = btn.parentElement;
            while (el && el !== footer) {
                if (el.classList.contains('ml-auto')) return true;
                el = el.parentElement;
            }
            return false;
        }, SERVICES_WEB_LABEL);
        expect(inMlAutoWrapper, 'expected to locate the footer services button').not.toBeNull();
        expect(
            inMlAutoWrapper,
            'REGRESSION: the Services button is not inside the right-aligned (ml-auto) footer wrapper.',
        ).toBe(true);
    });

    test('AC2 — clicking the footer cloud button opens the popup pinned to the viewport left edge (left ~0) and ABOVE the trigger', async ({ page }) => {
        await mountHarness(page, WEB_LOCALHOST, 'footer-bottom');

        const trigger = page.locator('#footer-region').getByRole('button', { name: SERVICES_WEB_LABEL });
        await trigger.click();

        const popup = page.locator('[data-slot="dropdown-menu-content"]');
        await expect(popup, 'the relocated Services popup should open on click').toBeVisible();

        const geometry = await page.evaluate((label) => {
            const popupEl = document.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement | null;
            const triggerEl = document.querySelector(`#footer-region button[aria-label="${label}"]`) as HTMLElement | null;
            if (!popupEl || !triggerEl) return null;
            const p = popupEl.getBoundingClientRect();
            const t = triggerEl.getBoundingClientRect();
            return { popupLeft: p.left, popupBottom: p.bottom, triggerTop: t.top };
        }, SERVICES_WEB_LABEL);

        expect(geometry, 'expected to measure the popup + trigger rects').not.toBeNull();
        // Pinned to the viewport left edge (x ~ 0). Without the leftEdgeAnchor the popup would
        // anchor near the trigger's own x (right side of the footer), i.e. hundreds of px off.
        expect(
            Math.abs(geometry!.popupLeft),
            `REGRESSION: the popup is not pinned to the viewport left edge (left=${geometry!.popupLeft}px) — leftEdgeAnchor lost.`,
        ).toBeLessThanOrEqual(16);
        // Opens ABOVE the trigger: the popup's bottom edge sits at/above the trigger's top.
        expect(
            geometry!.popupBottom,
            `REGRESSION: the popup did not open above the trigger (popup.bottom=${geometry!.popupBottom} > trigger.top=${geometry!.triggerTop}).`,
        ).toBeLessThanOrEqual(geometry!.triggerTop + 1);
    });

    test('AC3 — the toggle_services_menu shortcut opens the popup from a COLLAPSED sidebar and lazy-fetches quotas exactly once (not on cached re-open)', async ({ page }) => {
        const handle = await mountHarness(page, WEB_LOCALHOST, 'footer-bottom');

        // Sanity: the fired keydown tracks the real shortcut config.
        expect(await page.evaluate(() => (window as unknown as { __combo: () => string }).__combo())).toBe(TOGGLE_SERVICES_COMBO);

        // Start with the sidebar COLLAPSED via the real store.
        await page.evaluate(() => (window as unknown as { __ui: { getState: () => { setSidebarOpen: (v: boolean) => void } } }).__ui.getState().setSidebarOpen(false));
        expect(
            await page.evaluate(() => (window as unknown as { __ui: { getState: () => { isSidebarOpen: boolean } } }).__ui.getState().isSidebarOpen),
            'precondition: the sidebar should start collapsed',
        ).toBe(false);

        // Lazy: no quota fetch before the menu is ever opened.
        expect(
            handle.quotaRequests.length,
            'REGRESSION: a quota fetch fired before the menu was opened — lazy fetch-on-open semantics broken.',
        ).toBe(0);

        // Fire a REAL window keydown for mod+shift+s (meta+ctrl covers mac/non-mac web; the real
        // FooterServicesMenu window-keydown host handles it) — NOT a direct handler call.
        await page.keyboard.press('Control+Shift+KeyS');

        // The same relocated popup opened...
        await expect(
            page.locator('[data-slot="dropdown-menu-content"]'),
            'REGRESSION: the toggle_services_menu shortcut did not open the relocated popup.',
        ).toBeVisible();
        // ...and the shortcut forced the sidebar open (the collapsed-survival path ran).
        expect(
            await page.evaluate(() => (window as unknown as { __ui: { getState: () => { isSidebarOpen: boolean } } }).__ui.getState().isSidebarOpen),
            'REGRESSION: the shortcut did not force the collapsed sidebar open (setSidebarOpen(true) path missing).',
        ).toBe(true);

        // First open lazily fires fetchAllQuotas -> one batch of GET /api/quota/<provider>.
        await expect
            .poll(() => handle.quotaRequests.length, {
                message: 'REGRESSION: opening via shortcut with empty quota did NOT trigger the lazy fetchAllQuotas.',
                timeout: 5000,
            })
            .toBeGreaterThan(0);
        // Let any (regressed) extra batch land before snapshotting the first-open count.
        await page.waitForTimeout(500);
        const afterFirstOpen = handle.quotaRequests.length;
        for (const req of handle.quotaRequests) {
            expect(req.method).toBe('GET');
            expect(req.url).toContain('/api/quota/');
        }
        // Exactly once = a single batch: no provider URL fetched twice.
        const urls = handle.quotaRequests.map((r) => r.url);
        expect(
            new Set(urls).size,
            'REGRESSION: a provider quota URL was fetched more than once on first open — fetchAllQuotas fired more than once.',
        ).toBe(urls.length);

        // Close the menu.
        await page.keyboard.press('Escape');
        await page.locator('[data-slot="dropdown-menu-content"]').waitFor({ state: 'hidden' });

        // Seed the REAL quota store so results is non-empty (deterministic cached state).
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

        // Cached re-open via the shortcut must NOT fetch again.
        await page.keyboard.press('Control+Shift+KeyS');
        await expect(page.locator('[data-slot="dropdown-menu-content"]')).toBeVisible();
        await page.waitForTimeout(750);
        expect(
            handle.quotaRequests.length,
            'REGRESSION: re-opening with a populated quota store re-fetched — the cached-guard (quotaResults.length === 0) was removed.',
        ).toBe(afterFirstOpen);
    });

    test('NO-DOUBLE-POLL — real Header + real FooterServicesMenu (Desktop+remote) poll the remote update-check exactly once (single owner)', async ({ page }) => {
        const handle = await mountHarness(page, DESKTOP_REMOTE, 'assembled');

        // The single remote update-check poll fires ~3s after the instance is detected as remote.
        await expect
            .poll(() => handle.updateCheckRequests.length, {
                message: 'REGRESSION: no GET /api/openchamber/update-check fired — the single remote update-check poll is gone.',
                timeout: 20000,
            })
            .toBeGreaterThan(0);

        // Grace window: a second (regressed) owner — e.g. the Header's old poll — would also fire
        // its ~3s initial poll by now. If the Header still polled, this count would be 2.
        await page.waitForTimeout(3000);
        expect(
            handle.updateCheckRequests.length,
            'REGRESSION: the remote update-check was polled by more than one owner — the Header\'s old poll survived the .15 relocation (double-poll).',
        ).toBe(1);

        // Non-vacuous shape: the surviving single poll is the expected remote update-check call.
        const req = handle.updateCheckRequests[0];
        expect(req.method).toBe('GET');
        expect(req.url).toContain('/api/openchamber/update-check');
        expect(req.url).toContain('appType=web');
        expect(req.url).toContain('instanceMode=remote');
    });
});
