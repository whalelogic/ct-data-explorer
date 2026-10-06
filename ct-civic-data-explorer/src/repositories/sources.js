/** Data access for data sources (the agency or survey a dataset comes from). */
import { pool } from '../db/pool.js';

export async function list(db = pool) {
  const { rows } = await db.query('SELECT id, name FROM sources ORDER BY name');
  return rows;
}

/**
 * Return the id of the source with this name (ignoring case), creating it if needed.
 * The no-op update only fires on the LOWER(name) unique key (the only one besides
 * the primary key), and the SELECT then sees a row committed by a concurrent insert
 * because connections run at READ COMMITTED.
 * @returns {Promise<number>}
 */
export async function findOrCreate(name, db = pool) {
  await db.query('INSERT INTO sources (name) VALUES (?) ON DUPLICATE KEY UPDATE id = id', [name]);
  const { rows } = await db.query('SELECT id FROM sources WHERE LOWER(name) = LOWER(?)', [name]);
  return rows[0].id;
}
