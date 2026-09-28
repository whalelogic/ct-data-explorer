/** Data access for indicator definitions. */
import { pool } from '../db/pool.js';

const COLUMNS = 'id, key, label, unit, decimals, derivation, numerator_key, denominator_key';

export async function list(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM indicators ORDER BY id`);
  return rows;
}

export async function findByKeys(keys, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM indicators WHERE key = ANY($1::text[])`, [keys]);
  return rows;
}

export async function create({ key, label, unit, decimals, derivation, numeratorKey, denominatorKey }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO indicators (key, label, unit, decimals, derivation, numerator_key, denominator_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
    [key, label, unit, decimals, derivation, numeratorKey ?? null, denominatorKey ?? null],
  );
  return rows[0];
}
