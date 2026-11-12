/** Data access for the append-only audit log. */
import { pool } from '../db/pool.js';

export async function insert({ actorId, actorEmail, action, targetType, targetId, targetLabel, details, ip }, db = pool) {
  await db.query(
    `INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, target_label, details, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [actorId, actorEmail, action, targetType, targetId, targetLabel, details === null ? null : JSON.stringify(details), ip],
  );
}

/**
 * Newest first. `before` is the id of the last entry already shown, for "load more".
 * `category` is the part of the action before the dot ('auth', 'user', 'dataset', 'report').
 */
export async function list({ limit, before, category }, db = pool) {
  const conditions = [];
  const params = [];
  if (before) {
    conditions.push('a.id < ?');
    params.push(before);
  }
  if (category) {
    conditions.push('a.action LIKE ?');
    params.push(`${category}.%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT a.id, a.occurred_at, a.actor_id, a.actor_email, a.action, a.target_type, a.target_id,
            a.target_label, a.details, a.ip,
            CONCAT(u.first_name, ' ', u.last_name) AS actor_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ${where}
     ORDER BY a.id DESC LIMIT ?`,
    [...params, limit],
  );
  return rows;
}

/** Remove entries older than the retention period. @returns {Promise<number>} rows removed */
export async function removeOlderThan(days, db = pool) {
  const { rowCount } = await db.query('DELETE FROM audit_log WHERE occurred_at < NOW(3) - INTERVAL ? DAY', [days]);
  return rowCount;
}
