/**
 * Playwright real-browser placement/gating proof — FooterServicesMenu in SidebarFooter
 * (AC1 of openchamber-5ki.48.15).
 *
 * Story: openchamber-5ki.48  Task: openchamber-5ki.48.15  (feature)
 *
 * WHAT IS PROVEN (the REAL SidebarFooter + REAL FooterServicesMenu, real stores, real
 * provider stack; ONLY the true HTTP network boundary is swallowed via page.route — no
 * src/ module is mocked):
 *
 *   (present) Mounting the real SidebarFooter with mobileVariant=false renders the
 *             relocated cloud Services trigger (aria-label "Open services, usage and MCP",
 *             the web/desktop label since the harness runs as a non-Electron web surface).
 *
 *   (absent)  Mounting the SAME real SidebarFooter with mobileVariant=true renders NO
 *             Services trigger — the `!mobileVariant` gate this task added suppresses it
 *             in mobile / VSCode surfaces.
 *
 * Both branches are asserted against the SAME real component, so the suite is non-vacuous:
 * it fails if the gate were removed (button would appear in the mobile branch) or inverted
 * (button would vanish in the desktop branch). To isolate the Services trigger, the footer's
 * other buttons are disabled (showRuntimeButtons=false) so the ONLY possible button is the
 * FooterServicesMenu cloud trigger — presence/absence is unambiguous.
 *
 * Runtime BEHAVIOR of the popup/shortcut/lazy-fetch is intentionally OUT OF SCOPE here and
 * deferred to task openchamber-5ki.48.17 (full acceptance e2e). This suite proves placement
 * and the !mobileVariant gate only.
 *
 * WHY a self-contained in-memory-bundled harness (no live server / no agent): identical
 * technique to footerServicesMenuBoundary.e2e.ts (task .14) and servicesMenuModelBoundary.e2e.ts
 * (task .12) — the modules are bundled with Vite (extension-less virtual entry so Vite compiles
 * it; hence React.createElement, no JSX) and mounted with page.addScriptTag. The ONLY injected
 * values are the RuntimeAPIs external-I/O stub and the SyncProvider sdk stub; the SidebarFooter
 * gate and the FooterServicesMenu it renders are the real production code.
 *
 * WHY chromium only: this is a render-gate/DOM-presence concern, not a browser-engine-specific
 * layout concern, so a single engine is sufficient.
 *
 * RUN:
 *   packages/ui/node_modules/.bin/playwright install chromium   # one-time
 *   packages/ui/node_modules/.bin/playwright test \
 *     --config packages/ui/playwright.config.ts --project=chromium footerServicesPlacement
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const uiSrc = path.resolve(uiRoot, 'src');

const ORIGIN_WEB = 'http://localhost:7318';

// Web (non-Electron) aria-label used by the FooterServicesMenu cloud trigger — see
// packages/ui/src/lib/i18n/messages/en.ts 'header.services.open'.
const SERVICES_BUTTON_LABEL = 'Open services, usage and MCP';

// The virtual entry mounts the REAL SidebarFooter (which internally renders the REAL
// FooterServicesMenu behind its own `!mobileVariant` gate) inside the REAL provider stack
// (I18n / RuntimeAPI / ThemeSystem / Sync). The footer's non-services buttons are disabled so
// the Services cloud trigger is the only button that can appear; the runtime surface is a plain
// web page (no Electron globals) so the web aria-label applies. Nothing in src/ is stubbed.
const VIRTUAL_ENTRY = [
    "import * as React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { I18nProvider } from '@/lib/i18n';",
    "import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';",
    "import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';",
    "import { SyncProvider } from '@/sync/sync-context';",
    "import { SidebarFooter } from '@/components/session/sidebar/SidebarFooter';",
    "",
    "const apis = { files: {}, editor: {}, runtime: { isVSCode: false } };",
    "const noopResult = function () { return Promise.resolve({ data: undefined, error: undefined }); };",
    "const sdk = new Proxy({}, { get: function () { return new Proxy(noopResult, { get: function () { return noopResult; } }); } });",
    "const noop = function () {};",
    "",
    "window.__footerTest = {",
    "  mount: function (container, mobileVariant) {",
    "    var tree = React.createElement(I18nProvider, null,",
    "      React.createElement(RuntimeAPIProvider, { apis: apis },",
    "        React.createElement(ThemeSystemProvider, null,",
    "          React.createElement(SyncProvider, { sdk: sdk, directory: '/harness' },",
    "            React.createElement('div', { id: 'footer-probe' },",
    "              React.createElement(SidebarFooter, {",
    "                onOpenSettings: noop,",
    "                onOpenShortcuts: noop,",
    "                onOpenAbout: noop,",
    "                showRuntimeButtons: false,",
    "                mobileVariant: mobileVariant,",
    "              }))))));",
    "    createRoot(container).render(tree);",
    "    var host = document.getElementById('host');",
    "    if (host) host.setAttribute('data-footer', 'ready');",
    "  },",
    "};",
].join('\n');

async function bundleHarness(): Promise<string> {
    const virtualId = '\0footer-placement-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        worker: { format: 'es' },
        plugins: [
            {
                name: 'footer-placement-virtual-entry',
                resolveId(id) {
                    return id === 'footer-placement-entry' || id.endsWith('footer-placement-entry') ? virtualId : null;
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
                name: 'footer-placement-node-builtin-stub',
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
            lib: { entry: 'footer-placement-entry', formats: ['es'] },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('footer-placement bundle produced no JS chunk');
    return chunk.code;
}

let harnessBundle: Promise<string> | null = null;
function getHarnessBundle(): Promise<string> {
    if (!harnessBundle) harnessBundle = bundleHarness();
    return harnessBundle;
}

/**
 * Swallow all /api/** so the provider stack + FooterServicesMenu network calls never hit the
 * real network, inject the real bundled SidebarFooter, and mount it with the requested
 * mobileVariant. The ONLY stubbed thing is the HTTP boundary; the render path is real code.
 */
