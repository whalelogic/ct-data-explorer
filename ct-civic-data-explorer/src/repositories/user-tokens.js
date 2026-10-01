/** Data access for single-use invite and password-reset tokens (stored hashed). */
import { pool } from '../db/pool.js';

export async function create({ userId, purpose, tokenHash, expiresAt }, db = pool) {
  await db.query(
    'INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [userId, purpose, tokenHash, expiresAt],
  );
}

/** Retire every outstanding token for a user, so only the newest link works. */
export async function invalidateForUser(userId, db = pool) {
  await db.query('UPDATE user_tokens SET used_at = NOW(3) WHERE user_id = ? AND used_at IS NULL', [userId]);
}

/** Find an unused, unexpired token. Pass forUpdate inside a transaction to consume it safely. */
export async function findUsable(tokenHash, db = pool, forUpdate = false) {
  const { rows } = await db.query(
    `SELECT t.id, t.user_id, t.purpose, u.email, u.first_name, u.is_active
     FROM user_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > NOW(3)
     ${forUpdate ? 'FOR UPDATE OF t' : ''}`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function markUsed(id, db = pool) {
  await db.query('UPDATE user_tokens SET used_at = NOW(3) WHERE id = ?', [id]);
}
