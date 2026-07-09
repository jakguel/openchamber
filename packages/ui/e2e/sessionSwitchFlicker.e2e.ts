/**
 * Playwright real-browser regression — Firefox session-switch chat-text flicker (Phase 2b)
 *
 * Story: openchamber-5ki.45  Task: openchamber-5ki.45.17
 * Commit under test: 09cdefa1 (Phase 2b)
 *   - ChatContainer.tsx: removed `key={currentSessionId}` from <ChatViewport>, so the
 *     chat viewport (and the `[data-scrollbar="chat"]` scroll root it renders) reconciles
 *     in place on session switch instead of unmount+remount — the remount was the Firefox
 *     text flash.
 *   - MessageList.tsx: the per-turn expand/collapse map (turnUiStates) reset effect moved
 *     from `[activityRenderMode]` to `[activityRenderMode, sessionKey]`. Because the
 *     viewport no longer remounts, that effect is now the SOLE guard against session A's
 *     expand/collapse state bleeding into session B.
 *
 * WHY a self-contained in-memory-bundled harness (no live server / no agent):
 *   The reviewer requires a COMMITTED, DETERMINISTIC harness that mounts the REAL React
 *   chat render path with NO internal-module mocks. This bundles the REAL modules with
 *   Vite (same technique as streamingScrollPin.e2e.ts) and mounts the REAL default-export
 *   MessageList inside the REAL provider stack (I18n / RuntimeAPI / ThemeSystem / Sync).
 *   ChatViewport is not exported, so MessageList is mounted in ChatViewport's EXACT
 *   structural position — inside a `[data-scrollbar="chat"]` scroll root wrapped by a
 *   "viewport-like" unit that is keyed on the session id ONLY in the negative-control
 *   run, faithfully reproducing the `key={currentSessionId}` React reconciliation the fix
 *   removed. The only injected values are the RuntimeAPIs external-I/O stub and no-op
 *   callback props at the component boundary — no `src/` module is mocked.
 *
 * WHY real Firefox: this is the browser where the flash reproduced. The no-remount
 *   proof is DOM-node identity across the switch (a remount creates a NEW node; a
 *   reconcile reuses it), which only exists in a real layout/paint engine. The suite is
 *   registered under BOTH the chromium and firefox Playwright projects.
 *
 * RUN:
 *   packages/ui/node_modules/.bin/playwright install firefox   # one-time
 *   bunx playwright test --config packages/ui/playwright.config.ts --project=firefox \
 *     sessionSwitchFlicker
 */

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const uiSrc = path.resolve(uiRoot, 'src');

const CHAT_SCROLL = '[data-scrollbar="chat"]';
/** The "+N more..." affordance renders ONLY when the Activity group is collapsed with >7 rows. */
const MORE_BUTTON_RE = /\+\d+ more/;

type SsGlobals = {
    __ssTest: { mount: (container: HTMLElement, opts: { keyed: boolean }) => void };
    __ss: { setSession: (id: string, directory?: string) => void };
};

