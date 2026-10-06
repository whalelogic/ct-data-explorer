import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateDatasetCsv } from '../src/services/csv-validation.js';

const towns = [
  { id: 1, name: 'Hamden', geo_type: 'town' },
  { id: 2, name: 'West Hartford', geo_type: 'town' },
  { id: 3, name: 'Connecticut', geo_type: 'state' },
];

// Mirrors migrations/002_indicators.sql.
const indicators = ['pop', 'households', 'medhouseholdincome', 'povnumerator', 'povdenominator', 'squaremiles', 'poppersqmi']
  .map((key, i) => ({ id: 10 + i, key, derivation: 'direct' }))
  .concat({ id: 99, key: 'poverty_rate', derivation: 'ratio' });

const known = { towns, indicators };

test('accepts a valid file, with BOM, mixed-case headers and blank (unavailable) cells', () => {
  const csv = '﻿town,Pop,medhouseholdincome\nHamden,61045,98306\nwest hartford,63620,\nConnecticut,"3,624,508",95781\n';
  const result = validateDatasetCsv(csv, known);
  assert.deepEqual(result.problems, []);
  assert.equal(result.rowCount, 3);
  assert.equal(result.observations.length, 5);
  assert.deepEqual(result.observations.find((o) => o.townId === 3 && o.indicatorId === 10), {
    townId: 3,
    indicatorId: 10,
    value: 3624508,
  });
});

test('reports every row problem at once and returns no observations', () => {
  const csv = 'town,pop\nHartfrod,1\nHamden,abc\nHamden,5\nWest Hartford,6,7\n';
  const result = validateDatasetCsv(csv, known);
  assert.deepEqual(result.problems, [
    'Row 2: town "Hartfrod" does not match any Connecticut town',
    'Row 3: pop value "abc" is not a number',
    'Row 4: town "Hamden" already appears on row 3',
    'Row 5: expected 2 values but found 3',
  ]);
  assert.equal(result.observations.length, 0);
});

test('rejects unknown, computed, duplicate and missing columns', () => {
  const result = validateDatasetCsv('town,foo,poverty_rate,pop,POP\nHamden,1,2,3,4\n', known);
  assert.deepEqual(result.problems, [
    'Column "foo" is not a defined indicator. Define it in the upload form before uploading.',
    'Column "poverty_rate" is computed by the system and must not be uploaded',
    'Column "POP" appears more than once',
  ]);
  assert.deepEqual(validateDatasetCsv('name,pop\nHamden,1\n', known).problems, [
    'Missing required column "town"',
    'Column "name" is not a defined indicator. Define it in the upload form before uploading.',
  ]);
  assert.deepEqual(validateDatasetCsv('', known).problems, ['The file is empty']);
  assert.deepEqual(validateDatasetCsv('town,pop\n', known).problems, ['The file has no data rows']);
});

const sampleFile = new URL('../../sample-data/acs2024_sample.csv', import.meta.url);

test('the ACS 2024 sample extract validates cleanly', { skip: !existsSync(sampleFile) && 'sample data not present' }, () => {
  const csv = readFileSync(sampleFile);
  const sampleTowns = csv
    .toString('utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line, i) => ({ id: i + 1, name: line.split(',')[0] }));
  const result = validateDatasetCsv(csv, { towns: sampleTowns, indicators });
  assert.deepEqual(result.problems, []);
  assert.equal(result.rowCount, 170);
  assert.equal(result.observations.length, 170 * 7);
});

test('accepts the same number forms as the tabular parser (.5, 1., scientific notation)', () => {
  const csv = 'town,squaremiles,pop\nHamden,.5,1e3\nWest Hartford,1.,2.5E1\n';
  const result = validateDatasetCsv(csv, known);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.observations.map((o) => o.value), [0.5, 1000, 1, 25]);
});
