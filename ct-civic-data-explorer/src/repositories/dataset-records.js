/** Source rows. A row has a town only in town-keyed datasets; others are labeled by a column. */
import { pool } from '../db/pool.js';

export async function insertMany(datasetId, rows, db = pool) {
  for (let start = 0; start < rows.length; start += 500) {
    await db.query('INSERT INTO dataset_records (dataset_id, town_id, source_row, cell_values) VALUES ?',
      [rows.slice(start, start + 500).map((row) => [datasetId, row.townId ?? null, row.sourceRow, JSON.stringify(row.cells)])]);
  }
}

/**
 * Rows in source order. `townIds` narrows town-keyed datasets in SQL; rows of other
 * datasets are narrowed by label in the service, since the label column can change.
 */
export async function list(datasetId, { offset = 0, limit = 10000, townIds } = {}, db = pool) {
  if (townIds && !townIds.length) return [];
  const { rows } = await db.query(`SELECT r.id, r.source_row, r.cell_values, t.id AS town_id,
      t.name AS town_name, t.name, COALESCE(t.geo_type, 'row') AS geo_type
    FROM dataset_records r LEFT JOIN towns t ON t.id = r.town_id
    WHERE r.dataset_id = ? ${townIds ? 'AND r.town_id IN (?)' : ''}
    ORDER BY r.source_row LIMIT ? OFFSET ?`, [datasetId, ...(townIds ? [townIds] : []), limit, offset]);
  return rows;
}
