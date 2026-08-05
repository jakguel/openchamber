import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';

describe('readTaskTagSessionIdFromOutput', () => {
    test('parses task tags without state attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_abc123">')).toBe('ses_abc123');
    });

    test('parses task tags with additional attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_def456" state="completed">')).toBe('ses_def456');
    });
});

// Structural, real-code guard for the rAF-stagger removal (task openchamber-5ki.52.22).
// Reads the actual ToolPart.tsx production source (no mocks, no DOM) and asserts the
// refactor invariants: the module-global stagger machinery is gone, the hook renders
// synchronously (returns its argument directly), and the call-site WHEN conditions are
// byte-for-byte preserved. Each assertion fails if the production code regresses.
describe('ToolPart synchronous tool-body rendering (rAF stagger removed)', () => {
    const source = readFileSync(new URL('./ToolPart.tsx', import.meta.url), 'utf8');

    test('module-global one-mount-per-rAF stagger machinery is deleted', () => {
        expect(source).not.toContain('deferredToolBodyMounts');
        expect(source).not.toContain('deferredToolBodyFrame');
        expect(source).not.toContain('flushDeferredToolBodyMounts');
        expect(source).not.toContain('scheduleDeferredToolBodyMount');
    });

    test('useDeferredExpandedContent returns its boolean argument directly (synchronous)', () => {
        const signature = 'const useDeferredExpandedContent = (isExpanded: boolean) => {';
        expect(source).toContain(signature);

        const hookStart = source.indexOf(signature);
        const hookBody = source.slice(hookStart, source.indexOf('};', hookStart) + 2);
        // Identity body => useDeferredExpandedContent(true) === true and (false) === false, in-commit.
        expect(hookBody).toContain('return isExpanded;');
        // No deferral primitives may reappear inside the hook body.
        expect(hookBody).not.toContain('useState');
        expect(hookBody).not.toContain('useEffect');
        expect(hookBody).not.toContain('requestAnimationFrame');
    });

    test('call-site boolean conditions are preserved verbatim (only the timing was removed)', () => {
        expect(source).toContain(
            'const shouldRenderTaskSummary = useDeferredExpandedContent(isTaskTool && (taskSummaryEntries.length > 0 || isActive || shouldTreatAsFinalized || !!taskSessionId));',
        );
        expect(source).toContain(
            'const shouldRenderExpandedContent = useDeferredExpandedContent(!isTaskTool && isExpanded);',
        );
    });
});
