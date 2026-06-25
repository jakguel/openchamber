import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(),
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;

afterEach(() => {
  spawnMock.mockReset();
  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }

  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  return child;
};

const buildRuntime = (overrides = {}) => {
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
  };

  const runtime = createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    applyOpencodeBinaryFromSettings: vi.fn(async () => null),
    ensureOpencodeCliEnv: vi.fn(),
    ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
    resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
    setOpenCodePort: vi.fn((port) => {
      state.openCodePort = port;
    }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    clearResolvedOpenCodeBinary: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
      PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
      SHELL_ONLY: 'yes',
      OPENCODE_SERVER_PASSWORD: 'shell-password',
    })),
    ...overrides,
  });

  return { runtime, state };
};

const createRuntime = (overrides = {}) => buildRuntime(overrides).runtime;

describe('OpenCode lifecycle', () => {
  it('launches managed OpenCode with the managed PATH', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const [binary, args, options] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '45678']);
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.SHELL_ONLY).toBe('yes');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');

    await server.close();
  });

  it('falls back to buildAugmentedPath when buildManagedOpenCodePath is not provided', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: vi.fn(() => '/home/user/.cargo/bin:/usr/local/bin'),
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/home/user/.cargo/bin:/usr/local/bin');

    await server.close();
  });

  it('falls back to process.env.PATH when neither build function is provided', async () => {
    delete process.env.OPENCODE_BINARY;
    process.env.PATH = '/usr/bin:/bin';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: undefined,
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/usr/bin:/bin');

    await server.close();
  });

  it('reports the binary when managed OpenCode exits before becoming ready', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.emit('exit', null, 'SIGTERM');
      });
      return secondChild;
    });

    const runtime = createRuntime();

    await expect(runtime.startOpenCode()).rejects.toThrow('OpenCode process exited before serving with signal SIGTERM. Binary used: opencode. No stdout/stderr captured');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry managed startup when the configured OpenCode binary is invalid', async () => {
    delete process.env.OPENCODE_BINARY;
    const error = new Error('Configured OpenCode binary not found: /missing/opencode');
    error.code = 'OPENCODE_BINARY_INVALID';
    const applyOpencodeBinaryFromSettings = vi.fn(async () => {
      throw error;
    });

    const runtime = createRuntime({ applyOpencodeBinaryFromSettings });

    await expect(runtime.startOpenCode()).rejects.toThrow('Configured OpenCode binary not found: /missing/opencode');
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledTimes(1);
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledWith({ strict: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('retries managed OpenCode startup once after a pre-ready exit', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return secondChild;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await server.close();
  });
});

describe('OpenCode managed-process exit observation + alive check', () => {
  const originalFetch = global.fetch;
  let activeSpies = [];

  afterEach(() => {
    global.fetch = originalFetch;
    for (const spy of activeSpies) spy.mockRestore();
    activeSpies = [];
  });

  const queueReadyChild = (pid = process.pid) => {
    const child = createMockChild();
    child.pid = pid;
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    return child;
  };

  const simulateChildExit = (child, code, signal) => {
    child.exitCode = code ?? null;
    child.signalCode = signal ?? null;
    child.emit('exit', code, signal);
  };

  const failHealthProbe = () => {
    global.fetch = vi.fn(async () => {
      throw new Error('health probe failed');
    });
  };

  it('records real child exit state and a per-spawn generation on the managed handle', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = queueReadyChild();
    const { runtime } = buildRuntime();

    const handle1 = await runtime.startOpenCode();
    expect(typeof handle1.generation).toBe('number');
    expect(handle1.exited).toBe(false);
    expect(handle1.exitCode).toBe(null);
    expect(handle1.signalCode).toBe(null);

    simulateChildExit(firstChild, 7, null);
    expect(handle1.exited).toBe(true);
    expect(handle1.exitCode).toBe(7);
    expect(handle1.signalCode).toBe(null);

    queueReadyChild();
    const handle2 = await runtime.startOpenCode();
    expect(handle2.generation).toBe(handle1.generation + 1);
    expect(handle2.exited).toBe(false);
  });

  it('keeps a live-but-unhealthy OpenCode running on the first health failure (no restart, no exit recorded)', async () => {
    delete process.env.OPENCODE_BINARY;
    queueReadyChild(process.pid);
    const { runtime, state } = buildRuntime();
    state.openCodeProcess = await runtime.startOpenCode();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    failHealthProbe();
    await runtime.triggerHealthCheck();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(state.openCodeProcess.exited).toBe(false);
    expect(state.openCodeProcess.exitCode).toBe(null);
  });

  it('restarts promptly when the managed child has genuinely exited', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = queueReadyChild(process.pid);
    const { runtime, state } = buildRuntime();
    state.openCodeProcess = await runtime.startOpenCode();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    simulateChildExit(firstChild, 1, null);
    expect(state.openCodeProcess.exited).toBe(true);

    failHealthProbe();
    queueReadyChild(process.pid);

    await runtime.triggerHealthCheck();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(state.openCodeProcess.generation).toBe(2);
    expect(state.openCodeProcess.exited).toBe(false);
  }, 15000);

  it('keeps a live-but-busy unhealthy OpenCode running through the failure threshold + stale-busy grace, then restarts once the grace expires', async () => {
    delete process.env.OPENCODE_BINARY;
    const T0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0);
    // process.kill is the OS boundary: signal 0 = liveness probe (alive), and any
    // real signal (incl. the negative-pid group SIGTERM/SIGKILL from
    // signalProcessTree during restart) is swallowed so the test process group is
    // never signalled. The mock child's own kill() still emits 'close' so restart
    // closes the live child cleanly.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    activeSpies.push(nowSpy, killSpy);

    queueReadyChild(12345);
    const { runtime, state } = buildRuntime({ getActiveSessionCount: () => 1 });
    state.openCodeProcess = await runtime.startOpenCode();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    failHealthProbe();

    for (let i = 0; i < 30; i += 1) {
      await runtime.triggerHealthCheck();
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(state.openCodeProcess.exited).toBe(false);

    nowSpy.mockReturnValue(T0 + 5 * 60 * 1000);
    queueReadyChild(12345);
    await runtime.triggerHealthCheck();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(state.openCodeProcess.exited).toBe(false);
  }, 20000);
});
