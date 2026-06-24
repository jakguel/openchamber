import { describe, expect, test } from 'bun:test';

import { shouldTickToolCounter } from './shouldTickToolCounter';

// Pure truth-table verification for the LiveDuration tick gate.
// The counter ticks ONLY when the tool is not finalized, the active latch is
// held, AND the runtime is connected. Any disconnect (isConnected === false)
// must pause the tick; reconnect resumes it for not-yet-finalized tools.
//
// | isFinalized | activeLatched | isConnected | expected |
// |-------------|---------------|-------------|----------|
// | false       | true          | true        | true     |
// | false       | true          | false       | false    |
// | false       | false         | true        | false    |
// | false       | false         | false       | false    |
// | true        | true          | true        | false    |
// | true        | true          | false       | false    |
// | true        | false         | true        | false    |
// | true        | false         | false       | false    |
describe('shouldTickToolCounter', () => {
    test('not finalized + active latch + connected → ticks', () => {
        expect(shouldTickToolCounter(false, true, true)).toBe(true);
    });

    test('not finalized + active latch + disconnected → paused', () => {
        expect(shouldTickToolCounter(false, true, false)).toBe(false);
    });

    test('not finalized + latch released + connected → no tick', () => {
        expect(shouldTickToolCounter(false, false, true)).toBe(false);
    });

    test('not finalized + latch released + disconnected → no tick', () => {
        expect(shouldTickToolCounter(false, false, false)).toBe(false);
    });

    test('finalized + active latch + connected → no tick', () => {
        expect(shouldTickToolCounter(true, true, true)).toBe(false);
    });

    test('finalized + active latch + disconnected → no tick', () => {
        expect(shouldTickToolCounter(true, true, false)).toBe(false);
    });

    test('finalized + latch released + connected → no tick', () => {
        expect(shouldTickToolCounter(true, false, true)).toBe(false);
    });

    test('finalized + latch released + disconnected → no tick', () => {
        expect(shouldTickToolCounter(true, false, false)).toBe(false);
    });

    test('only the (not-finalized, active, connected) row ticks across all 8 combinations', () => {
        const rows: Array<[boolean, boolean, boolean]> = [
            [false, false, false],
            [false, false, true],
            [false, true, false],
            [false, true, true],
            [true, false, false],
            [true, false, true],
            [true, true, false],
            [true, true, true],
        ];
        const ticking = rows.filter(([f, a, c]) => shouldTickToolCounter(f, a, c));
        expect(ticking).toEqual([[false, true, true]]);
    });
});

// AC5 regression: a disconnect must PAUSE the duration counter tick — and ONLY the
// tick. The tool row stays visible because ToolPart wires row visibility / shine
// text / task-summary to the connection-INDEPENDENT `isActive = !isFinalized &&
// activeLatched`, and feeds ONLY LiveDuration's `active` prop from this helper. This
// prevents the regression where gating the shared `isActive` on isConnected made the
// whole non-task running tool row vanish on disconnect.
//
// Component rendering is intentionally NOT exercised here: ToolPart.tsx is unimportable
// under `bun test` (its module graph pulls in a Vite `?worker&url` import), matching
// this repo's established "DOM paths deferred to Playwright" convention. The row-visibility
// invariant holds by construction — `isActive` does not take isConnected as an input — and
// the connection-gated pause/resume of the tick is verified below against the real helper.
describe('shouldTickToolCounter — AC5 pause/resume on connection toggle', () => {
    const NOT_FINALIZED = false;
    const ACTIVE_LATCH = true;

    test('connected → tick is live', () => {
        expect(shouldTickToolCounter(NOT_FINALIZED, ACTIVE_LATCH, true)).toBe(true);
    });

    test('disconnect → tick pauses (only isConnected changed)', () => {
        expect(shouldTickToolCounter(NOT_FINALIZED, ACTIVE_LATCH, false)).toBe(false);
    });

    test('reconnect while still not finalized → tick resumes', () => {
        expect(shouldTickToolCounter(NOT_FINALIZED, ACTIVE_LATCH, true)).toBe(true);
    });

    test('pause/resume is driven SOLELY by isConnected (latch inputs held fixed)', () => {
        const connectedSequence = [true, false, true, false].map((connected) =>
            shouldTickToolCounter(NOT_FINALIZED, ACTIVE_LATCH, connected),
        );
        expect(connectedSequence).toEqual([true, false, true, false]);
    });
});