async function mountFooter(page: Page, mobileVariant: boolean): Promise<void> {
    const bundle = await getHarnessBundle();

    await page.route('**/api/**', (route) =>
        route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );

    await page.route(`${ORIGIN_WEB}/`, (route) =>
        route.fulfill({
            contentType: 'text/html',
            body:
                `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#host{width:320px}</style></head>` +
                `<body><div id="host"></div></body></html>`,
        }),
    );

    await page.goto(`${ORIGIN_WEB}/`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({
        content:
            "window.process = window.process || { env: { NODE_ENV: 'production' }, platform: 'browser', " +
            "cwd: function () { return '/'; }, nextTick: function (f) { setTimeout(f, 0); } };",
    });
    await page.addScriptTag({ content: bundle, type: 'module' });
    await page.waitForFunction(() => typeof (window as unknown as { __footerTest?: unknown }).__footerTest !== 'undefined');
    await page.evaluate((mv) => {
        const host = document.getElementById('host') as HTMLElement;
        (window as unknown as { __footerTest: { mount: (c: HTMLElement, mv: boolean) => void } }).__footerTest.mount(host, mv);
    }, mobileVariant);
    await page.waitForFunction(() => document.getElementById('host')?.getAttribute('data-footer') === 'ready');
    // The footer container itself must have rendered for the absence assertion to be meaningful.
    await page.locator('#footer-probe').waitFor({ state: 'attached' });
}

test.describe('FooterServicesMenu placement/gating in SidebarFooter (AC1)', () => {
    test.describe.configure({ mode: 'serial' });

    test('mobileVariant=false renders the cloud Services trigger in the footer', async ({ page }) => {
        await mountFooter(page, false);

        const servicesButton = page.getByRole('button', { name: SERVICES_BUTTON_LABEL });
        await expect(
            servicesButton,
            'REGRESSION: SidebarFooter with mobileVariant=false did NOT render the relocated Services cloud trigger.',
        ).toBeVisible();
    });

    test('mobileVariant=true suppresses the Services trigger (mobile/VSCode gate)', async ({ page }) => {
        await mountFooter(page, true);

        const servicesButton = page.getByRole('button', { name: SERVICES_BUTTON_LABEL });
        await expect(
            servicesButton,
            'REGRESSION: SidebarFooter with mobileVariant=true rendered the Services trigger — the !mobileVariant gate is missing or inverted.',
        ).toHaveCount(0);
    });
});
