/** Data access for observation values (one row per dataset, indicator and town). */
import { pool } from '../db/pool.js';

const INSERT_BATCH = 1000; // rows per statement, well under max_allowed_packet

/** Columns and places actually stored in one version, not the global catalog. */
export async function indicatorKeys(datasetId, db = pool) {
  const { rows } = await db.query(
    'SELECT DISTINCT i.`key` FROM observations o JOIN indicators i ON i.id = o.indicator_id WHERE o.dataset_id = ?',
    [datasetId],
  );
  return rows.map((row) => row.key);
}

export async function previewPlaces(datasetId, { offset, limit }, db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT t.id, t.name, t.geo_type, t.square_miles
     FROM observations o JOIN towns t ON t.id = o.town_id
     WHERE o.dataset_id = ? ORDER BY t.name LIMIT ? OFFSET ?`,
    [datasetId, limit, offset],
  );
  return rows;
}

export async function countPlaces(datasetId, db = pool) {
  const { rows } = await db.query('SELECT COUNT(DISTINCT town_id) AS total FROM observations WHERE dataset_id = ?', [datasetId]);
  return Number(rows[0].total);
}

/** Bulk insert with multi-row INSERT statements. Run inside a transaction so a file loads whole or not at all. */
export async function insertMany(datasetId, observations, db = pool) {
  for (let i = 0; i < observations.length; i += INSERT_BATCH) {
    const batch = observations.slice(i, i + INSERT_BATCH);
    await db.query('INSERT INTO observations (dataset_id, indicator_id, town_id, value) VALUES ?', [
      batch.map((o) => [datasetId, o.indicatorId, o.townId, o.value]),
    ]);
  }
}

/**
 * Raw stored values for the given towns in one dataset version.
 * @returns {Promise<Map<number, Map<string, number>>>} townId → indicator key → value
 */
export async function valuesByTown(datasetId, townIds, db = pool) {
  if (townIds.length === 0) return new Map(); // MySQL rejects an empty IN ()
  const { rows } = await db.query(
    `SELECT o.town_id, i.\`key\`, o.value
     FROM observations o JOIN indicators i ON i.id = o.indicator_id
     WHERE o.dataset_id = ? AND o.town_id IN (?)`,
    [datasetId, townIds],
  );
  const byTown = new Map(townIds.map((id) => [id, new Map()]));
  for (const row of rows) byTown.get(row.town_id).set(row.key, row.value);
  return byTown;
}
