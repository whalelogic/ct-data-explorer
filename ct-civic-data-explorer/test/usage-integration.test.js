/** Opt in against a migrated test database: CT_USAGE_INTEGRATION=1 npm test. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { increment, readDashboard } from '../src/repositories/dataset-usage.js';

test('usage counts mixed activity once without recording private dataset or indicator details', {
  skip: process.env.CT_USAGE_INTEGRATION !== '1',
}, async () => {
  const event = `test_${randomBytes(8).toString('hex')}`;
  const { insertId: owner } = await pool.query(
    'INSERT INTO users (email, first_name, last_name, role) VALUES (?, ?, ?, ?)',
    [`${event}@example.invalid`, 'Usage', 'Test', 'staff'],
  );
  const { insertId: source } = await pool.query('INSERT INTO sources (name) VALUES (?)', [event]);
  try {
    const publicDataset = await addDataset(`${event} shared`, source, owner, false, 'Shared field');
    const privateDataset = await addDataset(`${event} private`, source, owner, true, 'Private field');
    const sharedSelection = [publicDataset, new Set(['c1'])];
    const privateSelection = [privateDataset, new Set(['c1'])];
    await increment(event, new Map([sharedSelection]));
    await increment(event, new Map([privateSelection]));
    await increment(event, new Map([sharedSelection, privateSelection]));

    const { rows } = await pool.query(
      `SELECT event_type, dataset_id, indicator_key, hits FROM dataset_usage_daily
       WHERE dataset_id IN (?) ORDER BY event_type`,
      [[publicDataset, privateDataset]],
    );
    assert.deepEqual(rows, [
      { event_type: 'indicator', dataset_id: publicDataset, indicator_key: 'c1', hits: 1 },
      { event_type: event, dataset_id: publicDataset, indicator_key: '', hits: 1 },
    ]);

    const dashboard = await readDashboard();
    assert.equal(dashboard.activity[event], 3);
    assert.equal(dashboard.datasets.some((dataset) => dataset.id === privateDataset), false);
    assert.equal(dashboard.indicators.some((indicator) => indicator.id === privateDataset), false);
  } finally {
    await pool.query('DELETE FROM usage_activity_daily WHERE event_type = ?', [event]);
    await pool.query('DELETE FROM datasets WHERE uploaded_by = ?', [owner]);
    await pool.query('DELETE FROM sources WHERE id = ?', [source]);
    await pool.query('DELETE FROM users WHERE id = ?', [owner]);
    await pool.end();
  }
});

async function addDataset(name, source, owner, isPrivate, fieldLabel) {
  const { insertId } = await pool.query(
    `INSERT INTO datasets (name, source_id, vintage, version, row_count, uploaded_by,
                          data_format, column_definitions, approved_fields, is_private)
     VALUES (?, ?, '2026', 1, 1, ?, 'records', ?, JSON_ARRAY('c1'), ?)`,
    [name, source, owner, JSON.stringify([{ key: 'c1', label: fieldLabel }]), isPrivate],
  );
  return insertId;
}
