/** Data access for indicator definitions. */
import { pool } from '../db/pool.js';

const COLUMNS = 'id, `key`, label, unit, decimals, derivation, numerator_key, denominator_key'; // KEY is reserved in MySQL

export async function list(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM indicators ORDER BY id`);
  return rows;
}

export async function findByKeys(keys, db = pool) {
  if (keys.length === 0) return []; // MySQL rejects an empty IN ()
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM indicators WHERE \`key\` IN (?)`, [keys]);
  return rows;
}

export async function create({ key, label, unit, decimals, derivation, numeratorKey, denominatorKey }, db = pool) {
  const { insertId } = await db.query(
    `INSERT INTO indicators (\`key\`, label, unit, decimals, derivation, numerator_key, denominator_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [key, label, unit, decimals, derivation, numeratorKey ?? null, denominatorKey ?? null],
  );
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM indicators WHERE id = ?`, [insertId]);
  return rows[0];
}