// The virtual entry mounts the REAL chat subtree with React.createElement (no JSX, so the
// extension-less virtual module compiles under Vite's default loader — mirrors
// streamingScrollPin.e2e.ts). Two sessions ('A' and 'B') carry an assistant turn with the
// SAME turnId 'u1' and >7 `bash` tool parts, so a collapsible "Activity" group renders in
// sorted mode and the colliding turnId makes the no-bleed assertion strict: if the reset
// effect did NOT fire, session A's expanded state would survive into B via the shared id.
const VIRTUAL_ENTRY = [
    "import * as React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { I18nProvider } from '@/lib/i18n';",
    "import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';",
    "import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';",
    "import { SyncProvider } from '@/sync/sync-context';",
    "import MessageList from '@/components/chat/MessageList';",
    "import { useUIStore } from '@/stores/useUIStore';",
    "",
    "const apis = { files: {}, editor: {}, runtime: { isVSCode: false } };",
    "const noopResult = function () { return Promise.resolve({ data: undefined, error: undefined }); };",
    "const sdk = new Proxy({}, { get: function () { return new Proxy(noopResult, { get: function () { return noopResult; } }); } });",
    "const noop = function () {};",
    "",
    "function toolPart(id, tool) { return { id: id, type: 'tool', tool: tool, state: { status: 'completed' } }; }",
    "function textPart(id, text) { return { id: id, type: 'text', text: text }; }",
    "function msg(id, role, parentID, parts, created, finish) {",
    "  var info = { id: id, role: role, sessionID: 'ses', time: { created: created } };",
    "  if (parentID) info.parentID = parentID;",
    "  if (finish) info.finish = finish;",
    "  return { info: info, parts: parts };",
    "}",
    "",
    "// Turn u1: 10 `bash` tool parts (each its own expandable row => >7 rows => a '+N more...'",
    "// collapse affordance) plus a reply text. Turn u2: a trivial trailing turn. Same ids in",
    "// both sessions; only the marker text differs so a completed A->B switch is observable.",
    "function buildSession(marker) {",
    "  var tools = [];",
    "  for (var i = 0; i < 10; i++) { tools.push(toolPart('u1-tool-' + i, 'bash')); }",
    "  var a1Parts = tools.concat([textPart('u1-reply', 'Assistant reply for ' + marker)]);",
    "  var u1 = msg('u1', 'user', undefined, [textPart('u1-text', 'User prompt ' + marker)], 1);",
    "  var a1 = msg('a1', 'assistant', 'u1', a1Parts, 2, 'stop');",
    "  var u2 = msg('u2', 'user', undefined, [textPart('u2-text', 'Follow up ' + marker)], 3);",
    "  var a2 = msg('a2', 'assistant', 'u2', [textPart('u2-reply', 'Trailing reply ' + marker)], 4, 'stop');",
    "  return [u1, a1, u2, a2];",
    "}",
    "const SESSIONS = { A: buildSession('SESSION-A'), B: buildSession('SESSION-B') };",
    "",
    "function ViewportLike(props) {",
    "  // Mirrors ChatViewport's structural role: it renders the `[data-scrollbar=chat]` scroll",
    "  // root that holds MessageList. In the negative-control run the Harness keys THIS unit on",
    "  // the session id (what the fix removed), remounting the scroll root on switch.",
    "  return React.createElement('div', { style: { position: 'relative', flex: 1, minHeight: 0 } },",
    "    React.createElement('div', {",
    "      'data-scrollbar': 'chat',",
    "      'data-testid': 'chat-scroll',",
    "      ref: props.scrollRef,",
    "      style: { position: 'absolute', inset: 0, overflowY: 'auto', height: '420px', background: '#111', color: '#eee', fontSize: '15px', padding: '8px' },",
    "    },",
    "      React.createElement('div', { style: { minHeight: '100%' } },",
    "        React.createElement(MessageList, {",
    "          sessionKey: props.sid,",
    "          messages: props.messages,",
    "          isLoadingOlder: false,",
    "          onMessageContentChange: noop,",
    "          getAnimationHandlers: function () { return { onChunk: noop, onComplete: noop }; },",
    "          scrollToBottom: noop,",
    "          scrollRef: props.scrollRef,",
    "          directory: props.directory,",
    "        })",
    "      )",
    "    )",
    "  );",
    "}",
    "",
    "function Harness(props) {",
    "  var sidState = React.useState('A');",
    "  var sid = sidState[0]; var setSid = sidState[1];",
    "  var dirState = React.useState('/dir-a');",
    "  var dir = dirState[0]; var setDir = dirState[1];",
    "  var scrollRef = React.useRef(null);",
    "  React.useEffect(function () {",
    "    useUIStore.getState().setChatRenderMode('sorted');",
    "    useUIStore.getState().setActivityRenderMode('collapsed');",
    "    window.__ss = {",
    "      setSession: function (id, directory) { setSid(id); if (directory !== undefined) setDir(directory); },",
    "    };",
    "    var host = document.getElementById('host');",
    "    if (host) host.setAttribute('data-ss', 'ready');",
    "  }, []);",
    "  var messages = SESSIONS[sid] || [];",
    "  var viewport = React.createElement(ViewportLike, {",
    "    key: props.keyed ? sid : undefined,",
    "    sid: sid, messages: messages, directory: dir, scrollRef: scrollRef,",
    "  });",
    "  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '480px', width: '640px' } }, viewport);",
    "}",
    "",
    "window.__ssTest = {",
    "  mount: function (container, opts) {",
    "    var tree = React.createElement(I18nProvider, null,",
    "      React.createElement(RuntimeAPIProvider, { apis: apis },",
    "        React.createElement(ThemeSystemProvider, null,",
    "          React.createElement(SyncProvider, { sdk: sdk, directory: '/harness' },",
    "            React.createElement(Harness, { keyed: !!(opts && opts.keyed) })))));",
    "    createRoot(container).render(tree);",
    "  },",
    "};",
].join('\n');

