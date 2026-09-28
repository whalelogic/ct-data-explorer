/** Data access for users and their sessions. Parameterized SQL only. */
import { pool } from '../db/pool.js';

const COLUMNS = 'id, email, password_hash, first_name, last_name, role, is_active, locked_until, created_at';

export async function findById(id, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findByEmail(email, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users WHERE email = lower($1)`, [email]);
  return rows[0] ?? null;
}

export async function list(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users ORDER BY last_name, first_name`);
  return rows;
}

export async function create({ email, firstName, lastName, role }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO users (email, first_name, last_name, role) VALUES (lower($1), $2, $3, $4) RETURNING ${COLUMNS}`,
    [email, firstName, lastName, role],
  );
  return rows[0];
}

export async function update(id, { role, isActive }, db = pool) {
  const { rows } = await db.query(
    `UPDATE users SET role = COALESCE($2, role), is_active = COALESCE($3, is_active)
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, role ?? null, isActive ?? null],
  );
  return rows[0] ?? null;
}

export async function setPassword(id, passwordHash, db = pool) {
  await db.query(
    `UPDATE users SET password_hash = $2, failed_login_count = 0, first_failed_login_at = NULL, locked_until = NULL
     WHERE id = $1`,
    [id, passwordHash],
  );
}

/**
 * Count a failed sign-in. Failures inside the window accumulate; reaching
 * maxFailures locks the account for lockMinutes. Done in one statement so
 * concurrent attempts cannot race past the limit.
 */
export async function recordFailedLogin(id, { windowMinutes, maxFailures, lockMinutes }, db = pool) {
  await db.query(
    `UPDATE users SET
       failed_login_count = CASE
         WHEN first_failed_login_at >= now() - make_interval(mins => $2) THEN failed_login_count + 1
         ELSE 1 END,
       first_failed_login_at = CASE
         WHEN first_failed_login_at >= now() - make_interval(mins => $2) THEN first_failed_login_at
         ELSE now() END,
       locked_until = CASE
         WHEN first_failed_login_at >= now() - make_interval(mins => $2) AND failed_login_count + 1 >= $3
         THEN now() + make_interval(mins => $4)
         ELSE locked_until END
     WHERE id = $1`,
    [id, windowMinutes, maxFailures, lockMinutes],
  );
}

export async function clearFailedLogins(id, db = pool) {
  await db.query(
    'UPDATE users SET failed_login_count = 0, first_failed_login_at = NULL, locked_until = NULL WHERE id = $1',
    [id],
  );
}

/** Sign a user out everywhere, e.g. after deactivation or a password reset. */
export async function deleteSessions(userId, db = pool) {
  await db.query(`DELETE FROM session WHERE (sess ->> 'userId')::int = $1`, [userId]);
}
