import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectTabularColumns, prepareTabularDataset } from '../src/services/tabular-data.js';
import { renderRecordReport } from '../src/services/record-reports.js';
import { selectionSchema } from '../src/services/selection.js';
import { describePlaces } from '../src/services/row-labels.js';
import { computeValue } from '../src/services/compute.js';
import { createSlug } from '../src/services/slugs.js';
import { renderReportPdf } from '../src/services/pdf/index.js';

const known = { towns: [{ id: 1, name: 'Andover' }, { id: 2, name: 'Bridgewater' }], indicators: [] };
const records = (rows) => rows.map((record, index) => ({ record: record.map((v) => v == null ? '' : String(v)), info: { lines: index + 1 } }));
const programs = records([
  ['Program', 'Region', 'Clients', 'Staff'],
  ['Food pantry', 'North', 1200, 8],
  ['Housing help', 'South', 300, 0],
  ['Food pantry', 'South', 900, 6],
  ['', 'North', 40, 2],
]);

/** Shape rows the way the dataset-records repository returns them. */
function reportInput(prepared, { townKeyed }) {
  return {
    dataset: {
      name: 'Programs', vintage: '2026', version: 1, source: 'Example workbook',
      columns: prepared.columns, rowLabelKey: prepared.rowLabelKey, townKeyed, approvedFields: null,
    },
    rows: prepared.rows.map((row, i) => ({
      id: i + 1, town_id: row.townId, town_name: null, geo_type: 'row', source_row: row.sourceRow, cell_values: row.cells,
    })),
  };
}

test('inspection suggests a Town column, or the first text column when there are no towns', () => {
  const towns = inspectTabularColumns(records([['Town', 'Jobs'], ['Andover', 5], ['Bridgewater', 7]]), known);
  assert.deepEqual(towns.suggested, { label: 'Town', isTown: true });
  const generic = inspectTabularColumns(programs, known);
  assert.deepEqual(generic.suggested, { label: 'Program', isTown: false });
  assert.equal(generic.columns.find((column) => column.label === 'Clients').isNumeric, true);
  assert.deepEqual(generic.columns[0].samples, ['Food pantry', 'Housing help']);
});

test('a dataset without towns uploads when its label column is chosen', () => {
  const missing = prepareTabularDataset(programs, known);
  assert.match(missing.problems[0], /Choose the column that identifies each row/);

  const prepared = prepareTabularDataset(programs, known, { labelColumn: 'program', labelIsTown: false });
  assert.equal(prepared.problemCount, 0);
  assert.equal(prepared.dataFormat, 'records');
  assert.equal(prepared.rowLabelKey, 'c0');
  assert.equal(prepared.columns[0].role, 'label');
  assert.ok(prepared.rows.every((row) => row.townId === null));
  assert.ok(prepared.notes.some((note) => note.includes('Program values have multiple rows')));
  assert.ok(prepared.notes.some((note) => note.includes('1 rows have no Program')));
});

test('a town label column still rejects names that are not Connecticut towns', () => {
  const prepared = prepareTabularDataset(programs, known, { labelColumn: 'Program', labelIsTown: true });
  assert.match(prepared.problems[0], /does not match a Connecticut town/);
});

test('reports over labeled rows select by label, keep repeats separate and compute custom ratios', async () => {
  const prepared = prepareTabularDataset(programs, known, { labelColumn: 'Program', labelIsTown: false });
  const { dataset, rows } = reportInput(prepared, { townKeyed: false });
  const selection = selectionSchema.parse({
    dataset,
    rows: ['Food pantry', 'Housing help'],
    benchmark: false,
    indicators: ['c2', 'ratio_1'],
    customIndicators: [{ key: 'ratio_1', label: 'Clients per staff member', numerator: 'c2', denominator: 'c3', decimals: 1 }],
    layout: [{ type: 'chart', indicators: ['c2'], colors: { c2: '#123456' } }, { type: 'table' }],
  });
  const selectedRows = rows.filter((row) => ['Food pantry', 'Housing help'].includes(row.cell_values.c0));
  const report = renderRecordReport(selection, dataset, selectedRows);

  assert.equal(report.rowNoun, 'Program');
  assert.equal(report.title, 'Programs');
  assert.deepEqual(report.places.map((place) => place.label), ['Food pantry — North', 'Housing help', 'Food pantry — South']);
  const chart = report.blocks.find((block) => block.type === 'chart').chart;
  assert.deepEqual(chart.series[0].values, [1200, 300, 900]);
  assert.equal(chart.series[0].color, '#123456');

  const ratio = report.indicators.find((row) => row.key === 'ratio_1');
  assert.deepEqual(ratio.cells.map((cell) => cell.display), ['150.0', 'N/A', '150.0']);
  const table = report.blocks.find((block) => block.type === 'records');
  assert.deepEqual(table.columns.map((column) => column.label), ['Program', 'Region', 'Clients', 'Clients per staff member']);
  assert.match((await renderReportPdf(report)).toString('ascii', 0, 8), /^%PDF-/);
});

