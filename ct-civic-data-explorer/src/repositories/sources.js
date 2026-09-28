/** Data access for data sources (the agency or survey a dataset comes from). */
import { pool } from '../db/pool.js';

export async function list(db = pool) {
  const { rows } = await db.query('SELECT id, name FROM sources ORDER BY name');
  return rows;
}

/**
 * Return the id of the source with this name (ignoring case), creating it if needed.
 * Two statements rather than one CTE, so a row committed by a concurrent insert is
 * visible to the SELECT.
 * @returns {Promise<number>}
 */
export async function findOrCreate(name, db = pool) {
  await db.query('INSERT INTO sources (name) VALUES ($1) ON CONFLICT ((lower(name))) DO NOTHING', [name]);
  const { rows } = await db.query('SELECT id FROM sources WHERE lower(name) = lower($1)', [name]);
  return rows[0].id;
}
