/**
 * Playwright real-Chromium proof — task openchamber-5ki.61.1 (usePacedText mount-seed).
 *
 * Epic: openchamber-5ki   Story: openchamber-5ki.61   Task: openchamber-5ki.61.1
 *
 * Under test: the REAL usePacedText hook inside the REAL chat MarkdownRenderer. The bug:
 * seeding the reveal counter at 0 on every streaming mount re-typed the entire existing
 * assistant text when switching back into a still-streaming session. The fix seeds the
 * counter to content.length so only text arriving AFTER mount is paced.
 *
 * WHY e2e (not a bun unit test): packages/ui ships no jsdom/RTL/react-test-renderer, and the
 * hook's paced tick is browser-gated (`typeof window === 'undefined'` bails to full content),
 * so the paced reveal literally cannot run under bun/Node. Under real Vite + Chromium the
 * effect's 64ms timers run for real. The fixture (fixtures/paced-text) mounts the genuine
 * MarkdownRenderer with app-boundary providers only — NOTHING under src/ is mocked. Every
 * assertion observes the rendered DOM text produced by the real hook, so a regression in the
 * hook (seed back to 0, tick replaced by an immediate full reveal, timer scheduling removed,
 * or the streaming gate ignored) makes a specific assertion fail. This was cross-checked: with
 * the seed reverted to `streaming ? 0` cases (a) and the true->false negative go RED.
 *
 * RUN (workspace-local runner — do NOT use bunx playwright, it pulls a mismatched runner):
 *   packages/ui/node_modules/.bin/playwright test --config playwright.config.ts \
 *     --project=chromium pacedText
 */

import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, 'fixtures', 'paced-text');
const fixtureConfig = path.resolve(fixtureRoot, 'vite.config.ts');

declare global {
    interface Window {
        __ready?: boolean;
        __setContent?: (s: string) => void;
        __setStreaming?: (b: boolean) => void;
        __setDisableAnim?: (b: boolean) => void;
        __setMounted?: (b: boolean) => void;
        __remountWith?: (content: string, streaming: boolean) => void;
    }
}

const TEXT_SEL = '#root [data-markdown-content]';

// A long, markdown-inert single paragraph (plain words only — nothing marked would
// interpret as a heading/list/emphasis). It is long enough that a from-0 reveal at the
// production 64ms cadence takes multiple seconds, so "full within ~1.5s" cleanly separates
// the seeded-full mount (fix) from a from-0 replay (bug).
const LONG = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
    + 'incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud ')
    .repeat(6)
    .trim();
const SHORT = 'lorem ipsum dolor';

let server: ViteDevServer | null = null;
let baseUrl = '';

test.beforeAll(async () => {
    server = await createServer({ root: fixtureRoot, configFile: fixtureConfig, logLevel: 'error' });
    await server.listen();
    const url = server.resolvedUrls?.local?.[0];
    if (!url) throw new Error('vite dev server produced no local url');
    baseUrl = url;
});

test.afterAll(async () => {
    if (server) {
        await server.close();
        server = null;
    }
});

async function mount(page: Page): Promise<void> {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true, { timeout: 20_000 });
}

function readText(page: Page): Promise<string> {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? (el.textContent ?? '').trim() : '';
    }, TEXT_SEL);
}

async function waitForText(page: Page, expected: string, timeout: number): Promise<void> {
    await page.waitForFunction(
        ({ sel, want }) => {
            const el = document.querySelector(sel);
            return !!el && (el.textContent ?? '').trim() === want;
        },
        { sel: TEXT_SEL, want: expected },
        { timeout },
    );
}

// Fresh-mount empty + streaming, then let content grow — the empty-content seed path.
async function mountEmptyStreaming(page: Page): Promise<void> {
    await page.evaluate(() => window.__remountWith?.('', true));
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel);
            return !!el && (el.textContent ?? '').trim() === '';
        },
        TEXT_SEL,
        { timeout: 10_000 },
    );
}

async function waitForPartial(page: Page, timeout: number): Promise<void> {
    await page.waitForFunction(
        ({ sel, fullLen }) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const t = (el.textContent ?? '').trim();
            return t.length > 0 && t.length < fullLen;
        },
        { sel: TEXT_SEL, fullLen: LONG.length },
        { timeout },
    );
}