test('custom ratios refuse unapproved or text fields', () => {
  const prepared = prepareTabularDataset(programs, known, { labelColumn: 'Program', labelIsTown: false });
  const { dataset, rows } = reportInput(prepared, { townKeyed: false });
  const base = { dataset, allRows: true, benchmark: false, indicators: ['c2', 'ratio_1'] };
  const textRatio = selectionSchema.parse({ ...base, customIndicators: [{ key: 'ratio_1', label: 'Bad', numerator: 'c1', denominator: 'c2' }] });
  assert.throws(() => renderRecordReport(textRatio, dataset, rows), /numerator must be a numeric field/);
  const hidden = { ...dataset, approvedFields: ['c2'] };
  const hiddenRatio = selectionSchema.parse({ ...base, customIndicators: [{ key: 'ratio_1', label: 'Hidden', numerator: 'c2', denominator: 'c3' }] });
  assert.throws(() => renderRecordReport(hiddenRatio, hidden, rows), /not approved/);
});

test('indicator-format custom ratios divide computed components', () => {
  const values = new Map([['pop', 64000], ['households', 25600], ['poor', 3200]]);
  const povertyRate = { key: 'poverty_rate', unit: 'percent', derivation: 'ratio', numerator_key: 'poor', denominator_key: 'pop' };
  const custom = { derivation: 'custom', numerator: { key: 'pop', derivation: 'direct' }, denominator: { key: 'households', derivation: 'direct' }, multiplier: 1 };
  assert.equal(computeValue(custom, values), 2.5);
  const ofRate = { ...custom, numerator: povertyRate, denominator: { key: 'pop', derivation: 'direct' }, multiplier: 1000 };
  assert.equal(computeValue(ofRate, values), (5 / 64000) * 1000);
  assert.equal(computeValue({ ...custom, denominator: { key: 'missing', derivation: 'direct' } }, values), null);
});

test('report slugs are readable and URL-safe', () => {
  assert.equal(createSlug('Hartford & New Haven: Housing (2024)'), 'hartford-new-haven-housing-2024');
  assert.equal(createSlug('Café résumé'), 'cafe-resume');
  assert.equal(createSlug('***'), 'report');
  assert.ok(createSlug('x'.repeat(200)).length <= 70);
});

test('county and planning region rows in a town column are kept as their own rows', () => {
  const geographies = {
    towns: [...known.towns, { id: 3, name: 'Fairfield County', geo_type: 'county' }, { id: 4, name: 'Capitol Planning Region', geo_type: 'region' }],
    indicators: [],
  };
  const file = records([['Town', 'Jobs', 'Sector'], ['Andover', 5, 'Retail'], ['Fairfield County', 900, 'Retail'], ['Capitol Planning Region', 700, 'Retail']]);
  const prepared = prepareTabularDataset(file, geographies, { labelColumn: 'Town', labelIsTown: true });
  assert.equal(prepared.problemCount, 0);
  assert.deepEqual(prepared.rows.map((row) => row.townId), [1, 3, 4]);
  assert.ok(prepared.notes.some((note) => note.includes('2 county or planning region labels were kept as their own rows')));

  const unknown = prepareTabularDataset(records([['Town', 'Jobs'], ['Gotham County', 1]]), geographies, { labelColumn: 'Town', labelIsTown: true });
  assert.match(unknown.problems[0], /"Gotham County" does not match a Connecticut town, county or planning region/);
});

test('default titles name towns, count one geography type and call mixed geographies places', () => {
  const town = (name) => ({ name, geoType: 'town' });
  const county = (name) => ({ name, geoType: 'county' });
  const state = { name: 'Connecticut', geoType: 'state' };
  assert.equal(describePlaces([town('Hartford'), town('New Haven'), state]), 'Hartford and New Haven');
  assert.equal(describePlaces(['A', 'B', 'C', 'D'].map(town)), '4 Connecticut towns');
  assert.equal(describePlaces(['A', 'B', 'C', 'D'].map(county)), '4 Connecticut counties');
  assert.equal(describePlaces([...['A', 'B', 'C'].map(town), county('Fairfield County')]), '4 Connecticut places');
  assert.equal(describePlaces([town('A'), county('Fairfield County')], true), 'All Connecticut places');
  assert.equal(describePlaces([state]), 'Connecticut');
});

