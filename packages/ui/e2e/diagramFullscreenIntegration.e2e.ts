/**
 * Playwright real-browser INTEGRATION verification — Story B task .15.2 (AC1 + AC4).
 *
 * Epic: openchamber-f9d   Story: openchamber-f9d.15   Task: openchamber-f9d.15.2
 *
 * Proves the END-TO-END popup-open path with the REAL production component tree — no mocks:
 *   magnify click
 *     -> decorate.ts toolbar button (data-md-action="mermaid-expand")
 *     -> the REAL useMermaidInlineInteractions hook (inside SimpleMarkdownRenderer)
 *     -> onShowPopup (wired exactly as ChatMessage does: React setState)
 *     -> the REAL ToolOutputDialog -> MermaidPreviewDialog opens
 *   then, INSIDE the opened popup, wheel changes the scale transform and drag translates
 *   within the viewport+100px bound (the DiagramPanZoomViewport running for real).
 *
 * The harness mounts the REAL SimpleMarkdownRenderer + ToolOutputDialog wrapped only in the
 * REAL I18nProvider + RuntimeAPIProvider (the two context providers the components require —
 * theme is optional and falls back). onShowPopup is the genuine ChatMessage state-setter
 * pattern, NOT a mock; the dialog is the real component. ZERO internal mock.module.
 *
 * WHY Playwright (not jsdom): the popup only shows after real layout + real pointer/wheel
 * events, and the pan-bound clamp depends on measured content vs viewport size (jsdom = 0).
 *
 * RUN:
 *   bunx playwright install chromium   # one-time
 *   bunx playwright test --config packages/ui/playwright.config.ts --project=chromium \
 *     diagramFullscreenIntegration
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const uiSrc = path.resolve(uiRoot, 'src');
const indexCssPath = path.resolve(uiSrc, 'index.css');

const MERMAID_MARKDOWN = '```mermaid\ngraph TD\n  A[Start] --> B[Middle]\n  B --> C[End]\n```';

/**
 * Bundle the REAL integrated tree (providers + SimpleMarkdownRenderer + ToolOutputDialog)
 * into an IIFE exposed as window.__intTest. The virtual entry uses React.createElement (no
 * JSX) so the extension-less virtual module compiles under the default JS loader.
 *
 * onShowPopup here is the SAME pattern ChatMessage uses (setState); the dialog is the real
 * component. Nothing under src/ is mocked.
 */
