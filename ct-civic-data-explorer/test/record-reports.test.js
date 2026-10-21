import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRecordReport } from '../src/services/record-reports.js';
import { selectionSchema } from '../src/services/selection.js';

const dataset = {
  name: 'Source category data', displayName: 'Community programs', vintage: '2026', version: 1, source: 'Published records',
  columns: [
    { key: 'c0', label: 'Program area', role: 'dimension', type: 'text' },
    { key: 'c1', label: 'Year', role: 'measure', type: 'number', unit: 'number', decimals: 0 },
    { key: 'c2', label: 'People served', role: 'measure', type: 'number', unit: 'count', decimals: 0 },
    { key: 'c3', label: 'Spending', role: 'measure', type: 'number', unit: 'currency', decimals: 0 },
    { key: 'c4', label: 'Private', role: 'dimension', type: 'text' },
  ],
  approvedFields: ['c0', 'c1', 'c2', 'c3'],
};
const sourceRows = [
  { id: 1, source_row: 2, town_id: null, name: null, geo_type: null, cell_values: { c0: 'Health', c1: 2025, c2: 10, c3: 50, c4: 'Secret' } },
  { id: 2, source_row: 3, town_id: null, name: null, geo_type: null, cell_values: { c0: 'Health', c1: 2025, c2: 20, c3: 60, c4: 'Secret' } },
  { id: 3, source_row: 4, town_id: null, name: null, geo_type: null, cell_values: { c0: 'Housing', c1: 2026, c2: 5, c3: 70, c4: 'Secret' } },
];
function selection(options = {}) {
  return selectionSchema.parse({
    dataset, indicators: ['c2', 'c3'],
    layout: [{ type: 'chart', chartType: 'grouped_bar', axisField: 'c0', seriesField: 'c1' }, { type: 'table' }],
    ...options,
  });
}
function charts(report) {
  return report.blocks.filter((block) => block.type === 'chart').map((block) => block.chart);
}

test('category reports need no towns and preserve duplicate rows with independent axes and series', () => {
  const report = renderRecordReport(selection(), dataset, sourceRows);
  assert.equal(report.title, 'Community programs: People served · Spending');
  assert.equal(report.subtitle, 'Community programs, 2026');
  assert.equal(report.places.length, 3);
  assert.deepEqual(charts(report).map((chart) => chart.unit), ['count', 'currency']);
  const chart = charts(report)[0];
  assert.deepEqual(chart.labels, ['Health (source row 2)', 'Health (source row 3)', 'Housing']);
  assert.deepEqual(chart.series.map((series) => series.values), [[10, 20, null], [null, null, 5]]);
  assert.equal(chart.series[0].label, 'People served — 2,025');
  assert.equal(chart.benchmarkIndex, -1);
  assert.equal(chart.axisLabel, 'Program area');
  assert.equal(chart.categoryLabel, 'Rows');
  assert.match(chart.title, /Community programs.*People served.*Program area.*Year/);
  const table = report.blocks.find((block) => block.type === 'records');
  assert.deepEqual(table.columns.map((column) => column.key), ['c2', 'c3']);
  assert.deepEqual(table.records.map((record) => record.values), [['10', '$50'], ['20', '$60'], ['5', '$70']]);
});

test('explicit aggregation alone combines categories; the table always retains source rows', () => {
  const expected = { sum: 30, average: 15, min: 10, max: 20 };
  for (const [aggregation, value] of Object.entries(expected)) {
    const report = renderRecordReport(selection({
      layout: [{ type: 'chart', axisField: 'c0', seriesField: 'c1', aggregation }, { type: 'table' }],
    }), dataset, sourceRows);
    const chart = charts(report)[0];
    assert.deepEqual(chart.labels, ['Health', 'Housing']);
    assert.deepEqual(chart.series.map((series) => series.values), [[value, null], [null, 5]]);
    assert.equal(chart.categoryLabel, 'Categories');
    assert.equal(report.blocks.find((block) => block.type === 'records').records.length, 3);
  }
});

test('unselected approved numeric fields can filter source rows by their exact raw values', () => {
  const report = renderRecordReport(selection({ recordFilters: { c1: '2025' } }), dataset, sourceRows);
  assert.equal(report.places.length, 2);
  assert.deepEqual(charts(report)[0].series[0].values, [10, 20]);
  assert.throws(() => renderRecordReport(selection({ recordFilters: { c1: '2024' } }), dataset, sourceRows), /No source rows/);
});

