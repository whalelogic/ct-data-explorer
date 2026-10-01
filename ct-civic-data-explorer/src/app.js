/**
 * Express application assembly. Middleware order (SRS §5.4): logging, body
 * parsing, session, authentication, CSRF, then per-route role checks and validation.
 * Kept apart from server.js so tests can drive the app with supertest and inject a
 * session store.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { MySqlSessionStore } from './db/session-store.js';
import { requireAuth } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { apiNotFound, errorHandler } from './middleware/errors.js';
import { requestLog } from './middleware/request-log.js';
import { authRouter } from './routes/auth.routes.js';
import { cardsRouter } from './routes/cards.routes.js';
import { datasetsRouter } from './routes/datasets.routes.js';
import { indicatorsRouter } from './routes/indicators.routes.js';
import { townsRouter } from './routes/towns.routes.js';
import { usersRouter } from './routes/users.routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * @param {{ sessionStore?: import('express-session').Store, logRequests?: boolean }} [options]
 */
export function createApp({ sessionStore, logRequests = config.env !== 'test' } = {}) {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(helmet());
  if (logRequests) app.use(requestLog);

  // Static assets. Pages are plain HTML; the API is the security boundary.
  app.use(express.static(path.join(here, '..', 'public')));
  app.use('/shared', express.static(path.join(here, 'shared')));
  app.use('/vendor/chart.js', express.static(path.dirname(require.resolve('chart.js'))));

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database unavailable' });
    }
  });

  app.use(
    '/api',
    express.json({ limit: '200kb' }),
    session({
      name: config.session.cookieName,
      secret: config.session.secret,
      store: sessionStore ?? new MySqlSessionStore(),
      resave: false,
      saveUninitialized: false,
      rolling: true, // every response renews the cookie, so maxAge acts as the idle timeout
      cookie: {
        httpOnly: true,
        secure: config.session.cookieSecure,
        sameSite: 'lax',
        maxAge: config.session.idleTimeoutMs,
      },
    }),
  );

  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth, csrfProtection);
  app.use('/api/towns', townsRouter);
  app.use('/api/indicators', indicatorsRouter);
  app.use('/api/datasets', datasetsRouter);
  app.use('/api/cards', cardsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api', apiNotFound);

  app.use(errorHandler);
  return app;
}
