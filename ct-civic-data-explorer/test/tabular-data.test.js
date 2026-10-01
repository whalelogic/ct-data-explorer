import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareTabularDataset, formatDatasetCell } from '../src/services/tabular-data.js';
import { renderRecordReport } from '../src/services/record-reports.js';
import { selectionSchema } from '../src/services/selection.js';
import { renderCardPdf } from '../src/services/pdf/index.js';

const known = { towns: [{ id: 1, name: 'Andover' }, { id: 2, name: 'Bridgewater' }],
  indicators: [{ id: 1, key: 'pop', label: 'Population', unit: 'count', decimals: 0, derivation: 'direct' }] };
const records = (rows) => rows.map((record, index) => ({ record: record.map((v) => v == null ? '' : String(v)), info: { lines: index + 1 } }));
const industry = records([
  ['Town', 'Top_2_digit_NAICS', 'Jobs_2_digit', 'Percentage (decimal format)', 'Total Jobs'],
  ['Andover', 'Government', 369, 0.550135501, 637],
  ['Andover', 'Construction', 59, 0.949152542, 637],
]);

function reportInput(prepared) {
  return { dataset: { name: 'Industry jobs', vintage: '2026', version: 1, source: 'Example workbook', columns: prepared.columns },
    rows: prepared.rows.map((row, i) => ({ id: i + 1, town_id: row.townId, name: known.towns.find((t) => t.id === row.townId).name,
      geo_type: 'town', source_row: row.sourceRow, cell_values: row.cells })) };
}

test('repeated towns retain separate categories, decimal precision and repeated totals', () => {
  const result = prepareTabularDataset(industry, known);
  assert.equal(result.problemCount, 0);
  assert.equal(result.dataFormat, 'records');
  assert.equal(result.rowCount, 2);
  assert.equal(result.rows[0].cells.c3, 0.550135501);
  assert.deepEqual(result.rows.map((row) => row.cells.c4), [637, 637]);
  assert.equal(result.columns[1].type, 'text');
  assert.equal(formatDatasetCell(result.rows[0].cells.c3, result.columns[3]), '55.0%');
  assert.ok(result.notes.some((note) => note.includes('not automatically summed')));
});

test('employers, blanks and a populated unnamed note column are preserved', () => {
  const note = "Left blank at municipality's request";
  const result = prepareTabularDataset(records([
    ['Received', 'TOWN', 'KEY EMPLOYER 1', null, null], ['Yes ', 'Bridgewater', null, note, null],
  ]), known);
  assert.equal(result.problemCount, 0);
  assert.equal(result.columns.length, 4);
  assert.equal(result.columns[3].label, 'Unnamed column 4');
  assert.equal(result.rows[0].cells.c2, null);
  assert.equal(result.rows[0].cells.c3, note);
});

test('new numeric headers require no global indicator registration', () => {
  const result = prepareTabularDataset(records([['Town', ' 2024_population 45 min drive time '], ['Andover', 1111745]]), known);
  assert.equal(result.problemCount, 0);
  assert.equal(result.columns[1].label, '2024_population 45 min drive time');
  assert.equal(result.columns[1].type, 'number');
  assert.equal(result.rows[0].cells.c1, 1111745);
});

test('parenthetical town qualifiers match a known town without losing the source label', () => {
  const result = prepareTabularDataset(records([['Town', 'Employer'], ['Andover (example label)', 'Local employer']]), known);
  assert.equal(result.problemCount, 0);
  assert.equal(result.rows[0].townId, 1);
  assert.equal(result.rows[0].cells.c0, 'Andover (example label)');
  assert.ok(result.notes.some((note) => note.includes('original label is retained')));
});

test('identical source rows remain distinct rather than being deduplicated', () => {
  const result = prepareTabularDataset(records([['Town', 'Industry', 'Jobs'], ['Andover', 'Construction', 10], ['Andover', 'Construction', 10]]), known);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.rows.map((row) => row.sourceRow), [2, 3]);
});

test('duplicate headers, unknown towns and invalid known numeric columns reject the whole file', () => {
  for (const input of [
    [['Town', 'pop'], ['Unknown town', 1]],
    [['Town', 'pop'], ['Andover', 'bad number']],
    [['Town', 'Town', 'pop'], ['Andover', 'Andover', 1]],
    [['Town', 'Industry', 'industry'], ['Andover', 'A', 'B']],
  ]) {
    const result = prepareTabularDataset(records(input), known);
    assert.ok(result.problemCount > 0);
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.observations, []);
  }
});

test('existing unique numeric datasets retain the legacy calculation path', () => {
  const result = prepareTabularDataset(records([['Town', 'pop'], ['Andover', 123]]), known);
  assert.equal(result.dataFormat, 'indicators');
  assert.deepEqual(result.observations, [{ townId: 1, indicatorId: 1, value: 123 }]);
});

test('record reports filter categories without summing and render tables to PDF', async () => {
  const prepared = prepareTabularDataset(industry, known);
  const { dataset, rows } = reportInput(prepared);
  const selection = selectionSchema.parse({ dataset, towns: ['Andover'], indicators: ['c1', 'c2', 'c3', 'c4'], benchmark: false });
  const report = renderRecordReport(selection, dataset, rows);
  assert.deepEqual(report.blocks[0].chart.series[0].values, [369, 59]);
  assert.equal(report.blocks[1].records.length, 2);
  const filtered = renderRecordReport({ ...selection, recordFilters: { c1: 'Government' } }, dataset, rows);
  assert.equal(filtered.blocks[1].records.length, 1);
  assert.match((await renderCardPdf(report)).toString('ascii', 0, 8), /^%PDF-/);
  assert.throws(() => renderRecordReport({ ...selection, recordFilters: { c99: 'Anything' } }, dataset, rows), /Unknown category/);
});

test('text-only reports include the original note and no fabricated chart', async () => {
  const prepared = prepareTabularDataset(records([['Town', 'Employer', 'Note'], ['Bridgewater', '', 'Blank by request']]), known);
  const { dataset, rows } = reportInput(prepared);
  const selection = selectionSchema.parse({ dataset, towns: ['Bridgewater'], indicators: ['c1', 'c2'], benchmark: false });
  const report = renderRecordReport(selection, dataset, rows);
  assert.ok(!report.blocks.some((block) => block.type === 'chart'));
  assert.deepEqual(report.blocks[0].records[0].values, ['Bridgewater', 'N/A', 'Blank by request']);
  assert.ok((await renderCardPdf(report)).length > 1000);
});
