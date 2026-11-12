/**
 * Runtime configuration, read once from the environment (.env in development).
 *
 * Every setting is checked at startup and all problems are reported together, so a
 * misconfigured deployment stops with a list of what to fix instead of failing later
 * on the first request that needs the missing value.
 */
import 'dotenv/config';
import crypto from 'node:crypto';

const AI_PROVIDERS = ['none', 'anthropic'];
const MIN_SESSION_SECRET_LENGTH = 32;

/** Thrown when the environment cannot produce a usable configuration. */
export class ConfigError extends Error {
  /** @param {string[]} problems one line per setting that needs fixing */
  constructor(problems) {
    super(`Configuration problems:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Build the configuration from an environment object.
 * @param {Record<string, string | undefined>} source usually process.env
 * @returns {{ config: object, warnings: string[] }}
 * @throws {ConfigError} listing every problem found
 */
export function loadConfig(source = process.env) {
  const problems = [];
  const warnings = [];
  const env = source.NODE_ENV ?? 'development';
  const isProduction = env === 'production';

  function integer(name, fallback, { min, max }) {
    const raw = source[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
      return fallback;
    }
    return value;
  }

  function boolean(name, fallback) {
    const raw = source[name];
    if (raw === undefined || raw === '') return fallback;
    if (raw !== 'true' && raw !== 'false') {
      problems.push(`${name} must be true or false (got "${raw}")`);
      return fallback;
    }
    return raw === 'true';
  }

  const port = integer('PORT', 3000, { min: 1, max: 65535 });
  const trustProxy = boolean('TRUST_PROXY', false);
  const cookieSecure = boolean('COOKIE_SECURE', isProduction);

  let secret = source.SESSION_SECRET;
  if (!secret) {
    if (isProduction) {
      problems.push('SESSION_SECRET is required in production. Generate one with: openssl rand -hex 32');
    }
    // Development fallback: every restart invalidates existing sessions.
    secret = crypto.randomBytes(32).toString('hex');
  } else if (isProduction && secret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters. Generate one with: openssl rand -hex 32`);
  }

  let baseUrl = source.APP_BASE_URL || `http://localhost:${port}`;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    baseUrl = baseUrl.replace(/\/+$/, '');
    if (isProduction && !source.APP_BASE_URL) {
      warnings.push(`APP_BASE_URL is not set, so invite and password links will point at ${baseUrl}`);
    }
    // A Secure cookie is never sent over plain HTTP, so sign-in would appear to do nothing.
    if (cookieSecure && parsed.protocol === 'http:') {
      warnings.push('COOKIE_SECURE is true but APP_BASE_URL is http://. Browsers will not send the session cookie; use HTTPS or set COOKIE_SECURE=false');
    }
    if (cookieSecure && parsed.protocol === 'https:' && !trustProxy) {
      warnings.push('COOKIE_SECURE is true and TRUST_PROXY is false. If HTTPS ends at a reverse proxy, set TRUST_PROXY=true or the session cookie will not be issued');
    }
  } catch {
    problems.push(`APP_BASE_URL must be a full http(s) URL such as https://data.example.org (got "${baseUrl}")`);
  }

  if (isProduction) {
    for (const name of ['DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
      if (!source[name]) problems.push(`${name} is required`);
    }
  }

  const provider = source.AI_PROVIDER || 'none';
  if (!AI_PROVIDERS.includes(provider)) {
    problems.push(`AI_PROVIDER must be one of: ${AI_PROVIDERS.join(', ')} (got "${provider}")`);
  }

  // Sites allowed to frame /embed pages: "*" for any site, or a list of origins.
  const frameAncestors = (source.EMBED_FRAME_ANCESTORS || '*').split(/[\s,]+/).filter(Boolean);
  for (const ancestor of frameAncestors) {
    if (ancestor !== '*' && !/^https?:\/\/[a-z0-9.*-]+(:\d+)?$/i.test(ancestor)) {
      problems.push(`EMBED_FRAME_ANCESTORS must be * or origins such as https://www.example.org (got "${ancestor}")`);
    }
  }

  const config = Object.freeze({
    env,
    isProduction,
    port,
    baseUrl,
    trustProxy,
    db: Object.freeze({
      host: source.DB_HOST || 'localhost',
      port: integer('DB_PORT', 3306, { min: 1, max: 65535 }),
      user: source.DB_USER,
      password: source.DB_PASSWORD,
      database: source.DB_NAME,
      max: integer('DB_POOL_MAX', 10, { min: 1, max: 500 }),
    }),
    session: Object.freeze({
      cookieName: 'ctde.sid',
      secret,
      cookieSecure,
      idleTimeoutMs: 30 * 60 * 1000,
      absoluteTimeoutMs: 8 * 60 * 60 * 1000,
    }),
    embed: Object.freeze({ frameAncestors: Object.freeze(frameAncestors) }),
    uploads: Object.freeze({ maxBytes: 10 * 1024 * 1024 }),
    ai: Object.freeze({
      provider, // 'none' | 'anthropic'
      model: source.AI_MODEL || 'claude-opus-5-5',
      effort: source.AI_EFFORT || 'low',
      timeoutMs: 15_000, // SRS §4.3: drafting completes in under 15 seconds
    }),
  });

  if (problems.length > 0) throw new ConfigError(problems);
  return { config, warnings };
}

function loadOrExit() {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // A list of settings to fix is more useful to an operator than a stack trace.
    console.error(`${err.message}\nSee .env.example for every setting.`);
    process.exit(1);
  }
}

const loaded = loadOrExit();

export const config = loaded.config;
/** Settings that work but probably are not what the operator intended; logged at startup. */
export const configWarnings = Object.freeze(loaded.warnings);