test('dividing by a count gives one summary value for the report and is never charted', async () => {
  const prepared = prepareTabularDataset(programs, known, { labelColumn: 'Program', labelIsTown: false });
  const { dataset, rows } = reportInput(prepared, { townKeyed: false });
  const selection = selectionSchema.parse({
    dataset,
    allRows: true,
    benchmark: false,
    indicators: ['c2', 'ratio_1', 'ratio_2'],
    customIndicators: [
      { key: 'ratio_1', label: 'Average clients per row', numerator: 'c2', calculation: 'average', decimals: 0 },
      { key: 'ratio_2', label: 'Clients per staffed row', numerator: 'c2', calculation: 'average_filled', denominator: 'c1', decimals: 1 },
    ],
    layout: [{ type: 'chart', indicators: ['c2', 'ratio_1'] }, { type: 'table' }],
  });
  const report = renderRecordReport(selection, dataset, rows);
  assert.deepEqual(report.summaries.map((summary) => [summary.label, summary.value]), [
    ['Average clients per row', 610],
    ['Clients per staffed row', 610],
  ]);
  assert.equal(report.summaries[0].display, '610');
  assert.match(report.summaries[0].explanation, /^2,440 total Clients ÷ 4 rows$/);
  assert.ok(report.indicators.every((row) => !row.key.startsWith('ratio_')));
  const chart = report.blocks.find((block) => block.type === 'chart').chart;
  assert.deepEqual(chart.series.map((series) => series.key), ['c2']);
  assert.match((await renderReportPdf(report)).toString('ascii', 0, 8), /^%PDF-/);

  assert.throws(() => selectionSchema.parse({ ...selection, customIndicators: [{ key: 'ratio_1', label: 'X', numerator: 'c2', calculation: 'average_filled' }] }), /choose what to divide by/);
  const textTotal = selectionSchema.parse({
    dataset, allRows: true, benchmark: false, indicators: ['ratio_1'],
    customIndicators: [{ key: 'ratio_1', label: 'Bad', numerator: 'c1', calculation: 'average' }],
  });
  assert.throws(() => renderRecordReport(textTotal, dataset, rows), /choose a number field to summarize/);
});

test('summaries give the median, highest and lowest with who holds them, and the total', () => {
  const tied = records([
    ['Program', 'Clients'],
    ['Food pantry', 900],
    ['Housing help', 300],
    ['Job training', 900],
    ['Legal aid', 100],
  ]);
  const prepared = prepareTabularDataset(tied, known, { labelColumn: 'Program', labelIsTown: false });
  const { dataset, rows } = reportInput(prepared, { townKeyed: false });
  const calculations = ['median', 'highest', 'lowest', 'total'];
  const selection = selectionSchema.parse({
    dataset,
    allRows: true,
    benchmark: false,
    indicators: calculations.map((_, index) => `ratio_${index + 1}`),
    customIndicators: calculations.map((calculation, index) => ({
      key: `ratio_${index + 1}`, label: calculation, numerator: 'c1', calculation, decimals: 0,
    })),
  });
  const summaries = renderRecordReport(selection, dataset, rows).summaries;
  assert.deepEqual(summaries.map((summary) => [summary.label, summary.value]), [
    ['median', 600], ['highest', 900], ['lowest', 100], ['total', 2200],
  ]);
  assert.equal(summaries[0].explanation, 'Middle Clients value of 4 rows');
  assert.equal(summaries[1].explanation, 'Food pantry and Job training (tied), highest of 4 rows');
  assert.equal(summaries[2].explanation, 'Legal aid, lowest of 4 rows');
  assert.equal(summaries[3].display, '2,200');
});

test('summaries sit beside the same figure for every comparable row, unless switched off', () => {
  const towns = records([['Town', 'Jobs'], ['Andover', 5], ['Bridgewater', 7]]);
  const prepared = prepareTabularDataset(towns, known, { labelColumn: 'Town', labelIsTown: true });
  const { dataset, rows } = reportInput(prepared, { townKeyed: true });
  const placeRows = rows.map((row) => ({ ...row, geo_type: 'town', town_name: known.towns.find((town) => town.id === row.town_id).name }));
  const custom = (calculation, extra = {}) => ({ key: `ratio_${calculation.length}`, label: calculation, numerator: 'c1', calculation, decimals: 1, ...extra });
  const selection = selectionSchema.parse({
    dataset,
    rows: ['Andover'],
    benchmark: false,
    indicators: ['ratio_7', 'ratio_6'],
    customIndicators: [custom('average'), custom('lowest', { label: 'lowest', key: 'ratio_6' }), custom('highest', { key: 'ratio_9', benchmark: false })],
  });
  const andover = placeRows.filter((row) => row.town_name === 'Andover');
  const [average, lowest] = renderRecordReport(selection, dataset, andover, undefined, { datasetRows: placeRows }).summaries;
  assert.equal(average.display, '5.0');
  assert.equal(average.detail, 'For this town');
  assert.deepEqual(average.benchmark, {
    label: 'Average for a Connecticut town',
    scope: 'Connecticut, all 2 towns',
    value: 6,
    display: '6.0',
    explanation: 'Connecticut, all 2 towns: 12 total Jobs ÷ 2 towns',
  });
  assert.equal(lowest.detail, 'Andover');
  assert.equal(lowest.benchmark.label, 'Lowest in Connecticut: Andover');

  const switchedOff = selectionSchema.parse({ ...selection, indicators: ['ratio_9'] });
  const [highest] = renderRecordReport(switchedOff, dataset, andover, undefined, { datasetRows: placeRows }).summaries;
  assert.equal(highest.benchmark, undefined);

  const everyTown = selectionSchema.parse({ ...selection, rows: ['Andover', 'Bridgewater'] });
  assert.equal(renderRecordReport(everyTown, dataset, placeRows, undefined, { datasetRows: placeRows }).summaries[0].benchmark, undefined,
    'a report that already covers every town needs no benchmark');
});
