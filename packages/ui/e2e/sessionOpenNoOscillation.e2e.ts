/**
 * Playwright behavioral regression — chat scroll SESSION-OPEN oscillation fix (WI-C)
 *
 * Story: openchamber-5ki.26  Task: openchamber-5ki.26.9
 * Commit under test: 9de56a46 (WI-B — instant snap-to-bottom, remove rAF-LERP + settle-burst)
 *
 * ROOT CAUSE THIS SPEC LOCKS DOWN:
 *   The residual session-open jiggle was TWO concurrent rAF scrollTop writers on
 *   different cadences — the idle LERP `tickFollow` and the 280 ms `startSettleBurst`
 *   easer — fighting over the bottom target while the session's initial content
 *   settled. WI-B removed BOTH and made every pinned content-commit a single
 *   instant O(1) snap (snapToBottomIfPinned). A correct fix means: on session open
 *   the viewport is at the bottom on the FIRST frame (no animated ramp from the top)
 *   and scrollTop does NOT move across the subsequent settle frames (no oscillation).
 *
 * WHY Playwright (not bun/jsdom):
 *   The oscillation is a real-layout, multi-frame TIMING property. bun test ships no
 *   DOM (scrollHeight/clientHeight are absent, ResizeObserver + rAF are inert), so
 *   the frame-to-frame movement that reintroducing a second easer would cause cannot
 *   be observed there. The predicate-level agreement invariant is covered in
 *   src/hooks/useChatAutoFollow.test.ts; THIS spec is the runtime guard.
 *
 * AGENT-EXECUTABLE — NO "user visually confirms" STEP:
 *   Every assertion reads scrollTop / scrollHeight / clientHeight directly from the
 *   live DOM and compares against the deterministic bottom target. Frame sampling
 *   uses requestAnimationFrame inside page.evaluate for exact consecutive frames.
 *
 * EXECUTION:
 *   1. `bunx playwright install chromium` (one-time).
 *   2. Start the dev server: `bun run dev:web:full` (or `bun run electron:dev`).
 *      Note the actual bound port (it auto-increments if the default is taken).
 *   3. Run:
 *        OPENCHAMBER_E2E_URL=http://localhost:<port> \
 *          bunx playwright test --config packages/ui/playwright.config.ts \
 *          sessionOpenNoOscillation
 *
 * PRECONDITION HANDLING:
 *   The instant-bottom + no-oscillation behavior can only be exercised against a
 *   session whose content OVERFLOWS the viewport (scrollback exists). If no such
 *   session is available the test SKIPS with a loud message — never a vacuous pass.
 *
 * ENVIRONMENT:
 *   OPENCHAMBER_E2E_URL — override the base URL (default: http://localhost:3000)
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = process.env['OPENCHAMBER_E2E_URL'] ?? 'http://localhost:3000';

/** Chat scroll container — ChatContainer.tsx ChatViewport, data-scrollbar="chat" (line ~218). */
const SCROLL_CONTAINER = '[data-scrollbar="chat"]';

/** Session rows in the sidebar — SessionNodeItem.tsx:893, data-session-row=<id>. */
const SESSION_ROW = '[data-session-row]';

/** Number of consecutive animation frames to sample scrollTop on session open. */
const FRAME_SAMPLE_COUNT = 20;

/**
 * Distance-from-bottom tolerance for "at the bottom" (px). Sub-pixel rounding and
 * a 10vh bottom spacer mean an exact 0 is not guaranteed; 4px is well below any
 * perceptible jiggle and far below the old 400-800px oscillation swings.
 */
const AT_BOTTOM_TOLERANCE_PX = 4;

/**
 * Max allowed scrollTop band (max - min) across the sampled frames. On session
 * open the session is IDLE (no streaming growth), so a correct single-writer snap
 * yields ZERO movement. 1px absorbs sub-pixel rounding only; a reintroduced second
 * easer would move scrollTop by tens-to-hundreds of px and blow past this.
 */
const MAX_IDLE_BAND_PX = 1;

/** A session must overflow by at least this much to exercise scrollback. */
const MIN_SCROLLABLE_PX = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface OpenFrameResult {
    /** scrollTop sampled once per rAF for FRAME_SAMPLE_COUNT consecutive frames. */
    samples: number[];
    /** Geometry captured on the first sampled frame. */
    firstFrame: { scrollTop: number; scrollHeight: number; clientHeight: number };
}

/**
 * Open the session at `sessionId` fresh (full navigation) and, starting from the
 * first animation frame after the scroll container is measurable, sample scrollTop
 * across FRAME_SAMPLE_COUNT consecutive frames. Returns null if the container never
 * became measurable (no chat surface for this session).
 */
