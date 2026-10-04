/** Data access for saved reports. A report stores the selection, never a rendered image. */
import { pool } from '../db/pool.js';

const SELECT = `
  SELECT r.id, r.title, r.selection, r.created_by, r.dataset_id, r.created_at, r.updated_at,
         CONCAT(u.first_name, ' ', u.last_name) AS creator_name,
         d.name AS dataset_name, d.vintage AS dataset_vintage, d.version AS dataset_version
  FROM reports r
  JOIN users u ON u.id = r.created_by
  JOIN datasets d ON d.id = r.dataset_id`;

/**
 * Newest first; optional case-insensitive search on report title and dataset name.
 * The _as_ci collation matches regardless of case but not accents, like PostgreSQL's ILIKE.
 */
export async function list(query, db = pool) {
  const pattern = query ? `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const { rows } = await db.query(
    `${SELECT}
     WHERE ? IS NULL
        OR r.title COLLATE utf8mb4_0900_as_ci LIKE ?
        OR d.name COLLATE utf8mb4_0900_as_ci LIKE ?
     ORDER BY r.updated_at DESC
     LIMIT 200`,
    [pattern, pattern, pattern],
  );
  return rows;
}

export async function findById(id, db = pool) {
  const { rows } = await db.query(`${SELECT} WHERE r.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function insert({ title, selection, createdBy, datasetId }, db = pool) {
  const { insertId } = await db.query(
    'INSERT INTO reports (title, selection, created_by, dataset_id) VALUES (?, ?, ?, ?)',
    [title, JSON.stringify(selection), createdBy, datasetId],
  );
  return insertId;
}

export async function update(id, { title, selection, datasetId }, db = pool) {
  await db.query(
    'UPDATE reports SET title = ?, selection = ?, dataset_id = ?, updated_at = NOW(3) WHERE id = ?',
    [title, JSON.stringify(selection), datasetId, id],
  );
}

export async function remove(id, db = pool) {
  await db.query('DELETE FROM reports WHERE id = ?', [id]);
}
