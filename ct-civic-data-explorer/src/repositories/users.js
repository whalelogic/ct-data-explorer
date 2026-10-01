/** Data access for users and their sessions. Parameterized SQL only. */
import { pool } from '../db/pool.js';

const COLUMNS = 'id, email, password_hash, first_name, last_name, role, is_active, locked_until, created_at';

export async function findById(id, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findByEmail(email, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users WHERE email = LOWER(?)`, [email]);
  return rows[0] ?? null;
}

export async function list(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users ORDER BY last_name, first_name`);
  return rows;
}

export async function create({ email, firstName, lastName, role }, db = pool) {
  const { insertId } = await db.query(
    'INSERT INTO users (email, first_name, last_name, role) VALUES (LOWER(?), ?, ?, ?)',
    [email, firstName, lastName, role],
  );
  return findById(insertId, db);
}

export async function update(id, { role, isActive }, db = pool) {
  await db.query('UPDATE users SET role = COALESCE(?, role), is_active = COALESCE(?, is_active) WHERE id = ?', [
    role ?? null,
    isActive ?? null,
    id,
  ]);
  return findById(id, db);
}

export async function setPassword(id, passwordHash, db = pool) {
  await db.query(
    `UPDATE users SET password_hash = ?, failed_login_count = 0, first_failed_login_at = NULL, locked_until = NULL
     WHERE id = ?`,
    [passwordHash, id],
  );
}

/**
 * Count a failed sign-in. Failures inside the window accumulate; reaching
 * maxFailures locks the account for lockMinutes. Done in one statement so
 * concurrent attempts cannot race past the limit.
 */
export async function recordFailedLogin(id, { windowMinutes, maxFailures, lockMinutes }, db = pool) {
  // MySQL evaluates SET assignments left to right, each seeing the columns already
  // assigned, so locked_until is set first while the other two still hold their old values.
  await db.query(
    `UPDATE users SET
       locked_until = CASE
         WHEN first_failed_login_at >= NOW(3) - INTERVAL ? MINUTE AND failed_login_count + 1 >= ?
         THEN NOW(3) + INTERVAL ? MINUTE
         ELSE locked_until END,
       failed_login_count = CASE
         WHEN first_failed_login_at >= NOW(3) - INTERVAL ? MINUTE THEN failed_login_count + 1
         ELSE 1 END,
       first_failed_login_at = CASE
         WHEN first_failed_login_at >= NOW(3) - INTERVAL ? MINUTE THEN first_failed_login_at
         ELSE NOW(3) END
     WHERE id = ?`,
    [windowMinutes, maxFailures, lockMinutes, windowMinutes, windowMinutes, id],
  );
}

export async function clearFailedLogins(id, db = pool) {
  await db.query(
    'UPDATE users SET failed_login_count = 0, first_failed_login_at = NULL, locked_until = NULL WHERE id = ?',
    [id],
  );
}

/** Sign a user out everywhere, e.g. after deactivation or a password reset. */
export async function deleteSessions(userId, db = pool) {
  await db.query("DELETE FROM session WHERE CAST(sess ->> '$.userId' AS SIGNED) = ?", [userId]);
}
