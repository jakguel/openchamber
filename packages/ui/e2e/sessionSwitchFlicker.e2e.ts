/**
 * Playwright real-browser regression — Firefox session-switch chat-text flicker (Phase 3)
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
 * WHY this mounts the REAL exported ChatContainer (Phase 3 rework):
 *   The Phase 2b harness proved no-remount against a test-local `ViewportLike` wrapper and
 *   drove switches via harness-local React state — so it never exercised the production
 *   ChatContainer -> ChatViewport boundary that actually owns the removed
 *   `key={currentSessionId}`, and it would still pass if production re-introduced the key.
 *   This rework mounts the REAL exported <ChatContainer autoOpenDraft={false} readOnly/>
 *   inside the REAL provider stack (I18n / RuntimeAPI / ThemeSystem / Sync), seeds the REAL
 *   per-directory sync child stores that ChatContainer reads, and drives every session
 *   switch through the PRODUCTION action `useSessionUIStore.getState().setCurrentSession`.
 *   The no-remount proof is DOM-node identity of the production `[data-scrollbar="chat"]`
 *   node across the switch: if `key={currentSessionId}` were reintroduced on the real
 *   ChatViewport, that node would be replaced and AC1 would fail. `readOnly` renders the
 *   ReadOnly banner instead of the heavy ChatInput while keeping the real
 *   ChatViewport / MessageList / StatusRowContainer / scroll-root render path intact.
 *
 * NEGATIVE CONTROL (non-vacuous proof): the same REAL ChatContainer is wrapped in an
 *   element keyed on the current session id. Keying the wrapper forces React to remount the
 *   whole ChatContainer subtree on switch — the exact failure mode `key={currentSessionId}`
 *   caused — and the node-identity assertion then observes a DIFFERENT node, proving the
 *   assertion can actually detect a remount.
 *
 * WHY a self-contained in-memory-bundled harness (no live server / no agent): the modules
 *   are bundled with Vite (same technique as streamingScrollPin.e2e.ts) and mounted with
 *   React.createElement (no JSX, so the extension-less virtual entry compiles under Vite's
 *   default loader). The ONLY injected values are the RuntimeAPIs external-I/O stub and the
 *   SyncProvider sdk stub — no `src/` module is mocked; all chat render + session-switch
 *   logic is the real production code.
 *
 * WHY real Firefox: this is the browser where the flash reproduced. Node identity across a
 *   switch (a remount creates a NEW node; a reconcile reuses it) only exists in a real
 *   layout/paint engine. The suite is registered under BOTH the chromium and firefox
 *   Playwright projects.
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
    /** `id === ''` selects null (delete/archive/fork reselect); `dir === ''` clears the directory hint. */
    __ss: { set: (id: string, directory?: string) => void };
};