async function openAndSampleFrames(page: Page, sessionId: string): Promise<OpenFrameResult | null> {
    await page.goto(`${BASE_URL}/?session=${sessionId}`, { waitUntil: 'domcontentloaded' });

    const appeared = await page
        .locator(SCROLL_CONTAINER)
        .first()
        .waitFor({ state: 'visible', timeout: 12000 })
        .then(() => true)
        .catch(() => false);
    if (!appeared) return null;

    return page.evaluate(
        async ([sel, frameCount, minScrollable]: [string, number, number]): Promise<OpenFrameResult | null> => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) return null;

            const nextFrame = (): Promise<void> => new Promise((res) => requestAnimationFrame(() => res()));

            // Wait (bounded) until the container actually has scrollable content, so
            // the first sampled frame is a real overflowing-open frame, not an empty
            // pre-hydration one.
            for (let i = 0; i < 120; i += 1) {
                if (el.scrollHeight - el.clientHeight > minScrollable) break;
                await nextFrame();
            }

            const firstFrame = {
                scrollTop: el.scrollTop,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
            };

            const samples: number[] = [el.scrollTop];
            for (let i = 1; i < frameCount; i += 1) {
                await nextFrame();
                samples.push(el.scrollTop);
            }
            return { samples, firstFrame };
        },
        [SCROLL_CONTAINER, FRAME_SAMPLE_COUNT, MIN_SCROLLABLE_PX] as [string, number, number],
    );
}

/**
 * Discover session ids from the sidebar. A fresh Playwright context never has a
 * session pre-selected, so we hydrate the sidebar and read the row ids.
 */
async function discoverSessionIds(page: Page): Promise<string[]> {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const rows = page.locator(SESSION_ROW);
    const hasRows = await rows
        .first()
        .waitFor({ state: 'visible', timeout: 30000 })
        .then(() => true)
        .catch(() => false);
    if (!hasRows) return [];

    return rows.evaluateAll((els) =>
        Array.from(
            new Set(
                els
                    .map((el) => el.getAttribute('data-session-row'))
                    .filter((id): id is string => Boolean(id)),
            ),
        ),
    );
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.describe('Chat session-open scroll: instant bottom + no oscillation (WI-C)', () => {
    test.describe.configure({ mode: 'serial' });

    test('opening a session with scrollback lands at the bottom instantly and does not oscillate', async ({ page }) => {
        const ids = await discoverSessionIds(page);
        test.skip(
            ids.length === 0,
            'No sessions found in the sidebar — cannot exercise session-open scroll. NOT a pass: ' +
            'skipped to avoid a vacuous green. Re-run against an instance that has at least one ' +
            'session with enough messages to overflow the viewport.',
        );

        // Find the first session that actually overflows the viewport on open.
        let opened: OpenFrameResult | null = null;
        let openedId: string | null = null;
        for (const id of ids) {
            const result = await openAndSampleFrames(page, id);
            if (result && result.firstFrame.scrollHeight - result.firstFrame.clientHeight > MIN_SCROLLABLE_PX) {
                opened = result;
                openedId = id;
                break;
            }
        }

        test.skip(
            opened === null,
            'No opened session produced a viewport-overflowing chat surface (every candidate was ' +
            'empty or shorter than the viewport) — the instant-bottom / no-oscillation behavior ' +
            'could not be exercised. NOT a pass: skipped to avoid a vacuous green. Re-run against a ' +
            'session with real scrollback.',
        );

        const { samples, firstFrame } = opened!;
        const maxScroll = firstFrame.scrollHeight - firstFrame.clientHeight;

        // --- Assertion 1: instant bottom on the FIRST frame (no animated ramp) ---
        // A LERP/settle-burst open would start near the top and climb over frames;
        // the instant single-writer snap is already at the bottom on frame one.
        const firstFrameDistance = maxScroll - firstFrame.scrollTop;
        expect(
            firstFrameDistance,
            [
                `REGRESSION: session open did NOT land at the bottom on the first frame.`,
                `session=${openedId} firstFrame.scrollTop=${firstFrame.scrollTop}px maxScroll=${maxScroll}px`,
                `distance=${firstFrameDistance}px (tolerance ${AT_BOTTOM_TOLERANCE_PX}px).`,
                `A non-zero first-frame distance means an animated ramp (LERP / settle-burst) is`,
                `back — WI-B removed both easers in favor of an instant snap.`,
            ].join(' '),
        ).toBeLessThanOrEqual(AT_BOTTOM_TOLERANCE_PX);

        // --- Assertion 2: scrollTop is STABLE across the settle frames (no jiggle) ---
        const minSample = Math.min(...samples);
        const maxSample = Math.max(...samples);
        const band = maxSample - minSample;
        expect(
            band,
            [
                `REGRESSION: scrollTop oscillated across ${samples.length} frames on session open.`,
                `session=${openedId} band=${band}px (expected <= ${MAX_IDLE_BAND_PX}px on an idle open).`,
                `min=${minSample}px max=${maxSample}px samples=[${samples.join(', ')}].`,
                `A non-zero band on an idle (non-streaming) open means a second scrollTop writer`,
                `is fighting the snap — the exact two-writer defect WI-B eliminated.`,
            ].join(' '),
        ).toBeLessThanOrEqual(MAX_IDLE_BAND_PX);

        // Sanity: we actually sampled the intended number of frames.
        expect(samples.length).toBe(FRAME_SAMPLE_COUNT);
    });
});
