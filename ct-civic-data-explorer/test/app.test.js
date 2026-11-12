/** HTTP tests that need no database: routing, auth boundary, validation and static assets. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import session from 'express-session';
import request from 'supertest';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../src/app.js');
const app = createApp({ sessionStore: new session.MemoryStore() });

test('API routes require a session', async () => {
  for (const path of ['/api/reports', '/api/towns', '/api/users', '/api/not-a-route']) {
    const res = await request(app).get(path).expect(401);
    assert.equal(res.body.error, 'Please sign in');
  }
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
  for (const page of ['index', 'login', 'set-password', 'explore', 'builder', 'dataset', 'town', 'admin', 'users', 'account']) {
    const cleanPath = page === 'index' ? '/' : `/${page}`;
    await request(app).get(cleanPath).expect(200).expect('Content-Type', /html/);
    const query = '?dataset=1&town=New%20Haven&field=pop&field=households&embed=1';
    await request(app).get(`/${page}.html${query}`)
      .expect(308).expect('Location', cleanPath + query);
  }
  await request(app).get('/js/dashboard.js').expect(200).expect('Content-Type', /javascript/);
  for (const adminPage of ['/admin/datasets/new', '/admin/activity']) {
    await request(app).get(adminPage).expect(200).expect('Content-Type', /html/);
  }
});

test('unknown page addresses get a helpful 404 page; other clients get plain text', async () => {
  const page = await request(app).get('/missing-page').set('Accept', 'text/html').expect(404).expect('Content-Type', /html/);
  assert.match(page.text, /couldn’t find that page/);
  await request(app).get('/missing-page').set('Accept', 'application/json').expect(404).expect('Content-Type', /text\/plain/);
  await request(app).post('/missing-page').expect(404);
});

test('embed pages may be framed by other sites; every other page may not', async () => {
  const embed = await request(app).get('/embed/hartford-housing.html').expect(200).expect('Content-Type', /html/);
  assert.equal(embed.headers['x-frame-options'], undefined);
  assert.match(embed.headers['content-security-policy'], /frame-ancestors \*(;|$)/);
  assert.equal(embed.headers['set-cookie'], undefined);

  const page = await request(app).get('/explore/hartford-housing.html').expect(200);
  assert.equal(page.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/);

  await request(app).get('/embed/Not_A_Slug.html').set('Accept', 'application/json').expect(404);
  await request(app).post('/embed/hartford-housing.json').expect(404);
});

test('every response carries a request id and hides the framework', async () => {
  const first = await request(app).get('/login').expect(200);
  const second = await request(app).get('/api/reports').expect(401);
  assert.match(first.headers['x-request-id'], /^[0-9a-f]{12}$/);
  assert.match(second.headers['x-request-id'], /^[0-9a-f]{12}$/);
  assert.notEqual(first.headers['x-request-id'], second.headers['x-request-id']);
  assert.equal(first.headers['x-powered-by'], undefined);
  // An id supplied by the client is not trusted unless the app sits behind a proxy.
  const spoofed = await request(app).get('/login').set('X-Request-Id', 'client-chosen-id');
  assert.notEqual(spoofed.headers['x-request-id'], 'client-chosen-id');
});

test('changing a password and reading the activity log require a session', async () => {
  await request(app).post('/api/auth/password').send({ currentPassword: 'x', newPassword: 'y'.repeat(12) }).expect(401);
  await request(app).get('/api/audit').expect(401);
});
