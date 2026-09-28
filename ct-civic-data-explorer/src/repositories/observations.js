/** Data access for observation values (one row per dataset, indicator and town). */
import { pool } from '../db/pool.js';

/** Bulk insert in a single statement. */
export async function insertMany(datasetId, observations, db = pool) {
  if (observations.length === 0) return;
  await db.query(
    `INSERT INTO observations (dataset_id, indicator_id, town_id, value)
     SELECT $1, x.indicator_id, x.town_id, x.value
     FROM unnest($2::int[], $3::int[], $4::numeric[]) AS x(indicator_id, town_id, value)`,
    [
      datasetId,
      observations.map((o) => o.indicatorId),
      observations.map((o) => o.townId),
      observations.map((o) => o.value),
    ],
  );
}

/**
 * Raw stored values for the given towns in one dataset version.
 * @returns {Promise<Map<number, Map<string, number>>>} townId → indicator key → value
 */
export async function valuesByTown(datasetId, townIds, db = pool) {
  const { rows } = await db.query(
    `SELECT o.town_id, i.key, o.value
     FROM observations o JOIN indicators i ON i.id = o.indicator_id
     WHERE o.dataset_id = $1 AND o.town_id = ANY($2::int[])`,
    [datasetId, townIds],
  );
  const byTown = new Map(townIds.map((id) => [id, new Map()]));
  for (const row of rows) byTown.get(row.town_id).set(row.key, row.value);
  return byTown;
}
