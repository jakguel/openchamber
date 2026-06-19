import { describe, expect, test } from 'bun:test';

import { shouldReleaseAutoFollowOnScroll } from './useChatAutoFollow';

// Layout is injected (scrollTop / maxScroll = scrollHeight - clientHeight) because
// bun:test has no real DOM layout; that is the only external boundary stubbed here.

const base = {
    state: 'following' as const,
    currentTop: 800,
    previousTop: 1000,
    maxScrollNow: 2000,
    maxScrollPrev: 2000,
};

describe('shouldReleaseAutoFollowOnScroll', () => {
    test('AC4: genuine scroll-up with UNCHANGED maxScroll releases auto-follow', () => {
        // moved up (800 < 1000), maxScroll unchanged -> real user gesture
        expect(shouldReleaseAutoFollowOnScroll(base)).toBe(true);
    });

    test('AC2: content-driven clamp (scroll-up + maxScroll DECREASED) does NOT release', () => {
        // placeholder collapsed: scrollHeight dropped -> maxScroll dropped ->
        // scrollTop clamped down. Must stay following.
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            maxScrollNow: 1500,
            maxScrollPrev: 2000,
        })).toBe(false);
    });

    test('does not release when not currently following', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            state: 'released',
        })).toBe(false);
    });

    test('does not release when scroll did not move up (downward / no move)', () => {
        // scrolled down
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            currentTop: 1200,
            previousTop: 1000,
        })).toBe(false);
        // no movement
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            currentTop: 1000,
            previousTop: 1000,
        })).toBe(false);
    });

    test('content GROWTH with a downward scroll does not release (normal follow path)', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            currentTop: 1100,
            previousTop: 1000,
            maxScrollNow: 2200,
            maxScrollPrev: 2000,
        })).toBe(false);
    });

    test('genuine scroll-up while maxScroll GREW still releases (user fights growth)', () => {
        // maxScroll increased (content grew) but the user scrolled up anyway:
        // not a clamp, so a real gesture must still release.
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            maxScrollNow: 2100,
            maxScrollPrev: 2000,
        })).toBe(true);
    });
});
