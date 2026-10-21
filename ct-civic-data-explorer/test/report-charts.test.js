import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChartBlocks } from '../src/services/report-charts.js';
import { renderRecordReport } from '../src/services/record-reports.js';
import { selectionSchema } from '../src/services/selection.js';

const places = [
  { label: 'Andover', geoType: 'town' },
  { label: 'Connecticut (statewide)', geoType: 'state' },
];

function indicator(key, unit, values = [12, 34]) {
  return {
    key,
    label: key,
    unit,
    decimals: unit === 'percent' ? 1 : 0,
    cells: values.map((value) => ({ value })),
  };
}

function chartedKeys(chartBlocks) {
  return chartBlocks.flatMap((block) => block.chart.series.map((series) => series.key));
}

test('grouped bars include both numeric indicators with their original values', () => {
  const rows = [indicator('Population', 'count'), indicator('Households', 'count', [null, 10])];
  const chartBlocks = buildChartBlocks({ chartType: 'grouped_bar', indicators: [] }, rows, places);

  assert.equal(chartBlocks.length, 1);
  assert.deepEqual(chartedKeys(chartBlocks), ['Population', 'Households']);
  assert.deepEqual(chartBlocks[0].chart.series[1].values, [null, 10]);
  assert.deepEqual(chartBlocks[0].chart.labels, ['Andover', 'Connecticut (statewide)']);
  assert.equal(chartBlocks[0].chart.benchmarkIndex, 1);
  assert.match(chartBlocks[0].chart.title, /Population/);
  assert.match(chartBlocks[0].chart.title, /Households/);
});

test('mixed-unit selections create separate charts without omitting measures', () => {
  const rows = [
    indicator('Population', 'count'),
    indicator('Income', 'currency', [50000, 75000]),
    indicator('Poverty', 'percent', [4.5, 9.1]),
    indicator('Households', 'count', [5, 15]),
  ];

  for (const chartType of ['grouped_bar', 'line']) {
    const selectedKeys = rows.map((row) => row.key);
    const chartBlocks = buildChartBlocks({ chartType, indicators: selectedKeys }, rows, places);
    assert.equal(chartBlocks.length, 3);
    assert.deepEqual(chartedKeys(chartBlocks), ['Population', 'Households', 'Income', 'Poverty']);
    assert.deepEqual(chartBlocks.map((block) => block.chart.unit), ['count', 'currency', 'percent']);
    assert.deepEqual(chartBlocks[2].chart.series[0].values, [4.5, 9.1]);
    assert.equal(chartBlocks[2].chart.decimals, 1);
  }
});

test('seven same-unit indicators span two charts and all 169 towns remain present', () => {
  const townPlaces = Array.from({ length: 169 }, (_, index) => ({
    label: `Town ${index + 1}`,
    geoType: 'town',
  }));
  const values = townPlaces.map((_, index) => index + 1);
  const rows = Array.from({ length: 7 }, (_, index) => indicator(`Measure ${index + 1}`, 'count', values));
  const chartBlocks = buildChartBlocks({ chartType: 'grouped_bar', indicators: [] }, rows, townPlaces);

  assert.deepEqual(chartBlocks.map((block) => block.chart.series.length), [6, 1]);
  assert.deepEqual(chartedKeys(chartBlocks), rows.map((row) => row.key));
  for (const block of chartBlocks) {
    assert.equal(block.chart.labels.length, 169);
    assert.equal(block.chart.labels.at(-1), 'Town 169');
    assert.deepEqual(block.chart.series[0].values, values);
  }
});

test('bar charts produce a separate chart for every requested numeric indicator', () => {
  const rows = [indicator('Population', 'count'), indicator('Households', 'count'), indicator('Income', 'currency')];
  const chartBlocks = buildChartBlocks({ chartType: 'bar', indicators: ['Households', 'Income'] }, rows, places);

  assert.deepEqual(chartedKeys(chartBlocks), ['Households', 'Income']);
  assert.deepEqual(chartBlocks.map((block) => block.chart.series.length), [1, 1]);
  assert.deepEqual(chartBlocks.map((block) => block.chart.title), ['Households', 'Income']);
});

