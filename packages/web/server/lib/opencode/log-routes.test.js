import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Console } from 'node:console';

import { registerLogRoutes } from './log-routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      post(routePath, ...handlers) {
        routes.set(`POST ${routePath}`, handlers[handlers.length - 1]);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;
  let ended = false;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    end() {
      ended = true;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get ended() {
      return ended;
    },
  };
};

describe('log routes', () => {
  it('writes a bounded diagnostic to the injected logger and returns 204', () => {
    const { app, getRoute } = createRouteRegistry();
    const logger = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerLogRoutes(app, { logger });

    const handler = getRoute('POST', '/api/log');
    const res = createMockResponse();
    handler({ body: { level: 'warn', tag: 'plantuml', message: 'syntax error at line 3' } }, res);

    expect(logger.warn).toHaveBeenCalledWith('[plantuml]', 'syntax error at line 3');
    expect(logger.log).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
  });

  it('defaults the sink to console (stdout) when no logger is injected', () => {
    const { app, getRoute } = createRouteRegistry();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      registerLogRoutes(app, {});
      const handler = getRoute('POST', '/api/log');
      handler({ body: { tag: 'plantuml', message: 'boom' } }, createMockResponse());
      expect(spy).toHaveBeenCalledWith('[plantuml]', 'boom');
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to log level for an unknown level value', () => {
    const { app, getRoute } = createRouteRegistry();
    const logger = { log: vi.fn(), warn: vi.fn() };
    registerLogRoutes(app, { logger });

    const handler = getRoute('POST', '/api/log');
    handler({ body: { level: 'debug', tag: 'plantuml', message: 'msg' } }, createMockResponse());

    expect(logger.log).toHaveBeenCalledWith('[plantuml]', 'msg');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('rejects a missing message with 400 and does not log', () => {
    const { app, getRoute } = createRouteRegistry();
    const logger = { log: vi.fn() };
    registerLogRoutes(app, { logger });

    const handler = getRoute('POST', '/api/log');
    const res = createMockResponse();
    handler({ body: { tag: 'plantuml' } }, res);

    expect(res.statusCode).toBe(400);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('rejects an oversized message with 400 without throwing or logging', () => {
    const { app, getRoute } = createRouteRegistry();
    const logger = { log: vi.fn(), warn: vi.fn() };
    registerLogRoutes(app, { logger });

    const handler = getRoute('POST', '/api/log');
    const res = createMockResponse();
    const huge = 'x'.repeat(5000);
    expect(() => handler({ body: { tag: 'plantuml', message: huge } }, res)).not.toThrow();

    expect(res.statusCode).toBe(400);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-object) body with 400', () => {
    const { app, getRoute } = createRouteRegistry();
    const logger = { log: vi.fn() };
    registerLogRoutes(app, { logger });

    const handler = getRoute('POST', '/api/log');
    const res = createMockResponse();
    handler({ body: undefined }, res);

    expect(res.statusCode).toBe(400);
    expect(logger.log).not.toHaveBeenCalled();
  });
});

// Boundary/integration coverage: exercise the registered /api/log route through a
// REAL Express app with REAL express.json body parsing and a REAL HTTP request
// (supertest). The default sink is `console`, so we capture process.stdout.write
// (fd 1) and process.stderr.write (fd 2) directly to PROVE the diagnostic lands on
// stdout — not stderr. This is the fd-level guard: if the level regressed to 'warn'
// (console.warn → stderr), the stdout assertion below would fail.
describe('log routes (integration: real express + stdout capture)', () => {
  const createApp = () => {
    const app = express();
    // Pass the real express so registerLogRoutes wires the real json parser.
    // Inject Node's REAL Console bound to the actual process streams (not the
    // vitest-patched global console, which intercepts and rewrites output).
    // Node's Console routes .log/.info → process.stdout (fd 1) and
    // .warn/.error → process.stderr (fd 2), so capturing process.stdout.write
    // below proves fd-1 routing with genuine Node I/O behavior.
    const logger = new Console(process.stdout, process.stderr);
    registerLogRoutes(app, { express, logger });
    return app;
  };

  const captureStdio = async (run) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk, ...rest) => {
      stdoutChunks.push(String(chunk));
      return realStdoutWrite(chunk, ...rest);
    };
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(String(chunk));
      return realStderrWrite(chunk, ...rest);
    };
    try {
      const result = await run();
      return { result, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
    } finally {
      process.stdout.write = realStdoutWrite;
      process.stderr.write = realStderrWrite;
    }
  };

  it('writes a plantuml diagnostic to process stdout (fd 1) and returns 204', async () => {
    const { result, stdout, stderr } = await captureStdio(() =>
      request(createApp())
        .post('/api/log')
        // Exactly what the client now sends by default (level 'log' → console.log → stdout).
        .send({ level: 'log', tag: 'plantuml', message: 'syntax error at line 3' }),
    );

    expect(result.status).toBe(204);
    // The line MUST appear on stdout (fd 1)...
    expect(stdout).toContain('[plantuml]');
    expect(stdout).toContain('syntax error at line 3');
    // ...and MUST NOT have been routed to stderr (fd 2). This fails if the sink
    // regresses to console.warn/console.error.
    expect(stderr).not.toContain('syntax error at line 3');
  });

  it('routes a payload with no explicit level to stdout via the route default', async () => {
    const { result, stdout, stderr } = await captureStdio(() =>
      request(createApp())
        .post('/api/log')
        .send({ tag: 'plantuml', message: 'no-level default goes to stdout' }),
    );

    expect(result.status).toBe(204);
    expect(stdout).toContain('[plantuml]');
    expect(stdout).toContain('no-level default goes to stdout');
    expect(stderr).not.toContain('no-level default goes to stdout');
  });

  it('rejects an oversized message with 400 and writes nothing to stdout', async () => {
    const huge = 'x'.repeat(5000);
    const { result, stdout } = await captureStdio(() =>
      request(createApp()).post('/api/log').send({ tag: 'plantuml', message: huge }),
    );

    expect(result.status).toBe(400);
    expect(stdout).not.toContain('xxxxx');
  });

  it('rejects a malformed (non-object) body with 400', async () => {
    const { result } = await captureStdio(() =>
      request(createApp())
        .post('/api/log')
        .set('Content-Type', 'application/json')
        .send('"not-an-object"'),
    );

    expect(result.status).toBe(400);
  });
});
