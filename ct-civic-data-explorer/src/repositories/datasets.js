/** Data access for dataset versions. Versions are never edited in place; corrections are new versions. */
import { pool } from '../db/pool.js';

const SELECT = `
  SELECT d.id, d.name, d.source_id, s.name AS source, d.vintage, d.version, d.row_count, d.uploaded_at,
         d.is_active, d.uploaded_by, u.first_name || ' ' || u.last_name AS uploaded_by_name
  FROM datasets d
  JOIN sources s ON s.id = d.source_id
  JOIN users u ON u.id = d.uploaded_by`;

export async function list({ activeOnly = false } = {}, db = pool) {
  const { rows } = await db.query(
    `${SELECT} ${activeOnly ? 'WHERE d.is_active' : ''} ORDER BY d.name, d.vintage DESC, d.version DESC`,
  );
  return rows;
}

export async function findById(id, db = pool) {
  const { rows } = await db.query(`${SELECT} WHERE d.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findActive(name, vintage, db = pool) {
  const { rows } = await db.query(`${SELECT} WHERE d.is_active AND d.name = $1 AND d.vintage = $2`, [name, vintage]);
  return rows[0] ?? null;
}

/** Serialize version numbering for one name + vintage until the transaction ends. */
export async function lockNameVintage(name, vintage, db) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1 || chr(31) || $2))', [name, vintage]);
}

export async function nextVersion(name, vintage, db = pool) {
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM datasets WHERE name = $1 AND vintage = $2',
    [name, vintage],
  );
  return rows[0].version;
}

export async function insert({ name, sourceId, vintage, version, rowCount, uploadedBy }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO datasets (name, source_id, vintage, version, row_count, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, sourceId, vintage, version, rowCount, uploadedBy],
  );
  return rows[0];
}

/**
 * Activate or deactivate a version. Activating deactivates any other version of the
 * same name and vintage, so call this inside a transaction.
 * @returns {Promise<boolean>} false if the dataset does not exist
 */
export async function setActive(id, isActive, db) {
  if (isActive) {
    await db.query(
      `UPDATE datasets SET is_active = FALSE
       WHERE is_active AND id <> $1
         AND (name, vintage) = (SELECT name, vintage FROM datasets WHERE id = $1)`,
      [id],
    );
  }
  const { rowCount } = await db.query('UPDATE datasets SET is_active = $2 WHERE id = $1', [id, isActive]);
  return rowCount > 0;
}