async function bundleIntegration(): Promise<string> {
    const virtualId = '\0int-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [
            {
                // Neutralize `?worker&url` imports: IIFE can't code-split workers, and the
                // mermaid render path is synchronous (beautiful-mermaid) — the Shiki worker is
                // only lazily created for code-block highlighting, which this harness never hits.
                // getWorker() tolerates a bad URL (try/catch -> null), so stubbing is safe.
                name: 'int-e2e-stub-workers',
                enforce: 'pre',
                resolveId(id) {
                    if (id.includes('?worker')) return `\0int-e2e-worker-stub:${id}`;
                    // @opencode-ai/sdk pulls node:child_process (spawnSync) via its process
                    // helper. That code never runs on the mermaid render/popup path; the
                    // browser-external stub lacks the named export, so provide a no-op.
                    if (id === 'node:child_process' || id === 'child_process') return '\0int-e2e-child-process';
                    return null;
                },
                load(id) {
                    if (id.startsWith('\0int-e2e-worker-stub:')) return 'export default "";';
                    if (id === '\0int-e2e-child-process') {
                        return 'export const spawnSync = () => ({ status: 1, error: new Error("stubbed") });\n'
                            + 'export const spawn = () => { throw new Error("stubbed"); };\n'
                            + 'export const execSync = () => { throw new Error("stubbed"); };\n'
                            + 'export default {};';
                    }
                    return null;
                },
            },
            {
                name: 'int-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'int-e2e-entry' || id.endsWith('int-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return [
                        "import * as React from 'react';",
                        "import { createRoot } from 'react-dom/client';",
                        "import { I18nProvider } from '@/lib/i18n';",
                        "import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';",
                        "import { SyncProvider } from '@/sync/sync-context';",
                        "import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRendererImpl';",
                        "import ToolOutputDialog from '@/components/chat/message/ToolOutputDialog';",
                        "",
                        "// Context injection at the app boundaries (as the app does at startup), NOT internal",
                        "// module mocks. RuntimeAPIs: file references are disabled so only files/editor/runtime",
                        "// shape is touched. sdk: no session is active in the harness, so the mermaid render path",
                        "// never issues a real sdk call; a no-op async client satisfies SyncProvider's shape and",
                        "// any background bootstrap resolves harmlessly against the loopback /api stub.",
                        "const apis = { files: {}, editor: {}, runtime: { isVSCode: false } };",
                        "const noopResult = () => Promise.resolve({ data: undefined, error: undefined });",
                        "const sdk = new Proxy({}, { get: () => new Proxy(noopResult, { get: () => noopResult }) });",
                        "",
                        "function Harness(props) {",
                        "  const [popup, setPopup] = React.useState({ open: false, title: '', content: '' });",
                        "  // Exactly ChatMessage's handleShowPopup: open the dialog for image/diagram payloads.",
                        "  const onShowPopup = React.useCallback((content) => {",
                        "    if (content.image || content.diagram) setPopup(content);",
                        "  }, []);",
                        "  const onOpenChange = React.useCallback((open) => setPopup((prev) => ({ ...prev, open })), []);",
                        "  return React.createElement(",
                        "    React.Fragment,",
                        "    null,",
                        "    React.createElement(",
                        "      'div',",
                        "      { style: { fontSize: '15px', width: '760px', padding: '24px' } },",
                        "      React.createElement(SimpleMarkdownRenderer, {",
                        "        content: props.markdown,",
                        "        variant: 'assistant',",
                        "        onShowPopup,",
                        "        enableFileReferences: false,",
                        "      })",
                        "    ),",
                        "    React.createElement(ToolOutputDialog, { popup, onOpenChange, isMobile: false })",
                        "  );",
                        "}",
                        "",
                        "export function mount(container, markdown) {",
                        "  const root = createRoot(container);",
                        "  root.render(",
                        "    React.createElement(",
                        "      I18nProvider,",
                        "      null,",
                        "      React.createElement(",
                        "        RuntimeAPIProvider,",
                        "        { apis },",
                        "        React.createElement(",
                        "          SyncProvider,",
                        "          { sdk: sdk, directory: '' },",
                        "          React.createElement(Harness, { markdown })",
                        "        )",
                        "      )",
                        "    )",
                        "  );",
                        "}",
                    ].join('\n');
                },
            },
        ],
        build: {
            write: false,
            lib: { entry: 'int-e2e-entry', formats: ['iife'], name: '__intTest' },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('int-e2e bundle produced no JS chunk');
    return chunk.code;
}

/** Extract the REAL mermaid CSS (inline block + fullscreen popup) from the shipped index.css. */
function extractMermaidCss(): string {
    const css = readFileSync(indexCssPath, 'utf-8');
    const start = css.indexOf('[data-markdown="mermaid-block"] {');
    if (start === -1) throw new Error('mermaid-block rule not found in index.css');
    const end = css.indexOf('input[data-terminal-hidden-input', start);
    if (end === -1) throw new Error('terminal-input terminator not found after mermaid CSS');
    return css.slice(start, end).trim();
}

/**
 * Serve the harness over a REAL http origin (not page.setContent). An opaque-origin document
 * denies window.localStorage — which several app stores read at module init — and cannot
 * resolve the relative /api/* URLs the app pokes on startup. A loopback server gives a real
 * origin so those touch points behave (localStorage works; background /api/* calls resolve to
 * a benign {} stub instead of throwing "Invalid URL").
 */
let server: http.Server | null = null;
let baseUrl = '';
let bundlePromise: Promise<string> | null = null;
let cssCache: string | null = null;
function getBundle(): Promise<string> {
    if (!bundlePromise) bundlePromise = bundleIntegration();
    return bundlePromise;
}
function getCss(): string {
    if (cssCache == null) cssCache = extractMermaidCss();
    return cssCache;
}

const PROCESS_SHIM = 'window.process = window.process || { env: { NODE_ENV: "production" }, platform: "browser", cwd: function () { return "/"; }, nextTick: function (f) { setTimeout(f, 0); } };';

test.beforeAll(async () => {
    const [bundle, css] = [await getBundle(), getCss()];
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; padding: 0; }
        ${css}
      </style><script>${PROCESS_SHIM}</script></head>
      <body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
    server = http.createServer((req, res) => {
        const url = req.url ?? '/';
        if (url === '/bundle.js') {
            res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
            res.end(bundle);
            return;
        }
        if (url.startsWith('/api/')) {
            // Silence the app's background startup pokes with a benign stub.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/`;
});

test.afterAll(async () => {
    if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
    }
});

async function mountIntegration(page: Page): Promise<void> {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as unknown as { __intTest?: unknown }).__intTest !== 'undefined');
    await page.evaluate(
        (markdown) => {
            const root = document.getElementById('root') as HTMLElement;
            (window as unknown as { __intTest: { mount: (c: HTMLElement, m: string) => void } }).__intTest.mount(root, markdown);
        },
        MERMAID_MARKDOWN,
    );
    // The inline diagram (real decorate.ts) renders its svg + magnify button.
    await page.waitForSelector('#root [data-markdown="mermaid-block"] svg', { timeout: 15_000 });
    await page.waitForSelector('#root [data-md-action="mermaid-expand"]', { timeout: 15_000 });
}

