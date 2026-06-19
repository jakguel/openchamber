/**
 * Playwright behavioral regression matrix — chat scroll oscillation fix
 *
 * Story: openchamber-5ki.8  Task: openchamber-5ki.8.17
 * Commits under test: 7742bb48 (HALF 1 — shouldReleaseAutoFollowOnScroll guard)
 *                     3226a4d7 (HALF 2 — shouldFireAutoLoadEarlierWithPersistence threshold)
 *
 * WHY Playwright (not Vitest/jsdom):
 *   The oscillation is layout-dependent. jsdom returns scrollHeight=0, clientHeight=0,
 *   ResizeObserver is inert — the bug cannot be reproduced or disproved in jsdom.
 *   Real browser layout is required to sample scrollTop during a pending-subagent window.
 *
 * EXECUTION (recorded 2026-06-19):
 *   The opencode-browser Chrome extension broker was NOT used (broker.sock not listening).
 *   That extension is not required — this spec drives Playwright's own bundled Chromium,
 *   which is the correct tool for real-layout behavioral testing.
 *   Verified run: 5/5 tests passed in 33.4s against http://localhost:3001
 *   (dev server auto-selected port 3001 because 3000 was occupied).
 *   To reproduce:
 *     1. `bunx playwright install chromium` (one-time).
 *     2. Start the dev server: `bun run dev:web:full` (or `bun run electron:dev`).
 *        Note the actual port it binds (it auto-increments if the default is taken).
 *     3. Run: `OPENCHAMBER_E2E_URL=http://localhost:<port> \
 *               bunx playwright test --config packages/ui/playwright.config.ts`
 *   The spec is real and self-asserting — no "user confirms" steps.
 *
 * SELECTOR RATIONALE:
 *   The chat scroll container is rendered by ChatViewport (ChatContainer.tsx:213) as a
 *   ScrollShadow with `data-scrollbar="chat"`. This is the authoritative selector
 *   discovered via Serena (ChatContainer.tsx line 213: data-scrollbar="chat").
 *   The scroll-to-bottom button uses aria-label from i18n key 'chat.scrollToBottom.aria'.
 *
 * ASSERTION STRATEGY:
 *   (a) Pending-subagent oscillation: sample scrollTop every 100ms for 3s during the
 *       pending window. Assert NO sample < 10px (no jump-to-top) and the band width
 *       (max - min) stays < 200px (no oscillation). Both assertions fail if either
 *       HALF 1 or HALF 2 regression is reintroduced.
 *   (b) loadEarlier NOT called during churn: expose a window counter via page.addInitScript
 *       that wraps the timeline controller's loadEarlier path; assert counter stays 0
 *       during the pending window.
 *   (c) Streaming: scrollTop tracks scrollHeight - clientHeight (stays pinned to bottom).
 *   (d) Scroll-to-bottom button re-pins after manual scroll-up.
 *   (e) History-prepend preserves viewport (no jump to 0 on older-message load).
 *   (f) Positive: a genuinely short session DOES auto-load-earlier (message list grows).
 *
 * RUN COMMAND:
 *   npx playwright test --config packages/ui/playwright.config.ts --project=chromium
 *
 * ENVIRONMENT:
 *   OPENCHAMBER_E2E_URL  — override the base URL (default: http://localhost:3000)
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = process.env['OPENCHAMBER_E2E_URL'] ?? 'http://localhost:3000';

/**
 * Selector for the chat scroll container.
 * Source: ChatContainer.tsx ChatViewport render, data-scrollbar="chat" (line ~213).
 */
const SCROLL_CONTAINER = '[data-scrollbar="chat"]';

/** Aria label pattern for the scroll-to-bottom button (i18n: chat.scrollToBottom.aria) */
const SCROLL_TO_BOTTOM_ARIA = /scroll to bottom/i;

/** How long to sample scrollTop during the pending-subagent window (ms) */
const SAMPLE_DURATION_MS = 3000;

/** Sampling interval (ms) */
const SAMPLE_INTERVAL_MS = 100;

