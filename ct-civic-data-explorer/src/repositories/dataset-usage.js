import { pool, withTransaction } from '../db/pool.js';

const RECENT = 'activity_date >= UTC_DATE() - INTERVAL 29 DAY';

export function increment(event, selections) {
  return withTransaction(async (database) => {
    await database.query(
      `INSERT INTO usage_activity_daily (activity_date, event_type, hits)
       VALUES (UTC_DATE(), ?, 1)
       ON DUPLICATE KEY UPDATE hits = hits + 1`,
      [event],
    );

    const datasetIds = [...selections.keys()].sort((first, second) => first - second);
    if (datasetIds.length === 0) return;
    const { rowCount } = await database.query(
      'SELECT id FROM datasets WHERE id IN (?) AND is_private = FALSE',
      [datasetIds],
    );
    // A private or mixed operation contributes only to the aggregate activity.
    if (rowCount !== datasetIds.length) return;

    const values = [];
    for (const id of datasetIds) {
      values.push([event, id, '']);
      for (const key of [...selections.get(id)].sort()) values.push(['indicator', id, key]);
    }
    await database.query(
      `INSERT INTO dataset_usage_daily (activity_date, event_type, dataset_id, indicator_key, hits)
       VALUES ${values.map(() => '(UTC_DATE(), ?, ?, ?, 1)').join(', ')}
       ON DUPLICATE KEY UPDATE hits = hits + 1`,
      values.flat(),
    );
  });
}

export async function readDashboard(database = pool) {
  const [activity, datasets, indicators] = await Promise.all([
    database.query(
      `SELECT event_type AS event, SUM(hits) AS count FROM usage_activity_daily
       WHERE ${RECENT} GROUP BY event_type`,
    ),
    database.query(
      `SELECT d.id, d.name, d.vintage, d.version, SUM(u.hits) AS count
       FROM dataset_usage_daily u JOIN datasets d ON d.id = u.dataset_id
       WHERE u.${RECENT} AND u.indicator_key = '' AND d.is_private = FALSE
       GROUP BY d.id, d.name, d.vintage, d.version
       ORDER BY count DESC, d.name, d.id LIMIT 10`,
    ),
    database.query(
      `SELECT d.id, d.name, d.vintage, d.version, d.column_definitions, d.presentation,
              r.indicator_key, i.label, r.count
       FROM (
         SELECT dataset_id, indicator_key, SUM(hits) AS count
         FROM dataset_usage_daily
         WHERE ${RECENT} AND event_type = 'indicator'
         GROUP BY dataset_id, indicator_key
       ) r
       JOIN datasets d ON d.id = r.dataset_id AND d.is_private = FALSE
       LEFT JOIN indicators i ON d.data_format = 'indicators' AND i.\`key\` = r.indicator_key
       WHERE d.approved_fields IS NULL OR JSON_CONTAINS(d.approved_fields, JSON_QUOTE(r.indicator_key))
       ORDER BY r.count DESC, d.name, d.id, r.indicator_key LIMIT 10`,
    ),
  ]);

  return {
    activity: Object.fromEntries(activity.rows.map(({ event, count }) => [event, Number(count)])),
    datasets: datasets.rows.map(presentDatasetMetric),
    indicators: indicators.rows.map((row) => ({
      ...presentDatasetMetric(row),
      key: row.indicator_key,
      label: row.presentation?.fields?.[row.indicator_key]?.label
        || row.label
        || row.column_definitions?.find((column) => column.key === row.indicator_key)?.label
        || row.indicator_key,
    })),
  };
}

function presentDatasetMetric({ id, name, vintage, version, count }) {
  return { id, name, vintage, version, count: Number(count) };
}
