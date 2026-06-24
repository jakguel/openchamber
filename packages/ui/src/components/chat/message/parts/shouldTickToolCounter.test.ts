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
