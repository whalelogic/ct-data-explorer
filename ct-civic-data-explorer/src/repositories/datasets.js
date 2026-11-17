/** Data access for dataset versions. Source corrections are new versions; approval and presentation metadata may be edited. */
import { pool } from '../db/pool.js';

const DATASET_SELECT_SQL = `
  SELECT d.id, d.name, d.source_id, COALESCE(d.private_source, s.name) AS source, d.vintage, d.version, d.row_count, d.uploaded_at,
         d.is_active, d.is_private, d.uploaded_by, d.data_format, d.column_definitions, d.import_notes,
         d.approved_fields, d.curation_reviewed_at, d.curation_reviewed_by, d.presentation, d.presentation_revision,
         d.row_label_key,
         CONCAT(u.first_name, ' ', u.last_name) AS uploaded_by_name
  FROM datasets d
  JOIN sources s ON s.id = d.source_id
  JOIN users u ON u.id = d.uploaded_by`;

export async function list({ activeOnly = false, ownerId = null, scope } = {}, database = pool) {
  const where = [];
  const params = [];
  if (scope === 'private') {
    where.push('d.is_private AND d.uploaded_by = ?');
    params.push(ownerId);
  } else if (scope === 'public' || ownerId === null) {
    where.push('NOT d.is_private');
  } else {
    where.push('(NOT d.is_private OR d.uploaded_by = ?)');
    params.push(ownerId);
  }
  if (activeOnly) where.push('d.is_active');
  const { rows } = await database.query(
    `${DATASET_SELECT_SQL} WHERE ${where.join(' AND ')} ORDER BY d.name, d.vintage DESC, d.version DESC`,
    params,
  );
  return rows;
}

export async function findById(id, database = pool) {
  const { rows } = await database.query(`${DATASET_SELECT_SQL} WHERE d.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findActive(name, vintage, database = pool) {
  const { rows } = await database.query(
    `${DATASET_SELECT_SQL} WHERE d.is_active AND NOT d.is_private AND d.name = ? AND d.vintage = ?`,
    [name, vintage],
  );
  return rows[0] ?? null;
}

/** Serialize version numbering within a public or owner-only namespace. */
export async function lockNameVintage(name, vintage, ownerScope, database) {
  await database.lock(`dataset:${JSON.stringify([name, vintage, ownerScope])}`);
}

export async function nextVersion(name, vintage, ownerScope, database = pool) {
  const { rows } = await database.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM datasets
     WHERE name = ? AND vintage = ? AND IF(is_private, uploaded_by, 0) = ?`,
    [name, vintage, ownerScope],
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
    privateSource = null,
    dataFormat = 'indicators',
    columns = [],
    notes = [],
    rowLabelKey = null,
  } = dataset;
  const isPrivate = privateSource !== null;
  const { insertId } = await database.query(
    `INSERT INTO datasets (
       name, source_id, vintage, version, row_count, uploaded_by,
       data_format, column_definitions, import_notes, approved_fields, row_label_key,
       is_active, is_private, private_source
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, IF(?, NULL, JSON_ARRAY()), ?, ?, ?, ?)`,
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
      isPrivate,
      rowLabelKey,
      isPrivate,
      isPrivate,
      privateSource,
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
       WHERE d.is_active AND NOT d.is_private AND NOT target.is_private
         AND d.id <> target.id AND d.name = target.name AND d.vintage = target.vintage`,
      [id],
    );
  }
  const { rowCount } = await database.query('UPDATE datasets SET is_active = ? WHERE id = ? AND NOT is_private', [isActive, id]);
  return rowCount > 0;
}


export async function setPresentation(id, presentation, database) {
  await database.query(
    'UPDATE datasets SET presentation = ?, presentation_revision = presentation_revision + 1 WHERE id = ?',
    [JSON.stringify(presentation), id],
  );
}

/** Change which column labels a dataset's rows. Source values are not modified. */
export async function setRowLabelKey(id, rowLabelKey, database = pool) {
  await database.query('UPDATE datasets SET row_label_key = ? WHERE id = ?', [rowLabelKey, id]);
}
