/** Data access for saved cards. A card stores the selection, never a rendered image. */
import { pool } from '../db/pool.js';

const SELECT = `
  SELECT c.id, c.title, c.selection, c.created_by, c.dataset_id, c.created_at, c.updated_at,
         u.first_name || ' ' || u.last_name AS creator_name,
         d.name AS dataset_name, d.vintage AS dataset_vintage, d.version AS dataset_version
  FROM cards c
  JOIN users u ON u.id = c.created_by
  JOIN datasets d ON d.id = c.dataset_id`;

/** Newest first; optional case-insensitive search on title and town names. */
export async function list(query, db = pool) {
  const pattern = query ? `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const { rows } = await db.query(
    `${SELECT}
     WHERE $1::text IS NULL
        OR c.title ILIKE $1
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.selection -> 'towns') AS t(name) WHERE t.name ILIKE $1)
     ORDER BY c.updated_at DESC
     LIMIT 200`,
    [pattern],
  );
  return rows;
}

export async function findById(id, db = pool) {
  const { rows } = await db.query(`${SELECT} WHERE c.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insert({ title, selection, createdBy, datasetId }, db = pool) {
  const { rows } = await db.query(
    'INSERT INTO cards (title, selection, created_by, dataset_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [title, selection, createdBy, datasetId],
  );
  return rows[0].id;
}

export async function update(id, { title, selection, datasetId }, db = pool) {
  await db.query(
    'UPDATE cards SET title = $2, selection = $3, dataset_id = $4, updated_at = now() WHERE id = $1',
    [id, title, selection, datasetId],
  );
}

export async function remove(id, db = pool) {
  await db.query('DELETE FROM cards WHERE id = $1', [id]);
}
