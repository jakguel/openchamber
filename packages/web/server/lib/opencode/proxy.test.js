import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  createDirectoryQueryCanonicalizer,
  createUpstreamAgent,
  isRetryableUpstreamError,
  registerOpenCodeProxy,
  shouldRetryUpstreamRequest,
} from './proxy.js';

describe('createDirectoryQueryCanonicalizer', () => {
  it('canonicalizes directory query params and preserves other params', async () => {
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async (value) => value === '/link/project' ? '/real/project' : value,
    });

    await expect(canonicalize('/session?foo=1&directory=/link/project&bar=2'))
      .resolves.toBe('/session?foo=1&directory=%2Freal%2Fproject&bar=2');
  });

  it('caches directory realpath lookups', async () => {
    let calls = 0;
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => {
        calls += 1;
        return '/real/project';
      },
    });

    await expect(canonicalize('/session?directory=/link/project')).resolves.toBe('/session?directory=%2Freal%2Fproject');
    await expect(canonicalize('/session?directory=/link/project')).resolves.toBe('/session?directory=%2Freal%2Fproject');
    expect(calls).toBe(1);
  });

  it('deduplicates concurrent directory realpath lookups', async () => {
    let calls = 0;
    let release = () => undefined;
    const pending = new Promise((resolve) => {
      release = () => resolve('/real/project');
    });
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => {
        calls += 1;
        return pending;
      },
    });

    const first = canonicalize('/session?directory=/link/project');
    const second = canonicalize('/session?directory=/link/project');
    await Promise.resolve();

    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      '/session?directory=%2Freal%2Fproject',
      '/session?directory=%2Freal%2Fproject',
    ]);
  });

  it('falls back to the original URL when realpath fails', async () => {
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => {
        throw new Error('missing');
      },
    });

    await expect(canonicalize('/session?foo=1&directory=/missing/project'))
      .resolves.toBe('/session?foo=1&directory=/missing/project');
  });

  it('leaves URLs without directory params unchanged', async () => {
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => '/real/project',
    });

    await expect(canonicalize('/session?foo=1')).resolves.toBe('/session?foo=1');
  });
});

describe('createUpstreamAgent', () => {
  it('returns a Node http.Agent', () => {
    const agent = createUpstreamAgent();
    expect(agent).toBeInstanceOf(http.Agent);
  });

  it('disables keep-alive so idle-killed sockets are never reused', () => {
    const agent = createUpstreamAgent();
    expect(agent.options.keepAlive).toBe(false);
    expect(agent.keepAlive).toBe(false);
  });

  it('constructs a fresh agent per call (no module-load side effect / shared singleton)', () => {
    const first = createUpstreamAgent();
    const second = createUpstreamAgent();
    expect(first).not.toBe(second);
  });
});

describe('isRetryableUpstreamError', () => {
  it('is true for the HTTP parser constant error (idle-killed keep-alive socket)', () => {
    expect(isRetryableUpstreamError({ code: 'HPE_INVALID_CONSTANT' })).toBe(true);
  });

  it('is true when the message reports an unexpected HTTP preamble', () => {
    expect(
      isRetryableUpstreamError({ message: 'Parse Error: Expected HTTP/, RTSP/ or ICE/' }),
    ).toBe(true);
  });

  it('is true for a reset connection', () => {
    expect(isRetryableUpstreamError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('is true for a socket hang up', () => {
    expect(isRetryableUpstreamError({ message: 'socket hang up' })).toBe(true);
  });

  it('is false for an unrelated upstream error code', () => {
    expect(isRetryableUpstreamError({ code: 'EBADREQUEST' })).toBe(false);
  });

  it('is false for a generic Error', () => {
    expect(isRetryableUpstreamError(new Error('boom'))).toBe(false);
  });

  it('is false for undefined without throwing', () => {
    expect(isRetryableUpstreamError(undefined)).toBe(false);
  });

  it('is false for null without throwing', () => {
    expect(isRetryableUpstreamError(null)).toBe(false);
  });
});

describe('shouldRetryUpstreamRequest', () => {
  it('retries a retryable error on an idempotent GET that has not yet been retried or responded', () => {
    expect(
      shouldRetryUpstreamRequest({
        err: { code: 'ECONNRESET' },
        method: 'GET',
        alreadyRetried: false,
        headersSent: false,
      }),
    ).toBe(true);
  });

  it('retries HEAD and OPTIONS as well, case-insensitively', () => {
    expect(
      shouldRetryUpstreamRequest({
        err: { code: 'HPE_INVALID_CONSTANT' },
        method: 'head',
        alreadyRetried: false,
        headersSent: false,
      }),
    ).toBe(true);
    expect(
      shouldRetryUpstreamRequest({
        err: { message: 'socket hang up' },
        method: 'OPTIONS',
        alreadyRetried: false,
        headersSent: false,
      }),
    ).toBe(true);
  });

  it('never retries non-idempotent methods, even for a retryable error', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        shouldRetryUpstreamRequest({
          err: { code: 'ECONNRESET' },
          method,
          alreadyRetried: false,
          headersSent: false,
        }),
      ).toBe(false);
    }
  });

  it('never retries a request that was already retried once', () => {
    expect(
      shouldRetryUpstreamRequest({
        err: { code: 'ECONNRESET' },
        method: 'GET',
        alreadyRetried: true,
        headersSent: false,
      }),
    ).toBe(false);
  });

  it('never retries once the response has started (headersSent)', () => {
    expect(
      shouldRetryUpstreamRequest({
        err: { code: 'ECONNRESET' },
        method: 'GET',
        alreadyRetried: false,
        headersSent: true,
      }),
    ).toBe(false);
  });

  it('never retries a non-retryable error on an idempotent method', () => {
    expect(
      shouldRetryUpstreamRequest({
        err: { code: 'EBADREQUEST' },
        method: 'GET',
        alreadyRetried: false,
        headersSent: false,
      }),
    ).toBe(false);
  });

  it('is false (never throws) for missing or garbage input', () => {
    expect(shouldRetryUpstreamRequest()).toBe(false);
    expect(shouldRetryUpstreamRequest({})).toBe(false);
  });
});