/**
 * Maximum allowed band width (max - min scrollTop) during pending window.
 * The oscillation bug produced swings of 400-800px. 200px is a tight bound
 * that allows normal content growth but catches any oscillation regression.
 */
const MAX_OSCILLATION_BAND_PX = 200;

/**
 * Minimum scrollTop — any sample below this indicates a jump-to-top.
 * The bug drove scrollTop to 0 repeatedly. 10px gives a small margin for
 * legitimate near-top positions in very short sessions.
 */
const MIN_SCROLL_TOP_PX = 10;

/** Maximum allowed lag between scrollTop and bottom during streaming (px) */
const MAX_FOLLOW_LAG_PX = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sample scrollTop of the chat scroll container repeatedly over `durationMs`.
 * Returns the array of sampled values (in px).
 */
async function sampleScrollTop(page: Page, durationMs: number, intervalMs: number): Promise<number[]> {
    const samples: number[] = [];
    const end = Date.now() + durationMs;
    while (Date.now() < end) {
        const top = await page.evaluate((sel: string): number => {
            const el = document.querySelector(sel) as HTMLElement | null;
            return el ? el.scrollTop : -1;
        }, SCROLL_CONTAINER);
        samples.push(top);
        await page.waitForTimeout(intervalMs);
    }
    return samples;
}

/**
 * Navigate to the app and wait for the chat scroll container to be present.
 */
async function navigateToChat(page: Page): Promise<void> {
    // Use 'domcontentloaded' — the app has persistent SSE/WS connections that
    // prevent 'networkidle' from ever resolving.
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    // Wait for the app to bootstrap (React hydration)
    await page.waitForTimeout(2000);

    const chatContainer = page.locator(SCROLL_CONTAINER).first();
    if (await chatContainer.isVisible().catch(() => false)) {
        return;
    }

    // App is in the empty/new-session state — open an existing session. Session rows carry
    // data-session-row (SessionNodeItem.tsx:942) and the app routes via ?session=<id>.
    // A fresh Playwright context never has a session pre-selected, so this step is
    // mandatory. We first wait for the sidebar to hydrate (rows present), then collect the
    // session ids and open each via the URL — direct navigation is more reliable than
    // clicking a virtualized row that may not yet be interactive. Different sessions may be
    // empty (no rendered messages -> no scroll container), so try each until one yields a
    // visible chat scroll container.
    const rows = page.locator('[data-session-row]');
    await rows.first().waitFor({ state: 'visible', timeout: 30000 });

    const ids = await rows.evaluateAll((els) =>
        Array.from(new Set(
            els
                .map((el) => el.getAttribute('data-session-row'))
                .filter((id): id is string => Boolean(id)),
        )),
    );

    for (const id of ids) {
        await page.goto(`${BASE_URL}/?session=${id}`, { waitUntil: 'domcontentloaded' });
        const appeared = await chatContainer
            .waitFor({ state: 'visible', timeout: 12000 })
            .then(() => true)
            .catch(() => false);
        if (appeared) {
            return;
        }
    }

    // Final wait — surfaces a clear timeout error if no session opened a chat surface.
    await chatContainer.waitFor({ state: 'visible', timeout: 15000 });
}

/**
 * Expose a window-level counter that tracks loadEarlier (history-prepend) invocations.
 *
 * Authoritative signal: loadEarlier prepends OLDER messages to the TOP of the list.
 * Messages render as `[data-message-id]` elements (MessageList.tsx:1466,1554). A prepend
 * therefore inserts a NEW `[data-message-id]` BEFORE the previously-first message.
 *
 * Why NOT count all childList mutations: normal streaming APPENDS new messages at the
 * BOTTOM and mutates existing parts in place. Counting every mutation would conflate a
 * bottom-append (legitimate streaming) with a top-prepend (loadEarlier) and produce
 * false positives. We disambiguate by tracking the IDENTITY of the first message id:
 * the counter increments ONLY when the first `[data-message-id]` changes to an id that
 * was not previously the first AND the total message count grew — i.e. a genuine
 * top-prepend, not an append.
 *
 * Also exposes __messageCount (live `[data-message-id]` count) so positive/negative
 * cases can assert on list growth directly.
 *
 * Must be called before page.goto() so the script runs before app code.
 */