test.describe('Task .61.1 — usePacedText mount-seed (real Chromium, real hook)', () => {
    // AC1.3a / AC1.4(i): remount with streaming + pre-existing content shows the FULL text
    // fast (no from-0 replay). With the seed reverted to `streaming ? 0` this goes RED — a
    // multi-second reveal cannot reach full within 1.5s.
    test('(a) streaming remount with existing content reveals full text immediately, no replay', async ({ page }) => {
        test.setTimeout(60_000);
        await mount(page);
        await page.evaluate((c) => window.__remountWith?.(c, true), LONG);
        await waitForText(page, LONG, 1_500);
    });

    // AC1.3b / AC1.4(ii,iii): empty mount then growing content is revealed PACED — a partial,
    // shorter-than-full state is genuinely observed before convergence. RED if the tick jumps
    // straight to content.length (no partial) or if timer scheduling is removed (never converges).
    test('(b) empty mount then growing content reveals progressively, shorter than full first', async ({ page }) => {
        test.setTimeout(60_000);
        await mount(page);
        await mountEmptyStreaming(page);
        await page.evaluate((c) => window.__setContent?.(c), LONG);

        await waitForPartial(page, 5_000);
        const partial = await readText(page);
        expect(partial.length).toBeGreaterThan(0);
        expect(partial.length).toBeLessThan(LONG.length);
        expect(LONG.startsWith(partial)).toBe(true);

        await waitForText(page, LONG, 20_000);
    });

    // AC1.3c: a non-streaming mount always shows the full content immediately.
    test('(c) non-streaming mount shows the full content immediately', async ({ page }) => {
        test.setTimeout(60_000);
        await mount(page);
        await page.evaluate((c) => window.__remountWith?.(c, false), LONG);
        await waitForText(page, LONG, 1_500);
    });

    // AC1.3d: content shrinking during streaming keeps output bounded — the real hook renders
    // exactly the shorter content, never a stale/overlong slice.
    test('(d) content shrink during streaming stays bounded (no overlong slice)', async ({ page }) => {
        test.setTimeout(60_000);
        await mount(page);
        await mountEmptyStreaming(page);
        await page.evaluate((c) => window.__setContent?.(c), LONG);
        await waitForText(page, LONG, 20_000);

        await page.evaluate((c) => window.__setContent?.(c), SHORT);
        await waitForText(page, SHORT, 5_000);
        const shrunk = await readText(page);
        expect(shrunk.length).toBeLessThan(LONG.length);
    });

    // AC1.3 negative-1: flipping streaming off mid-reveal shows the full text immediately.
    test('(negative) streaming true->false mid-reveal shows full text immediately', async ({ page }) => {
        test.setTimeout(60_000);
        await mount(page);
        await mountEmptyStreaming(page);
        await page.evaluate((c) => window.__setContent?.(c), LONG);
        await waitForPartial(page, 5_000);

        await page.evaluate(() => window.__setDisableAnim?.(true));
        await waitForText(page, LONG, 1_500);
    });

    // AC1.3 negative-2: unmounting mid-reveal tears down cleanly — the markdown node detaches
    // and no UNCAUGHT exception is thrown by a pending tick firing after unmount (the effect
    // cleanup clears the timer). Only pageerror (uncaught) is asserted; stub-provider console
    // noise (the fixture's no-op SyncProvider sdk has no real SSE stream, so event-pipeline and
    // favicon/resource 404s log errors) is app-boundary and unrelated to the hook.
    test('(negative) unmount mid-reveal clears the timer without error', async ({ page }) => {
        test.setTimeout(60_000);
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push(String(err)));

        await mount(page);
        await mountEmptyStreaming(page);
        await page.evaluate((c) => window.__setContent?.(c), LONG);
        await waitForPartial(page, 5_000);

        await page.evaluate(() => window.__setMounted?.(false));
        await page.waitForSelector('[data-harness-unmounted="true"]', { state: 'attached', timeout: 10_000 });
        await page.waitForSelector(TEXT_SEL, { state: 'detached', timeout: 10_000 });

        // Give any errant pending tick a chance to fire against the unmounted tree.
        await page.waitForTimeout(400);
        expect(pageErrors).toEqual([]);
    });
});
