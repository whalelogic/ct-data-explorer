/**
 * Runtime configuration, read once from the environment (.env in development).
 */
import 'dotenv/config';
import crypto from 'node:crypto';

const env = process.env.NODE_ENV ?? 'development';
const isProduction = env === 'production';
const port = Number.parseInt(process.env.PORT ?? '3000', 10);

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isProduction) throw new Error('SESSION_SECRET must be set in production');
  // Development fallback: every restart invalidates existing sessions.
  return crypto.randomBytes(32).toString('hex');
}

export const config = Object.freeze({
  env,
  isProduction,
  port,
  baseUrl: (process.env.APP_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  trustProxy: process.env.TRUST_PROXY === 'true',
  db: Object.freeze({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: Number.parseInt(process.env.DB_POOL_MAX ?? '10', 10),
  }),
  session: Object.freeze({
    cookieName: 'ctde.sid',
    secret: sessionSecret(),
    cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction,
    idleTimeoutMs: 30 * 60 * 1000,
    absoluteTimeoutMs: 8 * 60 * 60 * 1000,
  }),
  uploads: Object.freeze({ maxBytes: 10 * 1024 * 1024 }),
  ai: Object.freeze({
    provider: process.env.AI_PROVIDER ?? 'none', // 'none' | 'anthropic'
    model: process.env.AI_MODEL ?? 'claude-opus-5',
    effort: process.env.AI_EFFORT ?? 'low',
    timeoutMs: 15_000, // SRS §4.3: drafting completes in under 15 seconds
  }),
});
