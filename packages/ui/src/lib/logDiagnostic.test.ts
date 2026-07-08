import { afterEach, describe, expect, test } from 'bun:test';

import { forwardDiagnosticToServer } from './logDiagnostic';
import { clearRuntimeAuthCredentialProvider } from './runtime-auth';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

const originalFetch = globalThis.fetch;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRuntimeAuthCredentialProvider();
});

describe('forwardDiagnosticToServer', () => {
  test('posts the diagnostic to /api/log through runtimeFetch', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ url: string; method: string; body: string }> = [];
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({ url: request.url, method: request.method, body: await request.clone().text() });
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      forwardDiagnosticToServer('plantuml', 'syntax error at line 3', 'warn');
      await flush();

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.example/api/log');
      expect(calls[0].method).toBe('POST');
      expect(JSON.parse(calls[0].body)).toEqual({
        level: 'warn',
        tag: 'plantuml',
        message: 'syntax error at line 3',
      });
    } finally {
      setRuntimeUrlResolver(previous);
    }
  });

  test('truncates an oversized message before sending so the endpoint accepts it', async () => {
    const previous = getRuntimeUrlResolver();
    let sentMessage = '';
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        sentMessage = JSON.parse(await request.clone().text()).message;
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      forwardDiagnosticToServer('plantuml', 'y'.repeat(9000));
      await flush();

      expect(sentMessage.length <= 4000 + '…[truncated]'.length).toBe(true);
      expect(sentMessage.endsWith('…[truncated]')).toBe(true);
      expect(sentMessage.startsWith('yyyy')).toBe(true);
    } finally {
      setRuntimeUrlResolver(previous);
    }
  });

  test('swallows a failing endpoint without throwing into the caller', async () => {
    const previous = getRuntimeUrlResolver();
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      globalThis.fetch = (async () => {
        throw new Error('network down');
      }) as typeof fetch;

      let threw = false;
      try {
        forwardDiagnosticToServer('plantuml', 'boom');
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      await flush();
    } finally {
      setRuntimeUrlResolver(previous);
    }
  });
});
