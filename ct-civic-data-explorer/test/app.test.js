/** HTTP tests that need no database: routing, auth boundary, validation and static assets. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import session from 'express-session';
import request from 'supertest';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');
const app = createApp({ sessionStore: new session.MemoryStore() });
after(() => pool.end());

test('account-only APIs require sign-in', async () => {
  for (const path of ['/api/auth/me', '/api/reports', '/api/reports/1', '/api/reports/1/pdf',
    '/api/reports/by-slug/saved-report', '/api/datasets?scope=private', '/api/datasets/1/curation',
    '/api/datasets/1/presentation', '/api/datasets/1/row-label', '/api/indicators',
    '/api/users', '/api/ai-settings', '/api/admin/usage', '/api/not-a-route']) {
    const res = await request(app).get(path).expect(401);
    assert.equal(res.body.error, 'Please sign in');
  }
});

test('guests need a CSRF token for report and chat requests', async () => {
  for (const path of ['/api/reports/comparison-options', '/api/reports/preview', '/api/reports/pdf',
    '/api/reports/summary', '/api/assistant']) {
    const res = await request(app).post(path).send({}).expect(403);
    assert.match(res.body.error, /Reload it and try again/);
  }
  for (const path of ['/api/datasets/private/inspect', '/api/datasets/private', '/api/reports',
    '/api/reports/1/duplicate']) {
    await request(app).post(path).send({}).expect(401);
  }
});

test('guest chat and report summaries share a per-network request limit', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const guest = request.agent(app);
  const { body: session } = await guest.get('/api/auth/session').expect(200);
  assert.equal(session.user, null);
  assert.ok(session.csrfToken);
  for (let i = 0; i < 10; i += 1) {
    await guest.post('/api/assistant').set('X-CSRF-Token', session.csrfToken).send({}).expect(400);
  }

  const anotherGuest = request.agent(app);
  const { body: secondSession } = await anotherGuest.get('/api/auth/session').expect(200);
  const response = await anotherGuest.post('/api/reports/summary')
    .set('X-CSRF-Token', secondSession.csrfToken).send({}).expect(429);
  assert.match(response.body.error, /guest AI limit/);
});

test('sign-in validates input before touching the database', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email', password: '' }).expect(400);
  assert.equal(res.body.error, 'Enter a valid email address');
});

test('malformed JSON gets a clear 400', async () => {
  const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":').expect(400);
  assert.equal(res.body.error, 'Request body is not valid JSON');
});

test('pages, shared modules and Chart.js are served locally with security headers', async () => {
  const page = await request(app).get('/login').expect(200);
  assert.ok(page.headers['content-security-policy']);
  await request(app).get('/shared/format.js').expect(200).expect('Content-Type', /javascript/);
  await request(app).get('/vendor/chart.js/chart.umd.min.js').expect(200);
});


test('clean page URLs serve HTML and legacy URLs preserve query parameters', async () => {
  for (const page of ['index', 'login', 'set-password', 'explore', 'builder', 'dataset', 'town', 'admin', 'users', 'chat', 'ai-settings']) {
    const cleanPath = page === 'index' ? '/' : `/${page}`;
    await request(app).get(cleanPath).expect(200).expect('Content-Type', /html/);
    const query = '?dataset=1&town=New%20Haven&field=pop&field=households&embed=1';
    await request(app).get(`/${page}.html${query}`)
      .expect(308).expect('Location', cleanPath + query);
  }
  for (const path of ['/datasets/mine', '/datasets/new', '/admin/usage']) {
    await request(app).get(path).expect(200).expect('Content-Type', /html/);
  }
  await request(app).get('/missing-page').expect(404);
  await request(app).get('/js/dashboard.js').expect(200).expect('Content-Type', /javascript/);
});
