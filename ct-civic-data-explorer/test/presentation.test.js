import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyFieldPresentation, appendFieldNotes, datasetPresentationSchema } from '../src/services/presentation.js';
import { selectionSchema } from '../src/services/selection.js';
import { buildChartBlocks } from '../src/services/report-charts.js';
import { presentDataset } from '../src/services/presenters.js';

const fields = [
  { key: 'c0', label: 'Town', role: 'town', type: 'text' },
  { key: 'c1', label: 'Jobs', type: 'number', unit: 'count', decimals: 2 },
  { key: 'c2', label: 'Internal total', type: 'number', unit: 'count', decimals: 0 },
];

test('shared labels and report overrides preserve identity, units and source definitions', () => {
  const snapshot = structuredClone(fields);
  const shared = { fieldOrder: ['c2', 'c1'], fields: { c1: { label: 'Employment', decimals: 1, description: 'Jobs reported by employers' } } };
  const renamed = applyFieldPresentation(fields, shared, { c1: { label: 'Local jobs', decimals: 0 } });
  assert.deepEqual(renamed.map((field) => field.key), ['c0', 'c2', 'c1']);
  assert.equal(renamed[2].label, 'Local jobs');
  assert.equal(renamed[2].description, 'Jobs reported by employers');
  assert.equal(renamed[2].decimals, 0);
  assert.equal(renamed[2].unit, 'count');
  assert.deepEqual(fields, snapshot);
});

test('presentation metadata never reveals withheld field labels or notes', () => {
  const dataset = presentDataset({
    name: 'Original source', data_format: 'records', column_definitions: fields,
    approved_fields: ['c1'], presentation: { displayName: 'Town jobs', fields: { c2: { label: 'Hidden label', description: 'Hidden note' } } },
  });
  assert.equal(dataset.name, 'Original source');
  assert.equal(dataset.displayName, 'Town jobs');
  assert.deepEqual(dataset.columns.map((field) => field.key), ['c0', 'c1']);
  assert.ok(!JSON.stringify(dataset).includes('Hidden'));
});

test('custom chart titles keep split charts identifiable and retain numeric values', () => {
  const rows = [
    { key: 'jobs', label: 'Employment', unit: 'count', decimals: 1, cells: [{ value: 23.45 }] },
    { key: 'pay', label: 'Pay', unit: 'currency', decimals: 0, cells: [{ value: 45000 }] },
  ];
  const blocks = buildChartBlocks({ chartType: 'grouped_bar', indicators: [], title: 'Local economy' }, rows, [{ label: 'Andover' }]);
  assert.deepEqual(blocks.map((block) => block.chart.title), ['Local economy — Employment', 'Local economy — Pay']);
  assert.equal(blocks[0].chart.series[0].values[0], 23.45);
});

test('field notes remain plain text rather than executable markup', () => {
  const blocks = [];
  appendFieldNotes(blocks, [{ label: '<script>title</script>', description: '<img src=x onerror=alert(1)>' }]);
  assert.equal(blocks[0].nodes[1].runs[1].text, '<img src=x onerror=alert(1)>');
  assert.equal(blocks[0].nodes[1].runs[1].href, undefined);
});

test('presentation validation rejects changing values or units, invalid precision and unselected overrides', () => {
  assert.equal(datasetPresentationSchema.safeParse({ revision: 0, fields: { c1: { unit: 'percent' } } }).success, false);
  assert.equal(datasetPresentationSchema.safeParse({ revision: 0, fields: { c1: { decimals: 5 } } }).success, false);
  assert.equal(selectionSchema.safeParse({
    dataset: { name: 'Jobs', vintage: '2026' }, towns: ['Andover'], indicators: ['c1'], fieldOverrides: { c2: { label: 'Hidden' } },
  }).success, false);
});
