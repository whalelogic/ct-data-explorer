#!/usr/bin/env node
/**
 * Bootstrap an administrator and print a one-time link to set the password.
 * Usage: npm run create-admin -- --email you@example.org --first Ada --last Lovelace
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/db/pool.js';
import { emailSchema } from '../src/lib/schemas.js';
import { inviteUser } from '../src/services/auth.service.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' } },
});

try {
  const email = emailSchema.safeParse(values.email ?? '');
  if (!email.success || !values.first?.trim() || !values.last?.trim()) {
    throw new Error('Usage: npm run create-admin -- --email you@example.org --first First --last Last');
  }
  const { user, link } = await inviteUser({
    email: email.data,
    firstName: values.first.trim(),
    lastName: values.last.trim(),
    role: 'admin',
  });
  console.log(`Created admin ${user.email}. Set the password within 7 days at:\n${link}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
