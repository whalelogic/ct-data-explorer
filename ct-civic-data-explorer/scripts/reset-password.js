#!/usr/bin/env node
/**
 * Reset an existing account's password, for when nobody can sign in to use the
 * admin UI. Prefer scripts/reset-password.sh, which prompts for the password
 * without echoing it and never puts it on a command line.
 *
 * Usage:
 *   node scripts/reset-password.js --email you@example.org
 *   printf '%s' "$password" | node scripts/reset-password.js --email you@example.org --password-stdin
 *
 * Without --password-stdin this prints a one-time set-password link, exactly
 * like the "send a new link" action in the admin UI. With it, the link is
 * issued and consumed here, so the reset goes through the same code path as a
 * user setting their own password: bcrypt at the app's cost, lockout cleared,
 * the account's other sessions ended, and any outstanding link invalidated.
 */
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { emailSchema, newPasswordSchema } from '../src/lib/schemas.js';
import * as users from '../src/repositories/users.js';
import { createPasswordLink, setPasswordWithToken } from '../src/services/auth.service.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, 'password-stdin': { type: 'boolean', default: false } },
});

try {
  const email = emailSchema.safeParse(values.email ?? '');
  if (!email.success) {
    throw new Error('Usage: node scripts/reset-password.js --email you@example.org [--password-stdin]');
  }

  if (!config.db.password) {
    throw new Error(
      'No database password is configured. Run this from a checkout with a .env file, or set DB_PASSWORD in the environment.',
    );
  }

  const user = await users.findByEmail(email.data);
  if (!user) throw new Error(`No account exists for ${email.data}`);
  if (!user.is_active) {
    console.warn(`Warning: ${user.email} is deactivated and still cannot sign in after this reset.`);
  }

  // Validate a piped password before issuing a link: issuing one invalidates
  // any link the user already has, so a rejected password must not get that far.
  let password;
  if (values['password-stdin']) {
    password = newPasswordSchema.safeParse(await readStdin());
    if (!password.success) throw new Error(password.error.issues[0].message);
  }

  const { link } = await createPasswordLink(user.id);

  if (!values['password-stdin']) {
    const expiry = user.password_hash ? '1 hour' : '7 days';
    console.log(`Reset ${user.email} (${user.role}). Set the password within ${expiry} at:\n${link}`);
  } else {
    // The token rides in the URL fragment; consuming it here runs the same
    // transaction the set-password page would.
    await setPasswordWithToken(new URL(link).hash.replace('#token=', ''), password.data);
    console.log(`Password reset for ${user.email} (${user.role}). Other sessions for this account were ended.`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

/** Read the password from stdin, minus a single trailing newline from the shell. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
