/**
 * Authentication and account provisioning: sign-in with lockout, invite-only
 * accounts, and single-use set-password links. Self-registration does not exist.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { HttpError } from '../lib/http-error.js';
import * as tokens from '../repositories/user-tokens.js';
import * as users from '../repositories/users.js';

const BCRYPT_COST = 12;
export const LOCKOUT = Object.freeze({ maxFailures: 5, windowMinutes: 15, lockMinutes: 15 });
const TOKEN_TTL_HOURS = Object.freeze({ invite: 7 * 24, reset: 1 });
const INVALID_CREDENTIALS = 'Email or password is incorrect';
const INVALID_LINK = 'This link is invalid or has expired. Ask an administrator for a new one.';

// Compared against when the email is unknown, so response time does not reveal which accounts exist.
let dummyHash;

export async function authenticate(email, password) {
  const user = await users.findByEmail(email);
  if (!user || !user.is_active || !user.password_hash) {
    dummyHash ??= await bcrypt.hash('placeholder-password-for-timing', BCRYPT_COST);
    await bcrypt.compare(password, dummyHash);
    throw new HttpError(401, INVALID_CREDENTIALS);
  }
  if (user.locked_until && user.locked_until > new Date()) {
    throw new HttpError(423, `Too many failed sign-in attempts. Try again in ${LOCKOUT.lockMinutes} minutes.`);
  }
  if (!(await bcrypt.compare(password, user.password_hash))) {
    await users.recordFailedLogin(user.id, LOCKOUT);
    throw new HttpError(401, INVALID_CREDENTIALS);
  }
  await users.clearFailedLogins(user.id);
  return user;
}

/**
 * Create an account and a one-time link for the person to set their password.
 * No mail server is configured, so the link is returned for the admin to send.
 */
export async function inviteUser({ email, firstName, lastName, role }) {
  return withTransaction(async (client) => {
    let user;
    try {
      user = await users.create({ email, firstName, lastName, role }, client);
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, `A user with email ${email} already exists`);
      throw err;
    }
    const link = await issueLink(user.id, 'invite', client);
    return { user, link };
  });
}

/** New set-password link for an existing user; replaces any outstanding link. */
export async function createPasswordLink(userId) {
  return withTransaction(async (client) => {
    const user = await users.findById(userId, client);
    if (!user) throw new HttpError(404, 'User not found');
    const link = await issueLink(user.id, user.password_hash ? 'reset' : 'invite', client);
    return { user, link };
  });
}

export async function describeToken(token) {
  const row = await tokens.findUsable(hashToken(token));
  if (!row?.is_active) throw new HttpError(400, INVALID_LINK);
  return { email: row.email, firstName: row.first_name, purpose: row.purpose };
}

/** Consume a link, set the password, clear lockout, and end the user's other sessions. */
export async function setPasswordWithToken(token, password) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  return withTransaction(async (client) => {
    const row = await tokens.findUsable(hashToken(token), client, true);
    if (!row?.is_active) throw new HttpError(400, INVALID_LINK);
    await users.setPassword(row.user_id, passwordHash, client);
    await tokens.markUsed(row.id, client);
    await users.deleteSessions(row.user_id, client);
    return users.findById(row.user_id, client);
  });
}

async function issueLink(userId, purpose, db) {
  await tokens.invalidateForUser(userId, db);
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS[purpose] * 3_600_000);
  await tokens.create({ userId, purpose, tokenHash: hashToken(token), expiresAt }, db);
  // The token rides in the URL fragment, which browsers never send to the server,
  // so it cannot end up in access logs or Referer headers.
  return `${config.baseUrl}/set-password.html#token=${token}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
