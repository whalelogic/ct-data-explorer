/** Data access for dataset versions. Versions are never edited in place; corrections are new versions. */
import { pool } from '../db/pool.js';

const SELECT = `
  SELECT d.id, d.name, d.source_id, s.name AS source, d.vintage, d.version, d.row_count, d.uploaded_at,
         d.is_active, d.uploaded_by, d.data_format, d.column_definitions, d.import_notes,
         CONCAT(u.first_name, ' ', u.last_name) AS uploaded_by_name
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
  const { rows } = await db.query(`${SELECT} WHERE d.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findActive(name, vintage, db = pool) {
  const { rows } = await db.query(`${SELECT} WHERE d.is_active AND d.name = ? AND d.vintage = ?`, [name, vintage]);
  return rows[0] ?? null;
}

/** Serialize version numbering for one name + vintage until the transaction ends. Needs a withTransaction() client. */
export async function lockNameVintage(name, vintage, db) {
  await db.lock(`dataset:${name}\u001f${vintage}`);
}

export async function nextVersion(name, vintage, db = pool) {
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM datasets WHERE name = ? AND vintage = ?',
    [name, vintage],
  );
  return rows[0].version;
}

export async function insert({ name, sourceId, vintage, version, rowCount, uploadedBy, dataFormat = 'indicators', columns = [], notes = [] }, db = pool) {
  const { insertId } = await db.query(
    `INSERT INTO datasets (name, source_id, vintage, version, row_count, uploaded_by, data_format, column_definitions, import_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, sourceId, vintage, version, rowCount, uploadedBy, dataFormat, JSON.stringify(columns), JSON.stringify(notes)],
  );
  return { id: insertId };
}

/**
 * Activate or deactivate a version. Activating deactivates any other version of the
 * same name and vintage, so call this inside a transaction.
 * @returns {Promise<boolean>} false if the dataset does not exist
 */
export async function setActive(id, isActive, db) {
  if (isActive) {
    // MySQL cannot read the table it is updating in a subquery, so join to the target row instead.
    await db.query(
      `UPDATE datasets d JOIN datasets target ON target.id = ?
       SET d.is_active = FALSE
       WHERE d.is_active AND d.id <> target.id AND d.name = target.name AND d.vintage = target.vintage`,
      [id],
    );
  }
  const { rowCount } = await db.query('UPDATE datasets SET is_active = ? WHERE id = ?', [isActive, id]);
  return rowCount > 0;
}