async function bundleHarness(): Promise<string> {
    const virtualId = '\0ss-e2e-entry';
    const result = await build({
        root: uiRoot,
        logLevel: 'error',
        configFile: false,
        resolve: { alias: { '@': uiSrc } },
        define: { 'process.env.NODE_ENV': '"production"' },
        worker: { format: 'es' },
        plugins: [
            {
                name: 'ss-e2e-virtual-entry',
                resolveId(id) {
                    return id === 'ss-e2e-entry' || id.endsWith('ss-e2e-entry') ? virtualId : null;
                },
                load(id) {
                    if (id !== virtualId) return null;
                    return VIRTUAL_ENTRY;
                },
            },
            {
                // Server-only @opencode-ai/sdk utils (spawnSync etc.) sit, unreachable, in the
                // static graph. Node builtins are external I/O — the sanctioned stub boundary —
                // never invoked on the browser chat render path under test.
                name: 'ss-e2e-node-builtin-stub',
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
            lib: { entry: 'ss-e2e-entry', formats: ['es'] },
            rollupOptions: { output: { inlineDynamicImports: true } },
            minify: false,
        },
    });
    const outputs = (Array.isArray(result) ? result[0].output : (result as { output: unknown[] }).output) as Array<{
        type: string;
        code?: string;
    }>;
    const chunk = outputs.find((o) => o.type === 'chunk' && typeof o.code === 'string');
    if (!chunk || !chunk.code) throw new Error('ss-e2e bundle produced no JS chunk');
    return chunk.code;
}

let harnessBundle: Promise<string> | null = null;
function getHarnessBundle(): Promise<string> {
    if (!harnessBundle) harnessBundle = bundleHarness();
    return harnessBundle;
}

async function mountHarness(page: Page, opts: { keyed: boolean }): Promise<void> {
    const bundle = await getHarnessBundle();
    const ORIGIN = 'https://ss-e2e.local';
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
    await page.waitForFunction(() => typeof (window as unknown as SsGlobals).__ssTest !== 'undefined');
    await page.evaluate((o) => {
        const host = document.getElementById('host') as HTMLElement;
        (window as unknown as SsGlobals).__ssTest.mount(host, o);
    }, opts);
    await page.waitForFunction(() => document.getElementById('host')?.getAttribute('data-ss') === 'ready');
    await page.locator(CHAT_SCROLL).first().waitFor({ state: 'visible' });
    // The Activity group header must be present before assertions begin.
    await page.getByRole('button', { name: 'Activity' }).first().waitFor({ state: 'visible' });
}

async function setSession(page: Page, id: string, directory?: string): Promise<void> {
    await page.evaluate(
        ([sid, dir]) => (window as unknown as SsGlobals).__ss.setSession(sid, dir === null ? undefined : (dir as string)),
        [id, directory ?? null] as [string, string | null],
    );
    // Let React commit + effects flush.
    await page.waitForTimeout(150);
}

/** True when the first turn's Activity group is COLLAPSED (its "+N more..." affordance is present). */
async function isCollapsed(page: Page): Promise<boolean> {
    return page.getByText(MORE_BUTTON_RE).first().isVisible().catch(() => false);
}

test.describe('Chat session-switch flicker fix — no remount + turnUiStates no-bleed (Phase 2b)', () => {
    test.describe.configure({ mode: 'serial' });

    test('AC1 — the chat scroll root keeps DOM-node identity across an A->B switch (no remount, no empty frame)', async ({ page }) => {
        await mountHarness(page, { keyed: false });

        // Session A is rendered with its marker.
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();

        // Tag the live scroll-root node + start a per-rAF content-presence sampler BEFORE the
        // switch. A remount replaces the node (tag lost, handle detached) and paints an empty
        // subtree for a frame (the flash); a reconcile keeps the SAME node and never empties.
        const rootHandle = await page.locator(CHAT_SCROLL).first().elementHandle();
        expect(rootHandle).not.toBeNull();
        await page.evaluate(() => {
            const el = document.querySelector('[data-scrollbar="chat"]') as (HTMLElement & { __ssTag?: string }) | null;
            if (el) el.__ssTag = 'persist-node-A';
            const win = window as Window & { __ssMinNodes?: number };
            win.__ssMinNodes = Number.POSITIVE_INFINITY;
            const loop = () => {
                const root = document.querySelector('[data-scrollbar="chat"]');
                const n = root ? root.querySelectorAll('[data-message-id]').length : 0;
                win.__ssMinNodes = Math.min(win.__ssMinNodes ?? Infinity, n);
                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
        });

        await setSession(page, 'B');

        // The switch actually happened: session B's marker is now on screen.
        await expect(page.getByText('User prompt SESSION-B')).toBeVisible();

        // Node identity: the ORIGINAL handle is still connected AND still carries the tag we set
        // — i.e. React reconciled the same node in place; it was not unmounted+remounted.
        const stillConnected = await rootHandle!.evaluate(
            (el: HTMLElement & { __ssTag?: string }) => el.isConnected && el.__ssTag === 'persist-node-A',
        );
        expect(
            stillConnected,
            'REGRESSION: the [data-scrollbar="chat"] node was replaced across the session switch — the ' +
            'viewport remounted (the `key={currentSessionId}` the Phase 2b fix removed is effectively back). ' +
            'This is the Firefox text-flash mechanism.',
        ).toBe(true);

        // No transient empty viewport frame across the switch: message nodes never dropped to 0.
        const minNodes = await page.evaluate(() => (window as Window & { __ssMinNodes?: number }).__ssMinNodes ?? 0);
        expect(
            minNodes,
            `REGRESSION: the chat viewport went empty (0 message nodes) on a frame during the switch — the flicker.`,
        ).toBeGreaterThan(0);

        // Scroll stability for B: sample scrollTop across idle settle frames; an idle (non-streaming)
        // switch must not oscillate.
        const band = await page.evaluate(async () => {
            const el = document.querySelector('[data-scrollbar="chat"]') as HTMLElement | null;
            if (!el) return -1;
            const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
            const samples: number[] = [];
            for (let i = 0; i < 12; i += 1) { samples.push(el.scrollTop); await nextFrame(); }
            return Math.max(...samples) - Math.min(...samples);
        });
        expect(band, `REGRESSION: scrollTop oscillated across idle settle frames after the switch (band=${band}px).`).toBeLessThanOrEqual(1);
    });

    test('AC1 negative control — re-adding key={sessionId} DOES remount the scroll root (assertion is not vacuous)', async ({ page }) => {
        await mountHarness(page, { keyed: true });
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();

        const rootHandle = await page.locator(CHAT_SCROLL).first().elementHandle();
        await page.evaluate(() => {
            const el = document.querySelector('[data-scrollbar="chat"]') as (HTMLElement & { __ssTag?: string }) | null;
            if (el) el.__ssTag = 'persist-node-A';
        });

        await setSession(page, 'B');
        await expect(page.getByText('User prompt SESSION-B')).toBeVisible();

        const stillConnected = await rootHandle!.evaluate(
            (el: HTMLElement & { __ssTag?: string }) => el.isConnected && el.__ssTag === 'persist-node-A',
        );
        expect(
            stillConnected,
            'The keyed negative control did NOT remount — the node-identity assertion in AC1 would be vacuous. ' +
            'Keying the viewport on the session id must replace the scroll-root node.',
        ).toBe(false);
    });

    test('AC2 — expanding session A\'s activity group does NOT bleed into session B, and returning to A is clean', async ({ page }) => {
        await mountHarness(page, { keyed: false });
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();

        // Default is collapsed (activityRenderMode='collapsed'): the "+N more..." affordance shows.
        expect(await isCollapsed(page), 'Session A activity group should start collapsed.').toBe(true);

        // Expand A's activity group via the real toggle button.
        await page.getByRole('button', { name: 'Activity' }).first().click();
        await expect(page.getByText(MORE_BUTTON_RE).first()).toBeHidden();
        expect(await isCollapsed(page), 'Session A activity group should be expanded after the click.').toBe(false);

        // Switch to B. The turnUiStates reset effect (keyed on sessionKey) must fire in the live,
        // NON-remounted MessageList, so B renders at its default collapsed state and does NOT
        // inherit A's expanded state — even though both share turnId 'u1'.
        await setSession(page, 'B');
        await expect(page.getByText('User prompt SESSION-B')).toBeVisible();
        expect(
            await isCollapsed(page),
            'REGRESSION (bleed): session B inherited session A\'s EXPANDED per-turn state. The turnUiStates ' +
            'reset effect did not fire on sessionKey change — the shared turnId carried A\'s state into B.',
        ).toBe(true);

        // Switch back to A. The reset fired again on the switch, so A is back to its default
        // collapsed state (A\'s earlier expand did not survive) — the round trip is clean.
        await setSession(page, 'A');
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();
        expect(
            await isCollapsed(page),
            'REGRESSION: returning to session A did not reset its activity group — the per-turn state ' +
            'persisted across the switch instead of being cleared by the sessionKey reset effect.',
        ).toBe(true);
    });

    test('AC6 — worktree/directory switch + null->next reselect (delete/archive/fork) render without regression', async ({ page }) => {
        await mountHarness(page, { keyed: false });
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();

        const rootHandle = await page.locator(CHAT_SCROLL).first().elementHandle();
        await page.evaluate(() => {
            const el = document.querySelector('[data-scrollbar="chat"]') as (HTMLElement & { __ssTag?: string }) | null;
            if (el) el.__ssTag = 'persist-node-A';
        });

        // Worktree/directory switch: session + directory change together.
        await setSession(page, 'B', '/dir-b');
        await expect(page.getByText('User prompt SESSION-B')).toBeVisible();

        // delete/archive/fork transition the selection through null before a distinct next id.
        await setSession(page, '');
        await expect(page.locator(CHAT_SCROLL).first()).toBeVisible();
        await setSession(page, 'A', '/dir-a');
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();

        // The scroll root survived worktree switch + null->next reselect without a remount.
        const stillConnected = await rootHandle!.evaluate(
            (el: HTMLElement & { __ssTag?: string }) => el.isConnected && el.__ssTag === 'persist-node-A',
        );
        expect(
            stillConnected,
            'REGRESSION: worktree/directory switch or null->next reselect remounted the chat scroll root.',
        ).toBe(true);
    });
});