function repeatedRowReport(rowCount) {
  const dataset = {
    name: 'Jobs by category',
    vintage: '2026',
    version: 1,
    source: 'Test dataset',
    columns: [
      { key: 'c0', label: 'Town', role: 'town', type: 'text' },
      { key: 'c1', label: 'Category', role: 'dimension', type: 'text' },
      { key: 'c2', label: 'Jobs', role: 'measure', type: 'number', unit: 'count', decimals: 0 },
      { key: 'c3', label: 'Share', role: 'measure', type: 'number', unit: 'percent', decimals: 1, scale: 100 },
    ],
  };
  const sourceRows = Array.from({ length: rowCount }, (_, index) => ({
    id: index + 1,
    town_id: 1,
    name: 'Andover',
    geo_type: 'town',
    source_row: index + 2,
    cell_values: { c0: 'Andover', c1: `Category ${index + 1}`, c2: 637, c3: 0.25 },
  }));
  const selection = selectionSchema.parse({
    dataset,
    towns: ['Andover'],
    benchmark: false,
    indicators: ['c1', 'c2', 'c3'],
  });
  return renderRecordReport(selection, dataset, sourceRows);
}

test('record charts preserve more than 40 repeated rows and skip only text fields', () => {
  const report = repeatedRowReport(45);
  const charts = report.blocks.filter((block) => block.type === 'chart');

  assert.deepEqual(chartedKeys(charts), ['c2', 'c3']);
  assert.equal(charts[0].chart.labels.length, 45);
  assert.equal(charts[0].chart.labels.at(-1), 'Andover — Category 45');
  assert.deepEqual(charts[0].chart.series[0].values, Array(45).fill(637));
  assert.deepEqual(charts[1].chart.series[0].values, Array(45).fill(25));
});

test('reports preserve all matching rows beyond the former 1000-row limit', () => {
  const report = repeatedRowReport(1001);
  const charts = report.blocks.filter((block) => block.type === 'chart');
  const table = report.blocks.find((block) => block.type === 'records');

  assert.equal(report.places.length, 1001);
  assert.equal(charts[0].chart.series[0].values.length, 1001);
  assert.equal(charts[0].chart.series[0].values.at(-1), 637);
  assert.equal(table.records.length, 1001);
  assert.deepEqual(table.records.at(-1).values, ['Andover', 'Category 1001', '637', '25.0%']);
});

test('large series projections are rejected before allocation and explicit category aggregation can reduce them', () => {
  const rowPlaces = Array.from({ length: 1000 }, (_, index) => ({ label: `Row ${index + 1}`, sourceRow: index + 2 }));
  const rows = Array.from({ length: 25 }, (_, index) => indicator(`m${index}`, 'count', Array(1000).fill(1)));
  const series = {
    key: 'series', label: 'Series', type: 'text',
    cells: rowPlaces.map((_, index) => ({ rawValue: String(index % 60), display: String(index % 60) })),
  };
  const category = {
    key: 'category', label: 'Category', type: 'text',
    cells: rowPlaces.map(() => ({ rawValue: 'All records', display: 'All records' })),
  };
  const block = { chartType: 'grouped_bar', indicators: [], axisField: 'category', seriesField: 'series' };
  const context = { fields: [...rows, series, category], rowBased: true };
  assert.throws(() => buildChartBlocks(block, rows, rowPlaces, context), /1,500,000 plotted cells.*Filter the rows.*explicitly aggregate/);
  const chartBlocks = buildChartBlocks({ ...block, aggregation: 'sum' }, rows, rowPlaces, context);
  assert.equal(chartBlocks.length, 250);
  assert.deepEqual(chartBlocks[0].chart.labels, ['All records']);
  assert.equal(chartBlocks[0].chart.series[0].values[0], 17);
});
