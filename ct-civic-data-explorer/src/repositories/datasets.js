/** Data access for dataset versions. Source corrections are new versions; approval and presentation metadata may be edited. */
import { pool } from '../db/pool.js';

const DATASET_SELECT_SQL = `
  SELECT d.id, d.name, d.source_id, s.name AS source, d.vintage, d.version, d.row_count, d.uploaded_at,
         d.is_active, d.uploaded_by, d.data_format, d.column_definitions, d.import_notes,
         d.approved_fields, d.curation_reviewed_at, d.curation_reviewed_by, d.presentation, d.presentation_revision,
         CONCAT(u.first_name, ' ', u.last_name) AS uploaded_by_name
  FROM datasets d
  JOIN sources s ON s.id = d.source_id
  JOIN users u ON u.id = d.uploaded_by`;

export async function list({ activeOnly = false } = {}, database = pool) {
  const activeFilter = activeOnly ? 'WHERE d.is_active' : '';
  const { rows } = await database.query(
    `${DATASET_SELECT_SQL} ${activeFilter} ORDER BY d.name, d.vintage DESC, d.version DESC`,
  );
  return rows;
}

export async function findById(id, database = pool) {
  const { rows } = await database.query(`${DATASET_SELECT_SQL} WHERE d.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findActive(name, vintage, database = pool) {
  const { rows } = await database.query(
    `${DATASET_SELECT_SQL} WHERE d.is_active AND d.name = ? AND d.vintage = ?`,
    [name, vintage],
  );
  return rows[0] ?? null;
}

/** Serialize version numbering for one name + vintage until the transaction ends. Needs a withTransaction() client. */
export async function lockNameVintage(name, vintage, database) {
  await database.lock(`dataset:${name}\u001f${vintage}`);
}

export async function nextVersion(name, vintage, database = pool) {
  const { rows } = await database.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM datasets WHERE name = ? AND vintage = ?',
    [name, vintage],
  );
  return rows[0].version;
}

export async function insert(dataset, database = pool) {
  const {
    name,
    sourceId,
    vintage,
    version,
    rowCount,
    uploadedBy,
    dataFormat = 'indicators',
    columns = [],
    notes = [],
  } = dataset;
  const { insertId } = await database.query(
    `INSERT INTO datasets (
       name, source_id, vintage, version, row_count, uploaded_by,
       data_format, column_definitions, import_notes, approved_fields
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, JSON_ARRAY())`,
    [
      name,
      sourceId,
      vintage,
      version,
      rowCount,
      uploadedBy,
      dataFormat,
      JSON.stringify(columns),
      JSON.stringify(notes),
    ],
  );
  return { id: insertId };
}

export async function setCuration(id, approvedFields, reviewedBy, database = pool) {
  const { rowCount } = await database.query(
    `UPDATE datasets
     SET approved_fields = ?, curation_reviewed_at = CURRENT_TIMESTAMP(3), curation_reviewed_by = ?
     WHERE id = ?`,
    [JSON.stringify(approvedFields), reviewedBy, id],
  );
  return rowCount > 0;
}

/**
 * Activate or deactivate a version. Activating deactivates any other version of the
 * same name and vintage, so call this inside a transaction.
 * @returns {Promise<boolean>} false if the dataset does not exist
 */
export async function setActive(id, isActive, database) {
  if (isActive) {
    // MySQL cannot read the table it is updating in a subquery, so join to the target row instead.
    await database.query(
      `UPDATE datasets d JOIN datasets target ON target.id = ?
       SET d.is_active = FALSE
       WHERE d.is_active AND d.id <> target.id AND d.name = target.name AND d.vintage = target.vintage`,
      [id],
    );
  }
  const { rowCount } = await database.query('UPDATE datasets SET is_active = ? WHERE id = ?', [isActive, id]);
  return rowCount > 0;
}


export async function setPresentation(id, presentation, database) {
  await database.query(
    'UPDATE datasets SET presentation = ?, presentation_revision = presentation_revision + 1 WHERE id = ?',
    [JSON.stringify(presentation), id],
  );
}