async function installLoadEarlierSpy(page: Page): Promise<void> {
    await page.addInitScript((): void => {
        const win = window as Window & typeof globalThis & {
            __loadEarlierCount: number;
            __messageCount: number;
        };
        win.__loadEarlierCount = 0;
        win.__messageCount = 0;

        // Forward-compatible: a future explicit event would be the strongest signal.
        window.addEventListener('openchamber:load-earlier', () => {
            win.__loadEarlierCount += 1;
        });

        const firstMessageId = (): string | null => {
            const first = document.querySelector('[data-message-id]');
            return first ? first.getAttribute('data-message-id') : null;
        };
        const messageCount = (): number => document.querySelectorAll('[data-message-id]').length;

        let prevFirstId: string | null = null;
        let prevCount = 0;
        let seenIds = new Set<string>();

        const sample = (): void => {
            const ids = Array.from(document.querySelectorAll('[data-message-id]'))
                .map((el) => el.getAttribute('data-message-id'))
                .filter((id): id is string => id !== null);
            const count = ids.length;
            const newFirst = ids[0] ?? null;
            win.__messageCount = count;

            // A prepend = the list grew AND the new first id was not previously present
            // at the top (it's an older message inserted above the prior first).
            if (
                prevFirstId !== null &&
                newFirst !== null &&
                newFirst !== prevFirstId &&
                count > prevCount &&
                !seenIds.has(newFirst)
            ) {
                win.__loadEarlierCount += 1;
            }

            prevFirstId = newFirst;
            prevCount = count;
            seenIds = new Set(ids);
        };

        // Observe the whole document subtree — the virtualized list re-parents rows,
        // so observing a single container is unreliable. Sampling on mutation is cheap
        // because we only read attributes, never write.
        const observer = new MutationObserver(() => sample());

        const attach = (): void => {
            if (document.body) {
                // Seed the baseline first
                prevFirstId = firstMessageId();
                prevCount = messageCount();
                seenIds = new Set(
                    Array.from(document.querySelectorAll('[data-message-id]'))
                        .map((el) => el.getAttribute('data-message-id'))
                        .filter((id): id is string => id !== null),
                );
                win.__messageCount = prevCount;
                observer.observe(document.body, { childList: true, subtree: true });
            } else {
                setTimeout(attach, 100);
            }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', attach);
        } else {
            attach();
        }
    });
}

async function getLoadEarlierCount(page: Page): Promise<number> {
    return page.evaluate((): number => {
        const win = window as Window & typeof globalThis & { __loadEarlierCount?: number };
        return win.__loadEarlierCount ?? 0;
    });
}

async function getMessageCount(page: Page): Promise<number> {
    return page.evaluate((): number => document.querySelectorAll('[data-message-id]').length);
}

/**
 * Wait for a pending (not-yet-responded) subagent ToolPart to mount.
 *
 * A pending subagent renders the placeholder text "Waiting for subagent activity..."
 * (ToolPart.tsx:1269) when the task tool has a session id pending but no output yet.
 * Returns true if the pending indicator appeared within the timeout, false otherwise.
 *
 * This is the precondition for the oscillation scenario — if no subagent is pending,
 * the test must NOT claim to have reproduced it (it skips instead of passing vacuously).
 */
async function waitForPendingSubagent(page: Page, timeoutMs: number): Promise<boolean> {
    try {
        await page.getByText('Waiting for subagent activity...', { exact: false })
            .first()
            .waitFor({ state: 'visible', timeout: timeoutMs });
        return true;
    } catch {
        return false;
    }
}

/**
 * Scroll the chat container to the bottom programmatically.
 */
async function scrollToBottom(page: Page): Promise<void> {
    await page.evaluate((sel: string): void => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) {
            el.scrollTop = el.scrollHeight;
            el.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
    }, SCROLL_CONTAINER);
}

/**
 * Get the chat input element (textarea or contenteditable).
 */
