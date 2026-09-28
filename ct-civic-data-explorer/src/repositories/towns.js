/** Data access for towns and the statewide row. */
import { pool } from '../db/pool.js';

const COLUMNS = 'id, name, geo_type, square_miles';

export async function list(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM towns ORDER BY name`);
  return rows;
}

export async function findById(id, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM towns WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findState(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM towns WHERE geo_type = 'state' ORDER BY id LIMIT 1`);
  return rows[0] ?? null;
}

/** Case-insensitive lookup by name. */
export async function findByNames(names, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM towns WHERE lower(name) = ANY($1::text[])`, [
    names.map((n) => n.toLowerCase()),
  ]);
  return rows;
}
