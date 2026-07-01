import { describe, expect, mock, test } from 'bun:test';

type ConfigResponse = { data: Record<string, unknown> };

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(response: ConfigResponse) => void> = [];
let configCalls = 0;

const promptCalls: Array<Record<string, unknown>> = [];
const commandCalls: Array<Record<string, unknown>> = [];
const shellCalls: Array<Record<string, unknown>> = [];

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock(() => ({
    config: {
      get: mock(() => {
        configCalls += 1;
        return new Promise<ConfigResponse>((resolve) => {
          configResolvers.push(resolve);
        });
      }),
    },
    session: {
      promptAsync: mock((params: Record<string, unknown>) => {
        promptCalls.push(params);
        return Promise.resolve({ data: true });
      }),
      command: mock((params: Record<string, unknown>) => {
        commandCalls.push(params);
        return Promise.resolve({ data: true });
      }),
      shell: mock((params: Record<string, unknown>) => {
        shellCalls.push(params);
        return Promise.resolve({ data: { info: { id: 'msg_x', time: { created: 1 } }, parts: [] } });
      }),
    },
  })),
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: (path: string) => path,
  })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => 'test-runtime'),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify([]), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[0]?.({ data: { model: 'old/model' } });
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[1]?.({ data: { model: 'new/model' } });
    expect(await second).toEqual({ model: 'new/model' });
    expect(await third).toEqual({ model: 'new/model' });

    const cached = await opencodeClient.getConfig('/workspace/project');
    expect(cached).toEqual({ model: 'new/model' });
    expect(configCalls).toBe(2);
  });
});

describe('send guards — a send with no resolvable directory is non-sendable', () => {
  const base = { id: 'session-a', providerID: 'test-provider', modelID: 'test-model' };

  async function expectRejection(run: () => Promise<unknown>): Promise<void> {
    let threw = false;
    try {
      await run();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  }

  // Fails if `?? this.currentDirectory` is reintroduced: promptAsync would be
  // called with the poisoned process-global instead of throwing.
  test('sendMessage throws and never calls promptAsync when no directory resolves', async () => {
    promptCalls.length = 0;
    opencodeClient.setDirectory('/projA');

    await expectRejection(() => opencodeClient.sendMessage({ ...base, text: 'hello', directory: null }));
    expect(promptCalls).toHaveLength(0);
  });

  test('sendCommand throws and never calls session.command when no directory resolves', async () => {
    commandCalls.length = 0;
    opencodeClient.setDirectory('/projA');

    await expectRejection(() => opencodeClient.sendCommand({ ...base, command: 'build', directory: null }));
    expect(commandCalls).toHaveLength(0);
  });

  test('shellSession throws and never calls session.shell when no directory resolves', async () => {
    shellCalls.length = 0;
    opencodeClient.setDirectory('/projA');

    await expectRejection(() => opencodeClient.shellSession({
      sessionId: 'session-a',
      command: 'ls',
      agent: 'build',
      model: { providerID: 'test-provider', modelID: 'test-model' },
      directory: null,
    }));
    expect(shellCalls).toHaveLength(0);
  });

  // Happy path: a resolved directory is forwarded unchanged, never the global.
  test('sendMessage forwards a resolved directory to promptAsync unchanged', async () => {
    promptCalls.length = 0;
    opencodeClient.setDirectory('/projA');

    const id = await opencodeClient.sendMessage({ ...base, text: 'hello', directory: '/projB' });

    expect(typeof id).toBe('string');
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].directory).toBe('/projB');
  });
});