function readPopupTransform(page: Page): Promise<string> {
    return page.evaluate(() => {
        const content = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
        return content?.style.transform ?? '';
    });
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

test.describe('Story B — INTEGRATION: magnify click opens the real popup (AC1/AC4)', () => {
    test('popup is closed until the magnify button is clicked, then it opens', async ({ page }) => {
        await mountIntegration(page);

        // Nothing fullscreen yet — the popup component is not in the DOM.
        expect(await page.locator('[data-diagram-panzoom-content]').count()).toBe(0);

        // Click the REAL magnify button. The toolbar is opacity-0 until hover; dispatch a real
        // click via the element so the production hook's listener fires (force past visibility).
        await page.evaluate(() => {
            const btn = document.querySelector('#root [data-md-action="mermaid-expand"]') as HTMLElement | null;
            btn?.click();
        });

        // The popup opened through the real onShowPopup -> ToolOutputDialog -> MermaidPreviewDialog path.
        await page.waitForSelector('[data-diagram-panzoom-content]', { timeout: 10_000 });
        expect(await page.locator('[data-diagram-panzoom-content]').count()).toBe(1);

        // And the popup actually renders the diagram (real re-render inside the fullscreen dialog).
        await page.waitForSelector('[data-diagram-panzoom-content] [data-markdown="mermaid-block"] svg', { timeout: 10_000 });

        // Initial transform identity.
        const initial = parseTransform(await readPopupTransform(page));
        expect(initial.x).toBe(0);
        expect(initial.y).toBe(0);
        expect(initial.scale).toBe(1);
    });

    test('inside the opened popup: wheel zooms and drag pans within the viewport+100px bound', async ({ page }) => {
        await mountIntegration(page);

        await page.evaluate(() => {
            const btn = document.querySelector('#root [data-md-action="mermaid-expand"]') as HTMLElement | null;
            btn?.click();
        });
        await page.waitForSelector('[data-diagram-panzoom-content] [data-markdown="mermaid-block"] svg', { timeout: 10_000 });

        const box = await page.locator('[data-diagram-panzoom]').boundingBox();
        expect(box).not.toBeNull();
        const cx = box!.x + box!.width / 2;
        const cy = box!.y + box!.height / 2;

        // Wheel up over the popup -> the scale transform grows (real DiagramPanZoomViewport).
        await page.mouse.move(cx, cy);
        await page.mouse.wheel(0, -600);
        await page.waitForFunction(() => {
            const c = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement | null;
            return !!c && Number.parseFloat((c.style.transform.match(/scale\(([\d.]+)\)/) ?? ['', '1'])[1]) > 1;
        });
        const zoomed = parseTransform(await readPopupTransform(page));
        expect(zoomed.scale).toBeGreaterThan(1);

        // Compute the exact expected bound from the REAL measured geometry at the current scale.
        const geometry = await page.evaluate(() => {
            const container = document.querySelector('[data-diagram-panzoom]') as HTMLElement;
            const content = document.querySelector('[data-diagram-panzoom-content]') as HTMLElement;
            const scale = Number.parseFloat((content.style.transform.match(/scale\(([\d.]+)\)/) ?? ['', '1'])[1]);
            const maxX = Math.max(0, (content.offsetWidth * scale - container.clientWidth) / 2) + 100;
            const maxY = Math.max(0, (content.offsetHeight * scale - container.clientHeight) / 2) + 100;
            return { maxX, maxY };
        });

        // Drag far beyond the bound; the offset must clamp, never follow the cursor to +5000.
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 5000, cy + 5000, { steps: 6 });
        await page.mouse.up();

        const dragged = parseTransform(await readPopupTransform(page));
        // Panned in the drag direction...
        expect(dragged.x).toBeGreaterThan(0);
        expect(dragged.y).toBeGreaterThan(0);
        // ...and clamped to the computed viewport+100px bound (transform owns movement, bounded).
        expect(dragged.x).toBeLessThanOrEqual(geometry.maxX + 1);
        expect(dragged.y).toBeLessThanOrEqual(geometry.maxY + 1);
        expect(dragged.x).toBeCloseTo(geometry.maxX, 0);
        expect(dragged.y).toBeCloseTo(geometry.maxY, 0);
    });
});
