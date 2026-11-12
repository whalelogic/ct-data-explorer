/** Startup configuration checks: every problem is reported at once, in words an operator can act on. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';

const PRODUCTION = Object.freeze({
  NODE_ENV: 'production',
  SESSION_SECRET: 'a'.repeat(64),
  APP_BASE_URL: 'https://data.example.org/',
  TRUST_PROXY: 'true',
  DB_USER: 'ctdata',
  DB_PASSWORD: 'secret',
  DB_NAME: 'civicdata',
});

function problemsFor(env) {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  return [];
}

test('development needs no settings and uses a throwaway session secret', () => {
  const { config, warnings } = loadConfig({});
  assert.equal(config.env, 'development');
  assert.equal(config.port, 3000);
  assert.equal(config.baseUrl, 'http://localhost:3000');
  assert.equal(config.session.cookieSecure, false);
  assert.equal(config.session.secret.length, 64);
  assert.equal(config.ai.provider, 'none');
  assert.deepEqual(warnings, []);
});

test('a complete production environment loads without warnings', () => {
  const { config, warnings } = loadConfig(PRODUCTION);
  assert.equal(config.isProduction, true);
  assert.equal(config.baseUrl, 'https://data.example.org');
  assert.equal(config.session.cookieSecure, true);
  assert.equal(config.trustProxy, true);
  assert.deepEqual(warnings, []);
});

test('production reports every missing setting together', () => {
  const problems = problemsFor({ NODE_ENV: 'production' });
  for (const name of ['SESSION_SECRET', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    assert.ok(problems.some((problem) => problem.startsWith(name)), `expected a problem for ${name}`);
  }
});

test('a short production session secret is rejected', () => {
  const problems = problemsFor({ ...PRODUCTION, SESSION_SECRET: 'too-short' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /at least 32 characters/);
});

test('malformed numbers, booleans, URLs and providers are named', () => {
  const problems = problemsFor({
    PORT: 'http',
    DB_PORT: '70000',
    DB_POOL_MAX: '0',
    COOKIE_SECURE: 'yes',
    APP_BASE_URL: 'data.example.org',
    AI_PROVIDER: 'openai',
  });
  for (const name of ['PORT', 'DB_PORT', 'DB_POOL_MAX', 'COOKIE_SECURE', 'APP_BASE_URL', 'AI_PROVIDER']) {
    assert.ok(problems.some((problem) => problem.startsWith(name)), `expected a problem for ${name}`);
  }
});

test('cookie settings that would silently break sign-in produce warnings', () => {
  const overHttp = loadConfig({ ...PRODUCTION, APP_BASE_URL: 'http://data.example.org' });
  assert.ok(overHttp.warnings.some((warning) => warning.includes('COOKIE_SECURE is true but APP_BASE_URL is http://')));

  const noProxyTrust = loadConfig({ ...PRODUCTION, TRUST_PROXY: 'false' });
  assert.ok(noProxyTrust.warnings.some((warning) => warning.includes('TRUST_PROXY')));

  const noBaseUrl = loadConfig({ ...PRODUCTION, APP_BASE_URL: undefined, COOKIE_SECURE: 'false' });
  assert.ok(noBaseUrl.warnings.some((warning) => warning.includes('APP_BASE_URL is not set')));
});

test('embed pages may be framed anywhere by default, or only by listed origins', () => {
  assert.deepEqual(loadConfig({}).config.embed.frameAncestors, ['*']);
  const listed = loadConfig({ EMBED_FRAME_ANCESTORS: 'https://www.example.org, https://example.org' });
  assert.deepEqual(listed.config.embed.frameAncestors, ['https://www.example.org', 'https://example.org']);
  assert.match(problemsFor({ EMBED_FRAME_ANCESTORS: "'unsafe'; script-src *" })[0], /EMBED_FRAME_ANCESTORS/);
});
