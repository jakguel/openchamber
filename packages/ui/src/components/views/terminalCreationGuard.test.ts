import { describe, expect, test } from 'bun:test';

import { shouldKeepCreatedSession, shouldStartTerminalCreation } from './terminalCreationGuard';

describe('shouldStartTerminalCreation', () => {
    test('starts creation on the first idle run (empty in-flight set, no terminal id)', () => {
        const inFlightSet = new Set<string>();
        expect(
            shouldStartTerminalCreation({
                key: '/proj-a::tab-1',
                inFlightSet,
                terminalId: null,
                lifecycle: 'idle',
                isActionTab: false,
                hasBufferedOutput: false,
            })
        ).toBe(true);
    });

    test('storm prevention: once the key is in-flight, the same key does NOT start a second creation', () => {
        const inFlightSet = new Set<string>();
        const key = '/proj-a::tab-1';
        const params = {
            key,
            inFlightSet,
            terminalId: null,
            lifecycle: 'idle',
            isActionTab: false,
            hasBufferedOutput: false,
        };
        // First run allows creation.
        expect(shouldStartTerminalCreation(params)).toBe(true);
        // Caller registers the in-flight creation, then a concurrent re-run arrives.
        inFlightSet.add(key);
        expect(shouldStartTerminalCreation(params)).toBe(false);
        // A DIFFERENT tab key is still allowed (guard is per-key, not global).
        expect(
            shouldStartTerminalCreation({ ...params, key: '/proj-a::tab-2' })
        ).toBe(true);
    });

    test('does not start creation when a terminal id already exists (empty string or set)', () => {
        const base = {
            key: '/proj-a::tab-1',
            inFlightSet: new Set<string>(),
            lifecycle: 'idle',
            isActionTab: false,
            hasBufferedOutput: false,
        };
        expect(shouldStartTerminalCreation({ ...base, terminalId: 'sess-x' })).toBe(false);
        expect(shouldStartTerminalCreation({ ...base, terminalId: '' })).toBe(true);
    });

    test("does not start creation when the tab lifecycle is 'exited'", () => {
        expect(
            shouldStartTerminalCreation({
                key: '/proj-a::tab-1',
                inFlightSet: new Set<string>(),
                terminalId: null,
                lifecycle: 'exited',
                isActionTab: false,
                hasBufferedOutput: false,
            })
        ).toBe(false);
    });

    test('does not start creation for an action tab that already has buffered output', () => {
        expect(
            shouldStartTerminalCreation({
                key: '/proj-a::tab-1',
                inFlightSet: new Set<string>(),
                terminalId: null,
                lifecycle: 'idle',
                isActionTab: true,
                hasBufferedOutput: true,
            })
        ).toBe(false);
    });

    test('DOES start creation for an action tab without buffered output', () => {
        expect(
            shouldStartTerminalCreation({
                key: '/proj-a::tab-1',
                inFlightSet: new Set<string>(),
                terminalId: null,
                lifecycle: 'idle',
                isActionTab: true,
                hasBufferedOutput: false,
            })
        ).toBe(true);
    });

    test('DOES start creation for a non-action tab that has buffered output (guard is only for action tabs)', () => {
        expect(
            shouldStartTerminalCreation({
                key: '/proj-a::tab-1',
                inFlightSet: new Set<string>(),
                terminalId: null,
                lifecycle: 'idle',
                isActionTab: false,
                hasBufferedOutput: true,
            })
        ).toBe(true);
    });
});

describe('shouldKeepCreatedSession', () => {
    test('keeps the freshly created session when the target dir AND tab still match', () => {
        expect(
            shouldKeepCreatedSession({
                currentDirectory: '/proj-a',
                currentTabId: 'tab-1',
                targetDirectory: '/proj-a',
                targetTabId: 'tab-1',
            })
        ).toBe(true);
    });

    test('drops the session on a genuine directory switch', () => {
        expect(
            shouldKeepCreatedSession({
                currentDirectory: '/proj-b',
                currentTabId: 'tab-1',
                targetDirectory: '/proj-a',
                targetTabId: 'tab-1',
            })
        ).toBe(false);
    });

    test('drops the session on a genuine tab switch within the same directory', () => {
        expect(
            shouldKeepCreatedSession({
                currentDirectory: '/proj-a',
                currentTabId: 'tab-2',
                targetDirectory: '/proj-a',
                targetTabId: 'tab-1',
            })
        ).toBe(false);
    });

    test('drops the session when the current directory is null (no active target yet)', () => {
        expect(
            shouldKeepCreatedSession({
                currentDirectory: null,
                currentTabId: 'tab-1',
                targetDirectory: '/proj-a',
                targetTabId: 'tab-1',
            })
        ).toBe(false);
    });

    test('drops the session when the current tab is null', () => {
        expect(
            shouldKeepCreatedSession({
                currentDirectory: '/proj-a',
                currentTabId: null,
                targetDirectory: '/proj-a',
                targetTabId: 'tab-1',
            })
        ).toBe(false);
    });
});
