import http from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  createDirectoryQueryCanonicalizer,
  createUpstreamAgent,
  isRetryableUpstreamError,
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