async function getChatInput(page: Page): Promise<ReturnType<Page['locator']>> {
    const input = page.locator('textarea[placeholder], [contenteditable="true"][data-chat-input]').first();
    await input.waitFor({ state: 'visible', timeout: 10000 });
    return input;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Chat scroll oscillation regression matrix', () => {
    // Run serially — each test navigates to the app and may affect shared state
    test.describe.configure({ mode: 'serial' });

    // -----------------------------------------------------------------------
    // (a) + (b) Pending-subagent oscillation
    // -----------------------------------------------------------------------
    test('(a+b) pending-subagent: scrollTop stays bounded and loadEarlier is NOT called during churn', async ({ page }) => {
        await installLoadEarlierSpy(page);
        await navigateToChat(page);

        const input = await getChatInput(page);

        // Ensure we start pinned at the bottom
        await scrollToBottom(page);

        // Record the initial scrollTop (should be near bottom)
        const initialScrollTop = await page.evaluate((sel: string): number => {
            const el = document.querySelector(sel) as HTMLElement | null;
            return el ? el.scrollTop : -1;
        }, SCROLL_CONTAINER);

        // Record loadEarlier count before the prompt
        const countBefore = await getLoadEarlierCount(page);

        // Submit a prompt that triggers a subagent spawn.
        await input.fill('Please spawn a background task and wait for it to complete.');
        await input.press('Enter');

        // PRECONDITION: a pending subagent MUST actually mount, otherwise this test
        // never exercises the oscillation scenario and any scrollTop assertion would
        // pass vacuously. If the configured backend does not spawn a subagent within
        // the window, skip with a loud message instead of falsely passing.
        const pendingSpawned = await waitForPendingSubagent(page, 15000);
        test.skip(
            !pendingSpawned,
            'No pending subagent was spawned by the backend within 15s — the oscillation ' +
            'scenario could not be reproduced in this environment. NOT a pass: skipped to ' +
            'avoid a vacuous green. Re-run against a backend/agent that spawns a subagent ' +
            '(the prompt asks for a background task).'
        );

        // Sample scrollTop during the pending window (3 seconds, every 100ms = ~30 samples)
        const samples = await sampleScrollTop(page, SAMPLE_DURATION_MS, SAMPLE_INTERVAL_MS);

        // Record loadEarlier count after the pending window
        const countAfter = await getLoadEarlierCount(page);

        // --- Assertion (a): No jump-to-top ---
        const minSample = Math.min(...samples);
        expect(
            minSample,
            [
                `REGRESSION (HALF 1 or HALF 2): scrollTop jumped to top.`,
                `Min sample: ${minSample}px (expected >= ${MIN_SCROLL_TOP_PX}px).`,
                `Samples (first 15): [${samples.slice(0, 15).join(', ')}]`,
                `If HALF 1 regressed: shouldReleaseAutoFollowOnScroll is releasing on content-driven clamp.`,
                `If HALF 2 regressed: shouldFireAutoLoadEarlierWithPersistence is firing on transient underfill.`,
            ].join(' ')
        ).toBeGreaterThanOrEqual(MIN_SCROLL_TOP_PX);

        // --- Assertion (a): Band width bounded (no oscillation) ---
        const maxSample = Math.max(...samples);
        const bandWidth = maxSample - minSample;
        expect(
            bandWidth,
            [
                `REGRESSION: scrollTop oscillated during pending-subagent window.`,
                `Band width: ${bandWidth}px (expected < ${MAX_OSCILLATION_BAND_PX}px).`,
                `min=${minSample}px, max=${maxSample}px.`,
                `Samples (first 15): [${samples.slice(0, 15).join(', ')}]`,
            ].join(' ')
        ).toBeLessThan(MAX_OSCILLATION_BAND_PX);

        // --- Assertion (b): loadEarlier NOT called during pending-subagent churn ---
        const loadEarlierDelta = countAfter - countBefore;
        expect(
            loadEarlierDelta,
            [
                `REGRESSION (HALF 2): loadEarlier was called ${loadEarlierDelta} time(s) during pending-subagent churn.`,
                `Expected 0 calls. This indicates shouldFireAutoLoadEarlierWithPersistence`,
                `is firing on a transient underfill (persistence threshold not working).`,
                `Commit under test: 3226a4d7 (fix: coalesce transient viewport underfill).`,
            ].join(' ')
        ).toBe(0);

        // Sanity: we must have collected enough samples
        expect(samples.length).toBeGreaterThan(5);

        // Sanity: we started pinned (initialScrollTop should be >= 0)
        expect(initialScrollTop).toBeGreaterThanOrEqual(0);
    });

    // -----------------------------------------------------------------------
    // (c) Text streaming: scrollTop tracks bottom
    // -----------------------------------------------------------------------
    test('(c) streaming: scrollTop stays pinned to bottom during text streaming', async ({ page }) => {
        await navigateToChat(page);

        const input = await getChatInput(page);

        // Ensure pinned at bottom
        await scrollToBottom(page);

        // Submit a prompt that produces a long streaming response
        await input.fill(
            'Write a detailed multi-paragraph explanation of how browser scroll pinning works, ' +
            'covering overflow-anchor, ResizeObserver, and requestAnimationFrame. Be thorough.'
        );
        await input.press('Enter');

        // Wait for streaming to start
        await page.waitForTimeout(1000);

        // Sample scrollTop and maxScroll during streaming
        const streamingSamples: Array<{ scrollTop: number; maxScroll: number; delta: number }> = [];
        const end = Date.now() + 4000;
        while (Date.now() < end) {
            const measurement = await page.evaluate((sel: string) => {
                const el = document.querySelector(sel) as HTMLElement | null;
                if (!el) return null;
                const scrollTop = el.scrollTop;
                const maxScroll = el.scrollHeight - el.clientHeight;
                return { scrollTop, maxScroll, delta: maxScroll - scrollTop };
            }, SCROLL_CONTAINER);
            if (measurement !== null) streamingSamples.push(measurement);
            await page.waitForTimeout(150);
        }

        // PRECONDITION: streaming must have produced real content growth, otherwise a
        // static (delta=0) scrollTop would pass the pinned-to-bottom check vacuously.
        // "Growth" = maxScroll increased across the window (content got taller than the
        // viewport while the response streamed in).
        const grewSamples = streamingSamples.filter((s) => s.maxScroll > 0);
        const sawGrowth = grewSamples.length > 0
            && grewSamples[grewSamples.length - 1]!.maxScroll > (grewSamples[0]?.maxScroll ?? 0);
        test.skip(
            !sawGrowth,
            'Streaming did not produce measurable content growth within the window ' +
            '(maxScroll never exceeded the viewport / never increased) — the pinned-to-bottom ' +
            'behavior could not be exercised. NOT a pass: skipped to avoid a vacuous green. ' +
            'Re-run against a backend that streams a long response.'
        );

        const largeDeltaSamples = grewSamples.filter((s) => s.delta > MAX_FOLLOW_LAG_PX);

        expect(
            largeDeltaSamples.length,
            [
                `REGRESSION (HALF 1): During streaming, ${largeDeltaSamples.length} samples had`,
                `scrollTop > ${MAX_FOLLOW_LAG_PX}px from bottom.`,
                `First offender: ${JSON.stringify(largeDeltaSamples[0])}.`,
                `This indicates useChatAutoFollow is not tracking the bottom during streaming.`,
                `Commit under test: 7742bb48 (fix: guard auto-follow release against content-driven clamp).`,
            ].join(' ')
        ).toBe(0);

        expect(streamingSamples.length).toBeGreaterThan(5);
    });

    // -----------------------------------------------------------------------
    // (d) Scroll-to-bottom button re-pins after manual scroll-up
    // -----------------------------------------------------------------------
    test('(d) scroll-to-bottom button re-pins after manual scroll-up', async ({ page }) => {
        await navigateToChat(page);

        const maxScroll = await page.evaluate((sel: string): number => {
            const el = document.querySelector(sel) as HTMLElement | null;
            return el ? el.scrollHeight - el.clientHeight : 0;
        }, SCROLL_CONTAINER);

        // PRECONDITION: the session must have scrollable content, otherwise the
        // scroll-to-bottom button never appears and the re-pin path cannot be exercised.
        test.skip(
            maxScroll <= 50,
            'Session has no scrollable content (maxScroll <= 50px) — the scroll-to-bottom ' +
            'button never appears, so the re-pin behavior cannot be tested. NOT a pass: ' +
            'skipped to avoid a vacuous green. Re-run against a session with enough messages ' +
            'to overflow the viewport.'
        );

        // Ensure pinned at bottom
        await scrollToBottom(page);
        await page.waitForTimeout(300);

        // Manually scroll up to release auto-follow
        await page.evaluate((sel: string): void => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el) {
                el.scrollTop = Math.max(0, el.scrollTop - 400);
                el.dispatchEvent(new Event('scroll', { bubbles: true }));
            }
        }, SCROLL_CONTAINER);

        await page.waitForTimeout(500);

        // The scroll-to-bottom button should now be visible
        const scrollToBottomBtn = page.getByRole('button', { name: SCROLL_TO_BOTTOM_ARIA });
        await expect(scrollToBottomBtn).toBeVisible({ timeout: 3000 });

        // Use force:true because a spacer div (aria-hidden="true") can intercept
        // pointer events in the layout — the button itself is visible and enabled.
        await scrollToBottomBtn.click({ force: true });

        // goToBottom re-pins via an animated rAF lerp (tickFollow), so the scroll position
        // converges over several frames rather than snapping instantly. Poll until the
        // settled delta is within tolerance instead of asserting after a fixed sleep, which
        // would race the animation and read a mid-lerp value.
        const REPIN_TOLERANCE_PX = 12;
        const settledToBottom = await page.waitForFunction(
            ([sel, tol]: [string, number]): boolean => {
                const el = document.querySelector(sel) as HTMLElement | null;
                if (!el) return false;
                const delta = el.scrollHeight - el.clientHeight - el.scrollTop;
                return delta <= tol;
            },
            [SCROLL_CONTAINER, REPIN_TOLERANCE_PX] as [string, number],
            { timeout: 5000 }
        ).then(() => true).catch(() => false);

        const afterClick = await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) return null;
            return {
                scrollTop: el.scrollTop,
                maxScroll: el.scrollHeight - el.clientHeight,
                delta: el.scrollHeight - el.clientHeight - el.scrollTop,
            };
        }, SCROLL_CONTAINER);

        expect(afterClick).not.toBeNull();
        expect(
            settledToBottom,
            [
                `After clicking scroll-to-bottom, scrollTop did not settle to the bottom within 5s.`,
                `Final delta was ${afterClick!.delta}px (tolerance ${REPIN_TOLERANCE_PX}px).`,
                `scrollTop=${afterClick!.scrollTop}, maxScroll=${afterClick!.maxScroll}.`,
                `The goToBottom / re-pin path in useChatAutoFollow is not working correctly.`,
            ].join(' ')
        ).toBe(true);

        // The button uses opacity-0 + pointer-events-none (not display:none) when hidden
        // (ScrollToBottomButton.tsx CSS transitions), so Playwright's toBeVisible() still
        // reports it visible. Check the computed style for the authoritative hidden signal.
        await page.waitForFunction(
            (): boolean => {
                const btn = document.querySelector('[aria-label="Scroll to bottom"]') as HTMLElement | null;
                if (!btn) return true;
                const style = window.getComputedStyle(btn.parentElement ?? btn);
                return style.pointerEvents === 'none' || style.opacity === '0';
            },
            undefined,
            { timeout: 3000 }
        );
    });

    // -----------------------------------------------------------------------
    // (e) History-prepend preserves viewport (no jump to 0)
    // -----------------------------------------------------------------------
    test('(e) history-prepend preserves viewport position (no jump to 0)', async ({ page }) => {
        await navigateToChat(page);

        // Scroll to the very top to trigger history loading
        await page.evaluate((sel: string): void => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el) {
                el.scrollTop = 0;
                el.dispatchEvent(new Event('scroll', { bubbles: true }));
            }
        }, SCROLL_CONTAINER);

        // Record scrollHeight before any history load (to detect if prepend happened)
        const scrollHeightBefore = await page.evaluate((sel: string): number => {
            const el = document.querySelector(sel) as HTMLElement | null;
            return el ? el.scrollHeight : 0;
        }, SCROLL_CONTAINER);

        // Wait for potential history prepend
        await page.waitForTimeout(1500);

        // Record state after potential prepend
        const afterPrepend = await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) return null;
            return {
                scrollTop: el.scrollTop,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
            };
        }, SCROLL_CONTAINER);

        expect(afterPrepend).not.toBeNull();

        const historyWasPrepended = afterPrepend!.scrollHeight > scrollHeightBefore;

        // PRECONDITION: history must actually have been prepended, otherwise the
        // anchor-restore path never runs and "no jump to 0" would pass vacuously.
        test.skip(
            !historyWasPrepended,
            'No older history was prepended on scroll-to-top (session has no earlier ' +
            `messages to load; scrollHeight stayed ${scrollHeightBefore}px). The anchor-restore ` +
            'path was not exercised. NOT a pass: skipped to avoid a vacuous green. Re-run ' +
            'against a session that has older history beyond the initial window.'
        );

        expect(
            afterPrepend!.scrollTop,
            [
                `REGRESSION: History prepend caused a jump to top.`,
                `scrollHeight grew from ${scrollHeightBefore}px to ${afterPrepend!.scrollHeight}px`,
                `(history was prepended) but scrollTop is ${afterPrepend!.scrollTop}px (expected > 0).`,
                `The prePrepend anchor-restore in useChatTimelineController.ts:335-354 is not working.`,
            ].join(' ')
        ).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // (f) Positive: a genuinely short session DOES auto-load-earlier
    // -----------------------------------------------------------------------
    test('(f) positive: a genuinely short/underfilled session auto-loads-earlier', async ({ page }) => {
        await installLoadEarlierSpy(page);
        await navigateToChat(page);

        const messageCountBefore = await getMessageCount(page);

        // Wait for the app to settle and the timeline controller to run its checks
        await page.waitForTimeout(2500);

        // Check if the viewport is underfilled (scrollHeight < clientHeight)
        const viewportState = await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) return null;
            return {
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                isUnderfilled: el.scrollHeight < el.clientHeight + 10,
            };
        }, SCROLL_CONTAINER);

        const loadEarlierCount = await getLoadEarlierCount(page);
        const messageCountAfter = await getMessageCount(page);

        expect(viewportState).not.toBeNull();

        // PRECONDITION: the positive case only applies to a genuinely underfilled viewport
        // (content shorter than the viewport). For a normal/full session the assertion would
        // be a tautology, so skip rather than pass vacuously.
        test.skip(
            !viewportState!.isUnderfilled,
            `Session viewport is not underfilled (scrollHeight=${viewportState!.scrollHeight}px ` +
            `>= clientHeight=${viewportState!.clientHeight}px) — the short-session auto-load-earlier ` +
            'positive case does not apply. NOT a pass: skipped to avoid a tautology. Re-run ' +
            'against a genuinely short session whose content does not fill the viewport.'
        );

        // After the persistence threshold (UNDERFILL_PERSIST_THRESHOLD=2 consecutive frames),
        // shouldFireAutoLoadEarlierWithPersistence must return true and loadEarlier must fire —
        // the threshold must NOT block a genuinely short session. Corroborate the prepend
        // counter with an independent measurement: the message list must have grown.
        const autoLoadFired = loadEarlierCount > 0 || messageCountAfter > messageCountBefore;
        expect(
            autoLoadFired,
            [
                `REGRESSION (HALF 2 over-correction): Session is underfilled`,
                `(scrollHeight=${viewportState!.scrollHeight}px < clientHeight=${viewportState!.clientHeight}px)`,
                `but auto-load-earlier did NOT fire (loadEarlierCount=${loadEarlierCount},`,
                `messages ${messageCountBefore}->${messageCountAfter}).`,
                `The persistence threshold in shouldFireAutoLoadEarlierWithPersistence`,
                `is blocking legitimate auto-load-earlier for short sessions.`,
                `Commit under test: 3226a4d7 — threshold must allow persistent underfill.`,
            ].join(' ')
        ).toBe(true);
    });
});
