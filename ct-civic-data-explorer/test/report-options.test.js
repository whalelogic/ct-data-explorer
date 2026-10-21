import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndicatorReportOptions, buildRecordReportOptions } from '../src/services/datasets.service.js';
import * as records from '../src/repositories/dataset-records.js';

const dataset = {
  data_format: 'records',
  curation_reviewed_at: '2026-10-17',
  column_definitions: [
    { key: 'c0', label: 'Category', type: 'text', role: 'dimension', unit: 'number' },
    { key: 'c1', label: 'Jobs', type: 'number', role: 'measure', unit: 'count', decimals: 0 },
    { key: 'c2', label: 'Private amount', type: 'number', role: 'measure', unit: 'currency', decimals: 2 },
  ],
  approved_fields: ['c0', 'c1'],
  presentation: {
    fieldOrder: ['c1', 'c0'],
    fields: { c1: { label: 'Employment', description: 'Reported jobs', decimals: 1 }, c2: { label: 'Confidential' } },
  },
};
const row = (sourceRow, cells, geography = {}) => ({ source_row: sourceRow, cell_values: cells, town_id: null, ...geography });

test('record choices expose approved presented fields and filters without requiring locations or repeats', () => {
  const options = buildRecordReportOptions(dataset, [
    row(2, { c0: 'Services', c1: 20, c2: 9000 }), row(3, { c0: 'Construction', c1: 2, c2: 9000 }),
  ]);
  assert.deepEqual(options.columns.map((field) => field.key), ['c1', 'c0']);
  assert.equal(options.columns[0].displayLabel, 'Employment');
  assert.equal(options.columns[0].type, 'number');
  assert.equal(options.columns[0].unit, 'count');
  assert.equal(options.columns[0].decimals, 1);
  assert.equal(options.columns[0].description, 'Reported jobs');
  assert.equal(options.hasGeography, false);
  assert.equal(options.hasLocations, false);
  assert.equal(options.hasState, false);
  assert.equal(options.repeatedRows, false);
  assert.deepEqual(options.places, []);
  assert.deepEqual(options.filters.map((field) => field.key), ['c1', 'c0']);
  assert.deepEqual(options.filters[0].values, ['2', '20']);
  assert.deepEqual(options.filters[1].values, ['Construction', 'Services']);
  assert.equal(options.filters[0].label, 'Employment');
  assert.ok(!JSON.stringify(options).includes('Private'));
  assert.ok(!JSON.stringify(options).includes('Confidential'));
  assert.ok(!JSON.stringify(options).includes('9000'));
});

test('only matched record geography creates location and statewide capabilities', () => {
  const options = buildRecordReportOptions(dataset, [
    row(2, { c0: 'A', c1: 10 }),
    row(3, { c0: 'B', c1: 20 }, { town_id: 1, name: 'Andover', geo_type: 'town' }),
    row(4, { c0: 'C', c1: 30 }, { town_id: 1, name: 'Andover', geo_type: 'town' }),
    row(5, { c0: 'D', c1: 40 }, { town_id: 2, name: 'Connecticut', geo_type: 'state' }),
  ]);
  assert.equal(options.hasGeography, true);
  assert.equal(options.hasLocations, true);
  assert.equal(options.hasState, true);
  assert.equal(options.repeatedRows, true);
  assert.deepEqual(options.places.map((place) => place.name), ['Andover', 'Connecticut']);
  assert.ok(options.places.every((place) => place.id != null));
});

test('high-cardinality filters offer exact free text without truncating selectable values', () => {
  const rows = Array.from({ length: 251 }, (_, index) => row(index + 2, { c0: `Record ${index}`, c1: index }));
  const options = buildRecordReportOptions(dataset, rows);
  for (const filter of options.filters) {
    assert.equal(filter.freeText, true);
    assert.equal(filter.distinctValueCount, 251);
    assert.deepEqual(filter.values, []);
  }
  const smallOptions = buildRecordReportOptions(dataset, rows.slice(0, 250));
  assert.equal(smallOptions.filters[0].freeText, false);
  assert.equal(smallOptions.filters[0].values.length, 250);
});

test('unapproved drafts expose no report columns or field filters', () => {
  const options = buildRecordReportOptions({ ...dataset, approved_fields: [] }, [row(2, { c0: 'SECRET', c1: 42 })]);
  assert.deepEqual(options.columns, []);
  assert.deepEqual(options.filters, []);
  assert.ok(!JSON.stringify(options).includes('SECRET'));
});

test('indicator options offer approved numeric filters using computed values and display metadata', () => {
  const indicatorDataset = {
    data_format: 'indicators', approved_fields: ['rate'],
    presentation: { fields: { rate: { label: 'Employment share' } } },
  };
  const fields = [
    { key: 'jobs', label: 'Jobs', type: 'number', unit: 'count', derivation: 'direct' },
    { key: 'rate', label: 'Rate', type: 'number', unit: 'percent', derivation: 'ratio', numeratorKey: 'jobs', denominatorKey: 'population' },
  ];
  const places = [{ id: 1, name: 'Andover', geo_type: 'town' }, { id: 2, name: 'Connecticut', geo_type: 'state' }];
  const values = new Map([[1, new Map([['jobs', 10], ['population', 100]])], [2, new Map([['jobs', 20], ['population', 100]])]]);
  const options = buildIndicatorReportOptions(indicatorDataset, fields, places, values);
  assert.equal(options.hasGeography, true);
  assert.equal(options.hasState, true);
  assert.equal(options.columns[0].label, 'Employment share');
  assert.deepEqual(options.filters.map((field) => field.key), ['rate']);
  assert.deepEqual(options.filters[0].values, ['10', '20']);
  assert.equal(options.filters[0].unit, 'percent');
  assert.equal(options.filters[0].label, 'Employment share');
});

test('record repository preserves unlocated rows and stores null geography', async () => {
  const storedRows = [row(2, { c0: 'Services', c1: 2 })];
  const calls = [];
  const database = { async query(sql, params) { calls.push({ sql, params }); return { rows: storedRows }; } };
  assert.equal(await records.list(7, undefined, database), storedRows);
  assert.match(calls[0].sql, /LEFT JOIN towns/);
  assert.doesNotMatch(calls[0].sql, /r\.town_id IN/);
  assert.deepEqual(calls[0].params, [7, 10000, 0]);
  await records.insertMany(7, [{ sourceRow: 2, cells: { c0: 'Services', c1: 2 } }], database);
  assert.deepEqual(calls[1].params, [[[7, null, 2, '{"c0":"Services","c1":2}']]]);
  await records.list(7, { townIds: [1, 2] }, database);
  assert.match(calls[2].sql, /r\.town_id IN/);
  assert.deepEqual(calls[2].params, [7, [1, 2], 10000, 0]);
  assert.deepEqual(await records.list(7, { townIds: [] }, database), []);
  assert.equal(calls.length, 3);
});