// The virtual entry mounts the REAL exported ChatContainer inside the REAL provider stack and
// seeds the REAL per-directory sync child stores it reads. Two directories ('/dir-a' holding
// session 'A', '/dir-b' holding session 'B') each carry an assistant turn with >7 `bash` tool
// parts, so a collapsible "Activity" group renders in sorted mode. Session switching goes
// EXCLUSIVELY through the production action useSessionUIStore.getState().setCurrentSession.
const VIRTUAL_ENTRY = [
    "import * as React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { I18nProvider } from '@/lib/i18n';",
    "import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';",
    "import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';",
    "import { SyncProvider, useChildStoreManager } from '@/sync/sync-context';",
    "import { ChatContainer } from '@/components/chat/ChatContainer';",
    "import { useSessionUIStore } from '@/sync/session-ui-store';",
    "import { useUIStore } from '@/stores/useUIStore';",
    "",
    "const apis = { files: {}, editor: {}, runtime: { isVSCode: false } };",
    "const noopResult = function () { return Promise.resolve({ data: undefined, error: undefined }); };",
    "const sdk = new Proxy({}, { get: function () { return new Proxy(noopResult, { get: function () { return noopResult; } }); } });",
    "",
    "function toolPart(id) { return { id: id, type: 'tool', tool: 'bash', state: { status: 'completed' } }; }",
    "function textPart(id, text) { return { id: id, type: 'text', text: text }; }",
    "",
    "// Raw child-store message INFOS (state.message[sessionId]) + a parts map keyed by message id",
    "// (state.part[messageId]). getSessionMaterializationStatus requires every ASSISTANT message to",
    "// have non-empty parts or the session renders as hydrating/empty instead of the chat viewport.",
    "// Turn u1: 10 `bash` tool parts (>7 rows => a '+N more...' collapse affordance) + a reply.",
    "function buildSession(marker, sessionId) {",
    "  var tools = [];",
    "  for (var i = 0; i < 10; i++) { tools.push(toolPart('a1-tool-' + i)); }",
    "  var infos = [",
    "    { id: 'u1', role: 'user', sessionID: sessionId, time: { created: 1 } },",
    "    { id: 'a1', role: 'assistant', sessionID: sessionId, parentID: 'u1', time: { created: 2, completed: 3 }, finish: 'stop' },",
    "    { id: 'u2', role: 'user', sessionID: sessionId, time: { created: 4 } },",
    "    { id: 'a2', role: 'assistant', sessionID: sessionId, parentID: 'u2', time: { created: 5, completed: 6 }, finish: 'stop' },",
    "  ];",
    "  var parts = {};",
    "  parts['u1'] = [textPart('u1-text', 'User prompt ' + marker)];",
    "  parts['a1'] = tools.concat([textPart('a1-reply', 'Assistant reply for ' + marker)]);",
    "  parts['u2'] = [textPart('u2-text', 'Follow up ' + marker)];",
    "  parts['a2'] = [textPart('a2-reply', 'Trailing reply ' + marker)];",
    "  return { infos: infos, parts: parts };",
    "}",
    "",
    "// Seed a REAL per-directory child store (the one ChatContainer's message hooks read via",
    "// useDirectoryStore(directory)). status:'complete' + non-empty parts for every assistant =>",
    "// getSessionMaterializationStatus(...).renderable === true, so fetchMessagesForSession short-",
    "// circuits and never overwrites the seed, and ChatContainer renders the real ChatViewport.",
    "function seedStore(childStores, directory, sessionId, marker) {",
    "  var data = buildSession(marker, sessionId);",
    "  var session = { id: sessionId, title: 'Session ' + sessionId, directory: directory, time: { created: 1, updated: 6 } };",
    "  var store = childStores.ensureChild(directory, { bootstrap: false });",
    "  var msgMap = {}; msgMap[sessionId] = data.infos;",
    "  var statusMap = {}; statusMap[sessionId] = { type: 'idle' };",
    "  store.getState().patch({",
    "    status: 'complete',",
    "    session: [session],",
    "    sessionTotal: 1,",
    "    limit: 50,",
    "    message: msgMap,",
    "    part: data.parts,",
    "    session_status: statusMap,",
    "    permission: {},",
    "    question: {},",
    "  });",
    "}",
    "",
    "function SeededHarness(props) {",
    "  var childStores = useChildStoreManager();",
    "  var seededRef = React.useRef(false);",
    "  var readyState = React.useState(false);",
    "  var ready = readyState[0]; var setReady = readyState[1];",
    "  // Subscribe to the PRODUCTION current session id so the negative-control wrapper re-keys",
    "  // (and thus remounts the real ChatContainer) whenever setCurrentSession changes it.",
    "  var sid = useSessionUIStore(function (s) { return s.currentSessionId; });",
    "  React.useLayoutEffect(function () {",
    "    if (seededRef.current) return;",
    "    seededRef.current = true;",
    "    seedStore(childStores, '/dir-a', 'A', 'SESSION-A');",
    "    seedStore(childStores, '/dir-b', 'B', 'SESSION-B');",
    "    useUIStore.getState().setChatRenderMode('sorted');",
    "    useUIStore.getState().setActivityRenderMode('collapsed');",
    "    window.__ss = {",
    "      set: function (id, directory) {",
    "        var nextId = id === '' ? null : id;",
    "        var nextDir = directory === undefined ? undefined : (directory === '' ? null : directory);",
    "        useSessionUIStore.getState().setCurrentSession(nextId, nextDir);",
    "      },",
    "    };",
    "    // Establish session A through the production action too (not harness-local React state).",
    "    useSessionUIStore.getState().setCurrentSession('A', '/dir-a');",
    "    var host = document.getElementById('host');",
    "    if (host) host.setAttribute('data-ss', 'ready');",
    "    setReady(true);",
    "  }, []);",
    "  if (!ready) return React.createElement('div', { style: { height: '480px' } });",
    "  return React.createElement('div', {",
    "    // Negative control: keying the wrapper on the session id remounts the whole real",
    "    // ChatContainer subtree on switch (the failure mode key={currentSessionId} caused).",
    "    key: props.keyed ? ('k-' + (sid || 'none')) : 'stable',",
    "    style: { display: 'flex', flexDirection: 'column', height: '480px', width: '640px' },",
    "  }, React.createElement(ChatContainer, { autoOpenDraft: false, readOnly: true }));",
    "}",
    "",
    "window.__ssTest = {",
    "  mount: function (container, opts) {",
    "    var tree = React.createElement(I18nProvider, null,",
    "      React.createElement(RuntimeAPIProvider, { apis: apis },",
    "        React.createElement(ThemeSystemProvider, null,",
    "          React.createElement(SyncProvider, { sdk: sdk, directory: '/harness' },",
    "            React.createElement(SeededHarness, { keyed: !!(opts && opts.keyed) })))));",
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

/** Drive a session switch through the PRODUCTION action useSessionUIStore.setCurrentSession. */
async function setSession(page: Page, id: string, directory?: string): Promise<void> {
    await page.evaluate(
        ([sid, dir]) => (window as unknown as SsGlobals).__ss.set(sid, dir === null ? undefined : (dir as string)),
        [id, directory ?? null] as [string, string | null],
    );
    // Let React commit + effects flush.
    await page.waitForTimeout(150);
}

/** True when the first turn's Activity group is COLLAPSED (its "+N more..." affordance is present). */
async function isCollapsed(page: Page): Promise<boolean> {
    return page.getByText(MORE_BUTTON_RE).first().isVisible().catch(() => false);
}

test.describe('Chat session-switch flicker fix — real ChatContainer, no remount + turnUiStates no-bleed (Phase 3)', () => {
    test.describe.configure({ mode: 'serial' });

    test('AC1 — the production chat scroll root keeps DOM-node identity across an A->B switch (no remount, no empty frame)', async ({ page }) => {
        await mountHarness(page, { keyed: false });

        // Session A is rendered by the REAL ChatContainer.
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();

        // Tag the live production scroll-root node + start a per-rAF content-presence sampler
        // BEFORE the switch. A remount replaces the node (tag lost, handle detached) and paints an
        // empty subtree for a frame (the flash); a reconcile keeps the SAME node and never empties.
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

        // Switch A->B through the PRODUCTION action setCurrentSession(id, directory).
        await setSession(page, 'B', '/dir-b');

        // The switch actually happened: session B's marker is now on screen.
        await expect(page.getByText('User prompt SESSION-B')).toBeVisible();

        // Node identity: the ORIGINAL handle is still connected AND still carries the tag we set
        // — i.e. the real ChatViewport reconciled the same node in place; it was not
        // unmounted+remounted. Reintroducing key={currentSessionId} on the real ChatViewport
        // would replace this node and fail here.
        const stillConnected = await rootHandle!.evaluate(
            (el: HTMLElement & { __ssTag?: string }) => el.isConnected && el.__ssTag === 'persist-node-A',
        );
        expect(
            stillConnected,
            'REGRESSION: the production [data-scrollbar="chat"] node was replaced across the session ' +
            'switch — the ChatViewport remounted (the `key={currentSessionId}` the Phase 2b fix removed ' +
            'is effectively back). This is the Firefox text-flash mechanism.',
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

    test('AC1 negative control — keying the real ChatContainer on the session id DOES remount the scroll root (assertion is not vacuous)', async ({ page }) => {
        await mountHarness(page, { keyed: true });
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();

        const rootHandle = await page.locator(CHAT_SCROLL).first().elementHandle();
        await page.evaluate(() => {
            const el = document.querySelector('[data-scrollbar="chat"]') as (HTMLElement & { __ssTag?: string }) | null;
            if (el) el.__ssTag = 'persist-node-A';
        });

        await setSession(page, 'B', '/dir-b');
        await expect(page.getByText('User prompt SESSION-B')).toBeVisible();

        const stillConnected = await rootHandle!.evaluate(
            (el: HTMLElement & { __ssTag?: string }) => el.isConnected && el.__ssTag === 'persist-node-A',
        );
        expect(
            stillConnected,
            'The keyed negative control did NOT remount — the node-identity assertion in AC1 would be vacuous. ' +
            'Keying the ChatContainer subtree on the session id must replace the scroll-root node.',
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

        // Switch to B via the production action. The turnUiStates reset effect (keyed on sessionKey)
        // must fire in the live, NON-remounted MessageList, so B renders at its default collapsed
        // state and does NOT inherit A's expanded state — even though both share turnId 'u1'.
        await setSession(page, 'B', '/dir-b');
        await expect(page.getByText('User prompt SESSION-B')).toBeVisible();
        expect(
            await isCollapsed(page),
            'REGRESSION (bleed): session B inherited session A\'s EXPANDED per-turn state. The turnUiStates ' +
            'reset effect did not fire on sessionKey change — the shared turnId carried A\'s state into B.',
        ).toBe(true);

        // Switch back to A. The reset fired again on the switch, so A is back to its default
        // collapsed state (A\'s earlier expand did not survive) — the round trip is clean.
        await setSession(page, 'A', '/dir-a');
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();
        expect(
            await isCollapsed(page),
            'REGRESSION: returning to session A did not reset its activity group — the per-turn state ' +
            'persisted across the switch instead of being cleared by the sessionKey reset effect.',
        ).toBe(true);
    });

    test('AC6 — worktree/directory switch + null->next reselect (delete/archive/fork) via production setCurrentSession render without regression', async ({ page }) => {
        await mountHarness(page, { keyed: false });
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();

        // Worktree/directory switch: session + directory change together, through setCurrentSession.
        await setSession(page, 'B', '/dir-b');
        await expect(page.getByText('User prompt SESSION-B')).toBeVisible();

        // delete/archive/fork transition the selection through null before a distinct next id.
        // setCurrentSession(null) is the real production reselect path: ChatContainer drops to the
        // empty state (no chat scroll root), then the next reselect must render cleanly.
        await setSession(page, '');
        await expect(page.locator(CHAT_SCROLL)).toHaveCount(0);

        await setSession(page, 'A', '/dir-a');
        await expect(page.getByText('User prompt SESSION-A')).toBeVisible();
        await expect(page.locator(CHAT_SCROLL).first()).toBeVisible();

        // No transient empty frame on the reselect: the reselected session's messages are present.
        const nodeCount = await page.evaluate(() => {
            const root = document.querySelector('[data-scrollbar="chat"]');
            return root ? root.querySelectorAll('[data-message-id]').length : 0;
        });
        expect(
            nodeCount,
            'REGRESSION: null->next reselect (delete/archive/fork path) rendered an empty chat viewport.',
        ).toBeGreaterThan(0);
    });
});
