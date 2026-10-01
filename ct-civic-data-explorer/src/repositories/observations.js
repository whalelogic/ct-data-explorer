/** Data access for observation values (one row per dataset, indicator and town). */
import { pool } from '../db/pool.js';

const INSERT_BATCH = 1000; // rows per statement, well under max_allowed_packet

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