test('hidden fields cannot be used as chart axes, series, measures or filters', () => {
  for (const options of [
    { layout: [{ type: 'chart', axisField: 'c4' }] },
    { layout: [{ type: 'chart', seriesField: 'c4' }] },
    { indicators: ['c4'] },
    { recordFilters: { c4: 'Secret' } },
  ]) {
    assert.throws(() => renderRecordReport(selection(options), dataset, sourceRows), /not approved/);
  }
});

test('nongeographic datasets reject towns, statewide benchmarks and geographic chart controls', () => {
  for (const options of [
    { towns: ['Andover'] },
    { benchmark: true },
    { layout: [{ type: 'chart', axisField: '@location' }] },
    { layout: [{ type: 'chart', seriesField: '@location' }] },
  ]) {
    assert.throws(() => renderRecordReport(selection(options), dataset, sourceRows), /not available/);
  }
});

test('matched geographic choices use this dataset version and never fabricate statewide comparisons', () => {
  const rows = sourceRows.map((row, index) => ({
    ...row, town_id: index === 2 ? 2 : 1, name: index === 2 ? 'Bridgewater' : 'Andover', geo_type: 'town',
  }));
  const report = renderRecordReport(selection({ towns: ['Andover'] }), dataset, rows);
  assert.equal(report.places.length, 2);
  assert.throws(() => renderRecordReport(selection({ towns: ['Hartford'] }), dataset, rows), /not available/);
  assert.throws(() => renderRecordReport(selection({ benchmark: true }), dataset, rows), /not available/);
});

test('source-row axes distinguish category rows and explicit titles survive regeneration', () => {
  const report = renderRecordReport(selection({
    title: 'My editable report', subtitle: 'My context',
    layout: [{ type: 'chart', axisField: '@row', title: 'My editable chart' }],
  }), dataset, sourceRows);
  assert.equal(report.title, 'My editable report');
  assert.equal(report.subtitle, 'My context');
  assert.deepEqual(charts(report)[0].labels, ['Source row 2', 'Source row 3', 'Source row 4']);
  assert.ok(charts(report).every((chart) => chart.title.startsWith('My editable chart')));
});

test('averages keep fractional precision and entirely missing categories remain null', () => {
  const rows = sourceRows.map((row, index) => ({ ...row, cell_values: { ...row.cell_values, c2: index === 2 ? null : index + 1 } }));
  const report = renderRecordReport(selection({
    indicators: ['c2'], layout: [{ type: 'chart', axisField: 'c0', aggregation: 'average' }],
  }), dataset, rows);
  assert.deepEqual(charts(report)[0].series[0].values, [1.5, null]);
  assert.equal(charts(report)[0].decimals, 2);
});

test('high-cardinality series produce an actionable error without dropping any values', () => {
  const rows = Array.from({ length: 61 }, (_, index) => ({
    ...sourceRows[0], id: index + 1, source_row: index + 2,
    cell_values: { ...sourceRows[0].cell_values, c1: index },
  }));
  assert.throws(() => renderRecordReport(selection(), dataset, rows), /61 distinct values.*at most 60/);
});

test('category aggregation keeps statewide comparison totals separate from town source rows', () => {
  const rows = [
    { ...sourceRows[0], town_id: 1, name: 'Andover', geo_type: 'town' },
    { ...sourceRows[1], town_id: 2, name: 'Connecticut', geo_type: 'state', cell_values: { ...sourceRows[1].cell_values, c2: 100 } },
  ];
  const report = renderRecordReport(selection({
    benchmark: true, indicators: ['c2'],
    layout: [{ type: 'chart', axisField: 'c0', aggregation: 'sum' }],
  }), dataset, rows);
  const chart = charts(report)[0];
  assert.deepEqual(chart.labels, ['Health', 'Health (statewide)']);
  assert.deepEqual(chart.series[0].values, [10, 100]);
  assert.equal(chart.places[1].geoType, 'state');
  assert.equal(chart.benchmarkIndex, 1);
  const raw = renderRecordReport(selection({
    benchmark: true, indicators: ['c2'], layout: [{ type: 'chart', axisField: 'c0' }],
  }), dataset, rows);
  assert.deepEqual(charts(raw)[0].labels, ['Health', 'Health (statewide)']);
  assert.deepEqual(charts(raw)[0].series[0].values, [10, 100]);
});
