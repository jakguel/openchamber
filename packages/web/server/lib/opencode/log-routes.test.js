import { describe, expect, it, vi } from 'vitest';

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
