/**
 * Accounts and the audit trail against a migrated database:
 *   CT_CURATION_INTEGRATION=1 npm test
 * Every row is created under a random tag and removed afterwards.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, test } from 'node:test';
import bcrypt from 'bcryptjs';
import session from 'express-session';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const enabled = process.env.CT_CURATION_INTEGRATION === '1';
const testTag = crypto.randomBytes(6).toString('hex');
const userIds = [];

after(async () => {
  if (enabled) {
    if (userIds.length > 0) {
      await pool.query('DELETE FROM audit_log WHERE actor_id IN (?) OR actor_email LIKE ?', [userIds, `%-${testTag}@example.invalid`]);
      await pool.query('DELETE FROM users WHERE id IN (?)', [userIds]);
    }
    await pool.end();
  }
});

async function createUser(role, password, name = role) {
  const email = `${name}-${testTag}@example.invalid`;
  const result = await pool.query(
    'INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES (?, ?, ?, ?, ?)',
    [email, await bcrypt.hash(password, 4), 'Account test', role, role],
  );
  userIds.push(result.insertId);
  return { id: result.insertId, email };
}

async function signIn(app, email, password) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').send({ email, password }).expect(200);
  return { agent, csrfToken: response.body.csrfToken };
}

test('a person can change their own password, which signs out their other sessions', { skip: !enabled }, async () => {
  const app = createApp({ sessionStore: undefined, logRequests: false });
  const oldPassword = crypto.randomBytes(18).toString('base64url');
  const newPassword = crypto.randomBytes(18).toString('base64url');
  const staff = await createUser('staff', oldPassword);

  const here = await signIn(app, staff.email, oldPassword);
  const elsewhere = await signIn(app, staff.email, oldPassword);
  const change = (body, client = here) => client.agent.post('/api/auth/password').set('X-CSRF-Token', client.csrfToken).send(body);

  // Without the CSRF token, with the wrong current password, too short, and unchanged.
  await here.agent.post('/api/auth/password').send({ currentPassword: oldPassword, newPassword }).expect(403);
  const wrong = await change({ currentPassword: 'not-my-password', newPassword }).expect(400);
  assert.equal(wrong.body.error, 'Your current password is incorrect');
  const short = await change({ currentPassword: oldPassword, newPassword: 'short' }).expect(400);
  assert.equal(short.body.error, 'Password must be at least 12 characters');
  const same = await change({ currentPassword: oldPassword, newPassword: oldPassword }).expect(400);
  assert.match(same.body.error, /different from your current one/);

  const changed = await change({ currentPassword: oldPassword, newPassword }).expect(200);
  assert.equal(changed.body.user.email, staff.email);
  assert.notEqual(changed.body.csrfToken, here.csrfToken, 'the new session has its own CSRF token');

  // This browser stays signed in; the other device does not; only the new password works.
  await here.agent.get('/api/auth/me').expect(200);
  await elsewhere.agent.get('/api/auth/me').expect(401);
  await request(app).post('/api/auth/login').send({ email: staff.email, password: oldPassword }).expect(401);
  await request(app).post('/api/auth/login').send({ email: staff.email, password: newPassword }).expect(200);
});

test('the activity log records sign-ins and account changes, for administrators only', { skip: !enabled }, async () => {
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  const password = crypto.randomBytes(18).toString('base64url');
  const admin = await createUser('admin', password);
  const inviteEmail = `invited-${testTag}@example.invalid`;

  await request(app).post('/api/auth/login').send({ email: admin.email, password: 'wrong-password' }).expect(401);
  const client = await signIn(app, admin.email, password);
  const write = (method, path, body) => client.agent[method](path).set('X-CSRF-Token', client.csrfToken).send(body);

  const invited = await write('post', '/api/users', { email: inviteEmail, firstName: 'Ina', lastName: 'Vited', role: 'staff' }).expect(201);
  userIds.push(invited.body.user.id);
  await write('patch', `/api/users/${invited.body.user.id}`, { role: 'admin' }).expect(200);
  await write('patch', `/api/users/${invited.body.user.id}`, { role: 'admin' }).expect(200); // no change, no entry
  await write('patch', `/api/users/${invited.body.user.id}`, { isActive: false }).expect(200);
  await write('patch', '/api/users/999999999', { isActive: false }).expect(404);

  const log = await client.agent.get('/api/audit?limit=200').expect(200);
  const mine = log.body.entries.filter((entry) => entry.actor?.email === admin.email);
  // Newest first.
  assert.deepEqual(mine.map((entry) => entry.action), [
    'user.deactivated', 'user.role_changed', 'user.invited', 'auth.signed_in', 'auth.sign_in_failed',
  ]);
  const roleChange = mine.find((entry) => entry.action === 'user.role_changed');
  assert.deepEqual(roleChange.details, { from: 'staff', to: 'admin' });
  assert.deepEqual(roleChange.target, { type: 'user', id: invited.body.user.id, label: inviteEmail });
  assert.equal(mine.at(-1).actor.id, null, 'a failed sign-in is not attributed to an account');
  assert.equal(mine[0].actor.name, 'Account test admin');
  assert.ok(!JSON.stringify(log.body).includes(password), 'passwords are never recorded');

  // Filtering and paging.
  const people = await client.agent.get('/api/audit?category=user&limit=2').expect(200);
  assert.equal(people.body.entries.length, 2);
  assert.ok(people.body.entries.every((entry) => entry.action.startsWith('user.')));
  assert.equal(people.body.hasMore, true);
  const older = await client.agent.get(`/api/audit?category=user&limit=2&before=${people.body.entries.at(-1).id}`).expect(200);
  assert.ok(older.body.entries.every((entry) => entry.id < people.body.entries.at(-1).id));
  await client.agent.get('/api/audit?category=nonsense').expect(400);

  // Staff cannot read it.
  const staffPassword = crypto.randomBytes(18).toString('base64url');
  const staff = await createUser('staff', staffPassword, 'reader');
  const staffClient = await signIn(app, staff.email, staffPassword);
  await staffClient.agent.get('/api/audit').expect(403);
});
