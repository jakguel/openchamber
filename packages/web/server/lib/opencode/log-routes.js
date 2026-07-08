// Thin runtime log endpoint. The shared UI posts a small, bounded diagnostic
// here fire-and-forget; the server writes it to its own stdout via console.* so
// it lands in the captured OpenChamber logfile (web:
// ~/.config/openchamber/logs/openchamber-{port}.log) and, on the desktop
// in-process server, in electron-log's main.log (main.mjs routes console →
// main.log). The endpoint never trusts the payload beyond a short tag + a
// length-bounded message, and never echoes request metadata or secrets.

const MAX_TAG_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 4096;
const VALID_LEVELS = new Set(['log', 'info', 'warn', 'error']);

export const registerLogRoutes = (app, dependencies = {}) => {
  const { express, logger = console } = dependencies;

  // Bound the request body at the parser level too (defense in depth); when no
  // express is supplied (unit tests exercising the handler directly) fall back
  // to a passthrough so the real handler still runs.
  const parseJson = express
    ? express.json({ limit: '16kb' })
    : (_req, _res, next) => next();

  app.post('/api/log', parseJson, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'invalid payload' });
    }

    const tag = typeof body.tag === 'string' ? body.tag : '';
    const message = typeof body.message === 'string' ? body.message : '';
    if (tag.length === 0 || message.length === 0) {
      return res.status(400).json({ error: 'tag and message are required' });
    }
    if (tag.length > MAX_TAG_LENGTH || message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: 'payload too large' });
    }

    const level = typeof body.level === 'string' && VALID_LEVELS.has(body.level) ? body.level : 'log';
    const write = typeof logger[level] === 'function' ? logger[level] : logger.log;
    write.call(logger, `[${tag}]`, message);

    return res.status(204).end();
  });
};
