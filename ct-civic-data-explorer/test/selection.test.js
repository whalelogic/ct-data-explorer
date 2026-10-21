import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectionSchema } from '../src/services/selection.js';

const base = {
  dataset: { name: 'ACS 5-Year Town Profile', vintage: '2024' },
  towns: ['West Hartford', 'Hamden'],
  indicators: ['pop', 'medhouseholdincome', 'poverty_rate'],
};

const firstError = (input) => selectionSchema.safeParse(input).error?.issues[0]?.message;

test('the SRS example selection (the pre-layout shape) is upgraded to a layout', () => {
  const parsed = selectionSchema.parse({ ...base, benchmark: true, blocks: ['title', 'chart', 'table', 'source'], chart: { type: 'grouped_bar' } });
  assert.equal(parsed.showTitle, true);
  assert.deepEqual(parsed.layout, [
    { type: 'chart', chartType: 'grouped_bar', indicators: [], aggregation: 'none' },
    { type: 'table', indicators: [] },
  ]);

  const minimal = selectionSchema.parse(base);
  assert.equal(minimal.benchmark, false);
  assert.deepEqual(minimal.layout, [
    { type: 'chart', chartType: 'grouped_bar', indicators: [], aggregation: 'none' },
    { type: 'table', indicators: [] },
  ]);
});

test('saved reports with notes keep them as a text block after the figures', () => {
  const parsed = selectionSchema.parse({ ...base, blocks: ['chart', 'notes'], chart: { type: 'bar', indicators: ['pop'] }, notes: 'Hello' });
  assert.equal(parsed.showTitle, false);
  assert.deepEqual(parsed.layout, [
    { type: 'chart', chartType: 'bar', indicators: ['pop'], aggregation: 'none' },
    { type: 'text', text: 'Hello' },
  ]);
  const withoutBlock = selectionSchema.parse({ ...base, blocks: ['table'], notes: 'Hidden' });
  assert.deepEqual(withoutBlock.layout, [{ type: 'table', indicators: [] }]);
});

test('a layout can hold several charts, tables and text blocks in any order', () => {
  const layout = [
    { type: 'text', text: '# Income' },
    { type: 'chart', chartType: 'bar', indicators: ['medhouseholdincome'] },
    { type: 'text', text: '# Poverty' },
    { type: 'chart', chartType: 'bar', indicators: ['poverty_rate'] },
    { type: 'table', indicators: ['pop'] },
  ];
  assert.deepEqual(selectionSchema.parse({ ...base, layout }).layout,
    layout.map((block) => block.type === 'chart' ? { ...block, aggregation: 'none' } : block));
});

test('a report cannot be built with zero fields, and the error says so', () => {
  assert.equal(firstError({ ...base, indicators: [] }), 'Select at least one field for the report');
});

test('town selections are optional while duplicate selections are rejected', () => {
  const townNames = Array.from({ length: 169 }, (_, index) => `Town ${index + 1}`);
  assert.deepEqual(selectionSchema.parse({ ...base, towns: townNames }).towns, townNames);
  assert.deepEqual(selectionSchema.parse({ ...base, towns: [] }).towns, []);
  assert.deepEqual(selectionSchema.parse({ dataset: base.dataset, indicators: ['category'] }).towns, []);
  assert.equal(firstError({ ...base, towns: ['Hamden', 'hamden'] }), '"hamden" is selected more than once');
});

test('charts accept independent axes, series and explicit aggregation without requiring those fields in a table', () => {
  const selection = selectionSchema.parse({
    dataset: base.dataset,
    indicators: ['amount'],
    recordFilters: { category: 'Health' },
    layout: [{ type: 'chart', indicators: ['amount'], axisField: 'category', seriesField: 'year', aggregation: 'average' }],
  });
  assert.equal(selection.layout[0].axisField, 'category');
  assert.equal(selection.layout[0].seriesField, 'year');
  assert.equal(selection.layout[0].aggregation, 'average');
  assert.equal(selection.benchmark, false);
  assert.equal(selectionSchema.safeParse({ ...base, layout: [{ type: 'chart', aggregation: 'median' }] }).success, false);
});

test('a chart can request all 25 selected fields for automatic grouping', () => {
  const indicators = Array.from({ length: 25 }, (_, index) => `measure${index + 1}`);
  const selection = selectionSchema.parse({
    ...base,
    indicators,
    layout: [{ type: 'chart', indicators }],
  });
  assert.equal(selection.layout[0].chartType, 'grouped_bar');
  assert.deepEqual(selection.layout[0].indicators, indicators);
});

test('block indicators must be on the report, and figures need a chart or a table', () => {
  assert.equal(firstError({ ...base, layout: [{ type: 'chart', indicators: ['households'] }] }), 'Chart indicator "households" is not on the report');
  assert.equal(firstError({ ...base, layout: [{ type: 'table', indicators: ['households'] }] }), 'Table indicator "households" is not on the report');
  assert.equal(firstError({ ...base, layout: [{ type: 'text', text: 'Only words' }] }), 'Include a chart or a table so the report shows its figures');
  assert.equal(firstError({ ...base, blocks: ['title', 'notes'] }), 'Include a chart or a table so the report shows its figures');
  assert.match(firstError({ ...base, layout: [{ type: 'image' }] }), /Each block must be one of: text, chart, table/);
});
