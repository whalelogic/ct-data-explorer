/** HTTP tests that need no database: routing, auth boundary, validation and static assets. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import session from 'express-session';
import request from 'supertest';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../src/app.js');
const app = createApp({ sessionStore: new session.MemoryStore() });

test('API routes require a session', async () => {
  for (const path of ['/api/cards', '/api/towns', '/api/users', '/api/not-a-route']) {
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
  const page = await request(app).get('/login.html').expect(200);
  assert.ok(page.headers['content-security-policy']);
  await request(app).get('/shared/format.js').expect(200).expect('Content-Type', /javascript/);
  await request(app).get('/vendor/chart.js/chart.umd.min.js').expect(200);
});
