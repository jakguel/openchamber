import { describe, expect, test } from 'bun:test';

import { runtimeFetch } from '../runtime-fetch';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../runtime-url';
import { clearRuntimeAuthCredentialProvider } from '../runtime-auth';
import { resolveOpenCodeVersion } from './resolveOpenCodeVersion';

const originalFetch = globalThis.fetch;

/**
 * Integration coverage for the About OpenCode-version boundary.
 *
 * `AboutDialog.tsx` and `AboutSettings.tsx` both read the bundled OpenCode
 * version by calling the REAL `runtimeFetch('/api/opencode/version', { method:
 * 'GET', headers: { Accept: 'application/json' } })` transport and parsing the
 * response with `resolveOpenCodeVersion`. This test drives that exact path
 * end-to-end — real runtimeFetch (the network is the only stubbed boundary) into
 * the real parse helper — so it catches a regression back to the removed
 * `/api/opencode/upgrade-status` route or a break in the `{ version }` contract
 * the server route (`GET /api/opencode/version`) guarantees.
 */
describe('About OpenCode version boundary (/api/opencode/version)', () => {
  test('runtimeFetch targets /api/opencode/version and resolveOpenCodeVersion reads { version }', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ url: string; method: string; accept: string | null }> = [];
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({
          url: request.url,
          method: request.method,
          accept: request.headers.get('accept'),
        });
        return new Response(JSON.stringify({ version: '1.16.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      // Exactly the request both About surfaces issue.
      const response = await runtimeFetch('/api/opencode/version', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => null);
      const version = resolveOpenCodeVersion(data);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://runtime.example/api/opencode/version');
      expect(calls[0].method).toBe('GET');
      expect(calls[0].accept).toBe('application/json');
      expect(version).toBe('1.16.0');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('a server-null version resolves to null so About renders the unknown label', async () => {
    const previous = getRuntimeUrlResolver();
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ version: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;

      const response = await runtimeFetch('/api/opencode/version', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => null);

      expect(resolveOpenCodeVersion(data)).toBeNull();
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});
