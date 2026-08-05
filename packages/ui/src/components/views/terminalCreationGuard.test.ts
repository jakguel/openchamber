import { describe, expect, test } from 'bun:test';

import {
    runTerminalSessionCreation,
    shouldKeepCreatedSession,
    shouldStartTerminalCreation,
    type RunTerminalSessionCreationDeps,
} from './terminalCreationGuard';

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

describe('runTerminalSessionCreation', () => {
    type Recorder = {
        createCount: number;
        createArgs: Array<{ cwd: string; cols?: number; rows?: number }>;
        bindCalls: string[];
        closeCalls: string[];
    };

    const makeDeps = (
        overrides: Partial<RunTerminalSessionCreationDeps> = {}
    ): { deps: RunTerminalSessionCreationDeps; rec: Recorder } => {
        const rec: Recorder = { createCount: 0, createArgs: [], bindCalls: [], closeCalls: [] };
        const deps: RunTerminalSessionCreationDeps = {
            key: '/proj-a::tab-1',
            inFlightSet: new Set<string>(),
            terminalId: null,
            lifecycle: 'idle',
            isActionTab: false,
            hasBufferedOutput: false,
            directory: '/proj-a',
            tabId: 'tab-1',
            getCurrentDirectory: () => '/proj-a',
            getCurrentTabId: () => 'tab-1',
            createSession: async (opts) => {
                rec.createCount += 1;
                rec.createArgs.push(opts);
                return { sessionId: 'sess-1' };
            },
            closeSession: async (id) => {
                rec.closeCalls.push(id);
            },
            bindSession: (id) => {
                rec.bindCalls.push(id);
            },
            ...overrides,
        };
        return { deps, rec };
    };

    test('storm prevention: two concurrent invocations sharing the same key create the session EXACTLY ONCE', async () => {
        const inFlightSet = new Set<string>();
        let resolveCreate: (value: { sessionId: string }) => void = () => {};
        const pendingCreate = new Promise<{ sessionId: string }>((resolve) => {
            resolveCreate = resolve;
        });
        let createCount = 0;
        const bindCalls: string[] = [];
        const closeCalls: string[] = [];

        const baseDeps: RunTerminalSessionCreationDeps = {
            key: '/proj-a::tab-1',
            inFlightSet,
            terminalId: null,
            lifecycle: 'idle',
            isActionTab: false,
            hasBufferedOutput: false,
            directory: '/proj-a',
            tabId: 'tab-1',
            getCurrentDirectory: () => '/proj-a',
            getCurrentTabId: () => 'tab-1',
            createSession: async () => {
                createCount += 1;
                return pendingCreate;
            },
            closeSession: async (id) => {
                closeCalls.push(id);
            },
            bindSession: (id) => {
                bindCalls.push(id);
            },
        };

        // First invocation registers the in-flight key synchronously, then parks
        // on the pending createSession promise.
        const first = runTerminalSessionCreation(baseDeps);
        // Second concurrent invocation for the SAME key must short-circuit.
        const second = runTerminalSessionCreation(baseDeps);

        expect(await second).toEqual({ created: false, sessionId: null, kept: false });
        expect(createCount).toBe(1);

        resolveCreate({ sessionId: 'sess-1' });
        expect(await first).toEqual({ created: true, sessionId: 'sess-1', kept: true });
        expect(createCount).toBe(1);
        expect(bindCalls).toEqual(['sess-1']);
        expect(closeCalls).toEqual([]);
        expect(inFlightSet.size).toBe(0);
    });

    test('binds (keeps) the created session and passes cwd/cols/rows when the target is unchanged', async () => {
        const { deps, rec } = makeDeps({ cols: 120, rows: 40 });

        const result = await runTerminalSessionCreation(deps);

        expect(result).toEqual({ created: true, sessionId: 'sess-1', kept: true });
        expect(rec.createCount).toBe(1);
        expect(rec.createArgs).toEqual([{ cwd: '/proj-a', cols: 120, rows: 40 }]);
        expect(rec.bindCalls).toEqual(['sess-1']);
        expect(rec.closeCalls).toEqual([]);
        expect(deps.inFlightSet.size).toBe(0);
    });

    test('closes the orphaned session (no bind, no leak) when the target tab switched during creation', async () => {
        let currentTabId = 'tab-1';
        const { deps, rec } = makeDeps({
            getCurrentTabId: () => currentTabId,
            createSession: async () => {
                currentTabId = 'tab-2';
                return { sessionId: 'sess-1' };
            },
        });

        const result = await runTerminalSessionCreation(deps);

        expect(result).toEqual({ created: true, sessionId: 'sess-1', kept: false });
        expect(rec.closeCalls).toEqual(['sess-1']);
        expect(rec.bindCalls).toEqual([]);
        expect(deps.inFlightSet.size).toBe(0);
    });

    test('releases the in-flight key and propagates the error when createSession throws', async () => {
        const inFlightSet = new Set<string>();
        const { deps } = makeDeps({
            inFlightSet,
            createSession: async () => {
                throw new Error('boom');
            },
        });

        let thrown: unknown;
        try {
            await runTerminalSessionCreation(deps);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe('boom');
        expect(inFlightSet.has('/proj-a::tab-1')).toBe(false);
        expect(inFlightSet.size).toBe(0);
    });

    test('does not create when the entry guard rejects (existing terminal id) — no I/O issued', async () => {
        const { deps, rec } = makeDeps({ terminalId: 'sess-existing' });

        const result = await runTerminalSessionCreation(deps);

        expect(result).toEqual({ created: false, sessionId: null, kept: false });
        expect(rec.createCount).toBe(0);
        expect(rec.bindCalls).toEqual([]);
        expect(rec.closeCalls).toEqual([]);
    });
});