// Integration: exercises the REAL apiProxy (registerOpenCodeProxy) against a
// REAL upstream HTTP server that destroys the socket mid-request to reproduce
// the stale-keep-alive failure (proxy client sees ECONNRESET / socket hang up).
// The upstream is the external I/O boundary — no internal module is mocked.
describe('apiProxy stale-socket single retry (integration)', () => {
  const makeUpstream = (behavior) => {
    let count = 0;
    const server = http.createServer((req, res) => {
      count += 1;
      if (behavior(count) === 'destroy') {
        // Simulate an idle-killed / reset upstream socket: no response, hang up.
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, hit: count }));
    });
    return { server, getCount: () => count };
  };

  const startUpstream = (upstream) =>
    new Promise((resolve) => {
      upstream.server.listen(0, '127.0.0.1', () => resolve(upstream.server.address().port));
    });

  const buildApp = (port) => {
    const app = express();
    registerOpenCodeProxy(app, {
      fs,
      os,
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({ openCodePort: port, openCodeBaseUrl: `http://127.0.0.1:${port}` }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: () => `http://127.0.0.1:${port}/`,
      ensureOpenCodeApiPrefix: (value) => value,
    });
    return app;
  };

  it('retries an idempotent GET exactly once on a fresh socket, then succeeds', async () => {
    const upstream = makeUpstream((n) => (n === 1 ? 'destroy' : 'ok'));
    const port = await startUpstream(upstream);
    try {
      const res = await request(buildApp(port)).get('/api/ping');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, hit: 2 });
      expect(upstream.getCount()).toBe(2);
    } finally {
      upstream.server.close();
    }
  });

  it('gives up with 503 after a second failure (exactly one retry, no loop)', async () => {
    const upstream = makeUpstream(() => 'destroy');
    const port = await startUpstream(upstream);
    try {
      const res = await request(buildApp(port)).get('/api/ping');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'OpenCode service unavailable' });
      expect(upstream.getCount()).toBe(2);
    } finally {
      upstream.server.close();
    }
  });

  it('never retries a non-idempotent POST — immediate 503 after a single upstream hit', async () => {
    const upstream = makeUpstream(() => 'destroy');
    const port = await startUpstream(upstream);
    try {
      const res = await request(buildApp(port)).post('/api/ping').send({ hello: 'world' });
      expect(res.status).toBe(503);
      expect(upstream.getCount()).toBe(1);
    } finally {
      upstream.server.close();
    }
  });

  it('does not retry or double-send once upstream headers reached the client (headersSent)', async () => {
    let count = 0;
    const upstream = http.createServer((req, res) => {
      count += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":true');
      // Abort mid-body only AFTER headers have streamed through to the client,
      // so the proxy error handler fires with res.headersSent already true.
      setTimeout(() => res.socket?.destroy(), 50);
    });
    const upstreamPort = await new Promise((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port));
    });
    const server = http.createServer(buildApp(upstreamPort));
    const appPort = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    try {
      const status = await new Promise((resolve) => {
        let captured;
        const timer = setTimeout(() => resolve(captured), 500);
        const settle = (value) => { clearTimeout(timer); resolve(value); };
        const clientReq = http.request(
          { host: '127.0.0.1', port: appPort, path: '/api/ping', method: 'GET' },
          (res) => {
            captured = res.statusCode;
            res.on('data', () => {});
            const finish = () => settle(res.statusCode);
            res.on('end', finish);
            res.on('aborted', finish);
            res.on('close', finish);
            res.on('error', finish);
          },
        );
        clientReq.on('error', () => settle(captured));
        clientReq.end();
      });
      expect(status).toBe(200);
      expect(count).toBe(1);
    } finally {
      server.close();
      upstream.close();
    }
  }, 15000);
});
