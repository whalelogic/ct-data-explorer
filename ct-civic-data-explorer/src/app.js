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
import { apiNotFound, errorHandler, pageNotFound } from './middleware/errors.js';
import { apiLimiter } from './middleware/rate-limits.js';
import { requestId } from './middleware/request-id.js';
import { requestLog } from './middleware/request-log.js';
import { authRouter } from './routes/auth.routes.js';
import { reportsRouter } from './routes/reports.routes.js';
import { embedRouter } from './routes/embed.routes.js';
import { datasetsRouter } from './routes/datasets.routes.js';
import { indicatorsRouter } from './routes/indicators.routes.js';
import { townsRouter } from './routes/towns.routes.js';
import { usersRouter } from './routes/users.routes.js';
import { assistantRouter } from './routes/assistant.routes.js';
import { auditRouter } from './routes/audit.routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * @param {{ sessionStore?: import('express-session').Store, logRequests?: boolean }} [options]
 */
export function createApp({ sessionStore, logRequests = config.env !== 'test' } = {}) {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);

  app.disable('x-powered-by');
  app.use(requestId({ trustForwarded: config.trustProxy }));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Rewriting every request to https:// would break a deployment served over plain
          // HTTP (COOKIE_SECURE=false), so the directive is sent only on HTTPS deployments.
          upgradeInsecureRequests: config.session.cookieSecure ? [] : null,
        },
      },
      // Likewise, only tell browsers to insist on HTTPS when the site is served that way.
      strictTransportSecurity: config.session.cookieSecure,
    }),
  );
  if (logRequests) app.use(requestLog);

  // Keep filenames private to routing; old bookmarks retain their query strings.
  const publicDirectory = path.join(here, '..', 'public');
  const pages = ['login', 'set-password', 'explore', 'builder', 'dataset', 'town', 'admin', 'users', 'account'];
  for (const page of ['index', ...pages]) {
    const pageUrl = page === 'index' ? '/' : `/${page}`;
    app.get(`/${page}.html`, (req, res) => {
      const queryStart = req.originalUrl.indexOf('?');
      const query = queryStart === -1 ? '' : req.originalUrl.slice(queryStart);
      res.redirect(308, pageUrl + query);
    });
    app.get(pageUrl, (_req, res) => res.sendFile(`${page}.html`, { root: publicDirectory }));
  }

  // Adding a dataset has its own page; the admin page is for finding and managing datasets.
  app.get('/admin/datasets/new', (_req, res) => res.sendFile('upload.html', { root: publicDirectory }));
  app.get('/admin/activity', (_req, res) => res.sendFile('activity.html', { root: publicDirectory }));

  // Saved reports have readable addresses. This page loads the report through the API,
  // which requires sign-in; /embed/<report>.html is the public version.
  app.get(/^\/explore\/([a-z0-9]+(?:-[a-z0-9]+)*)\.html$/, (_req, res) => {
    res.sendFile('report.html', { root: publicDirectory });
  });

  // Public copies of saved reports that other sites may frame.
  app.use('/embed', embedRouter);

  // Static assets. Pages are plain HTML; the API is the security boundary.
  app.use(express.static(path.join(here, '..', 'public')));
  app.use('/shared', express.static(path.join(here, 'shared')));
  app.use('/vendor/chart.js', express.static(path.dirname(require.resolve('chart.js'))));

  app.get('/healthz', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
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
  app.use('/api', requireAuth, apiLimiter, csrfProtection);
  app.use('/api/towns', townsRouter);
  app.use('/api/indicators', indicatorsRouter);
  app.use('/api/datasets', datasetsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/assistant', assistantRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api', apiNotFound);
  app.use(pageNotFound);

  app.use(errorHandler);
  return app;
}
