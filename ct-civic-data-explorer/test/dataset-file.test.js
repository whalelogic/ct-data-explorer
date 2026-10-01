import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateDatasetFile } from '../src/services/dataset-file.js';
import { validateDatasetCsv } from '../src/services/csv-validation.js';

const workbook = await readFile(new URL('./fixtures/dataset.xlsx', import.meta.url));
const known = {
  towns: [{ id: 1, name: 'Hamden' }, { id: 2, name: 'West Hartford' }],
  indicators: ['pop', 'povnumerator', 'povdenominator', 'medhouseholdincome']
    .map((key, index) => ({ id: index + 1, key, derivation: 'direct' })),
};

test('Excel first sheet and CSV produce identical numeric observations, skipping blank rows', async () => {
  const excel = await validateDatasetFile(workbook, { filename: 'data.XLSX' }, known);
  const csv = validateDatasetCsv('town,pop,povNumerator,povDenominator\nHamden,61045,5126,55147\nWest Hartford,64415,3953,62469', known);
  assert.deepEqual(excel, csv);
  assert.equal(excel.rowCount, 2);
});

test('a named worksheet is imported independently of the first sheet', async () => {
  const result = await validateDatasetFile(workbook, { filename: 'data.xlsx', worksheet: 'Income' }, known);
  assert.equal(result.problemCount, 0);
  assert.deepEqual(result.observations.map((row) => row.value), [98306, 129890]);
  assert.ok(result.observations.every((row) => row.indicatorId === 4));
});

test('invalid Excel rows keep spreadsheet row numbers and reject all observations', async () => {
  const result = await validateDatasetFile(workbook, { filename: 'data.xlsx', worksheet: 'Invalid' }, known);
  assert.equal(result.problemCount, 2);
  assert.ok(result.problems.every((problem) => problem.startsWith('Row 4:')));
  assert.deepEqual(result.observations, []);
});

test('empty worksheets and dates in numeric columns are rejected', async () => {
  for (const worksheet of ['Empty', 'Dates']) {
    const result = await validateDatasetFile(workbook, { filename: 'data.xlsx', worksheet }, known);
    assert.ok(result.problemCount > 0);
    assert.deepEqual(result.observations, []);
  }
});

test('missing sheets, invalid workbooks and unsupported formats return clear upload errors', async () => {
  await assert.rejects(validateDatasetFile(workbook, { filename: 'data.xlsx', worksheet: 'Missing' }, known),
    (err) => err.status === 422 && /Worksheet.*not found/.test(err.message));
  await assert.rejects(validateDatasetFile(Buffer.from('not a workbook'), { filename: 'data.xlsx' }, known),
    (err) => err.status === 422 && /could not be read/.test(err.message));
  await assert.rejects(validateDatasetFile(workbook, { filename: 'data.xls' }, known),
    (err) => err.status === 415);
});

test('existing CSV callers still work without a filename', async () => {
  const csv = 'town,pop\nHamden,61045';
  assert.deepEqual(await validateDatasetFile(csv, {}, known), validateDatasetCsv(csv, known));
});
