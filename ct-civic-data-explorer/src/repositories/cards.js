/** Data access for saved cards. A card stores the selection, never a rendered image. */
import { pool } from '../db/pool.js';

const SELECT = `
  SELECT c.id, c.title, c.selection, c.created_by, c.dataset_id, c.created_at, c.updated_at,
         CONCAT(u.first_name, ' ', u.last_name) AS creator_name,
         d.name AS dataset_name, d.vintage AS dataset_vintage, d.version AS dataset_version
  FROM cards c
  JOIN users u ON u.id = c.created_by
  JOIN datasets d ON d.id = c.dataset_id`;

/**
 * Newest first; optional case-insensitive search on report title and dataset name.
 * The _as_ci collation matches regardless of case but not accents, like PostgreSQL's ILIKE.
 */
export async function list(query, db = pool) {
  const pattern = query ? `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const { rows } = await db.query(
    `${SELECT}
     WHERE ? IS NULL
        OR c.title COLLATE utf8mb4_0900_as_ci LIKE ?
        OR d.name COLLATE utf8mb4_0900_as_ci LIKE ?
     ORDER BY c.updated_at DESC
     LIMIT 200`,
    [pattern, pattern, pattern],
  );
  return rows;
}

export async function findById(id, db = pool) {
  const { rows } = await db.query(`${SELECT} WHERE c.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function insert({ title, selection, createdBy, datasetId }, db = pool) {
  const { insertId } = await db.query(
    'INSERT INTO cards (title, selection, created_by, dataset_id) VALUES (?, ?, ?, ?)',
    [title, JSON.stringify(selection), createdBy, datasetId],
  );
  return insertId;
}

export async function update(id, { title, selection, datasetId }, db = pool) {
  await db.query(
    'UPDATE cards SET title = ?, selection = ?, dataset_id = ?, updated_at = NOW(3) WHERE id = ?',
    [title, JSON.stringify(selection), datasetId, id],
  );
}

export async function remove(id, db = pool) {
  await db.query('DELETE FROM cards WHERE id = ?', [id]);
}
