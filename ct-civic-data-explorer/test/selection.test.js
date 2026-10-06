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
    { type: 'chart', chartType: 'grouped_bar', indicators: [] },
    { type: 'table', indicators: [] },
  ]);

  const minimal = selectionSchema.parse(base);
  assert.equal(minimal.benchmark, true);
  assert.deepEqual(minimal.layout, [
    { type: 'chart', chartType: 'bar', indicators: [] },
    { type: 'table', indicators: [] },
  ]);
});

test('saved reports with notes keep them as a text block after the figures', () => {
  const parsed = selectionSchema.parse({ ...base, blocks: ['chart', 'notes'], chart: { type: 'bar', indicators: ['pop'] }, notes: 'Hello' });
  assert.equal(parsed.showTitle, false);
  assert.deepEqual(parsed.layout, [
    { type: 'chart', chartType: 'bar', indicators: ['pop'] },
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
  assert.deepEqual(selectionSchema.parse({ ...base, layout }).layout, layout);
});

test('a report cannot be built with zero indicators, and the error says so', () => {
  assert.equal(firstError({ ...base, indicators: [] }), 'Select at least one indicator for the report');
});

test('one town plus at most three comparisons', () => {
  assert.equal(firstError({ ...base, towns: [] }), 'Choose a town');
  assert.equal(firstError({ ...base, towns: ['A', 'B', 'C', 'D', 'E'] }), 'Choose at most 3 comparison towns');
  assert.equal(firstError({ ...base, towns: ['Hamden', 'hamden'] }), '"hamden" is selected more than once');
});

test('block indicators must be on the report, and figures need a chart or a table', () => {
  assert.equal(firstError({ ...base, layout: [{ type: 'chart', indicators: ['households'] }] }), 'Chart indicator "households" is not on the report');
  assert.equal(firstError({ ...base, layout: [{ type: 'table', indicators: ['households'] }] }), 'Table indicator "households" is not on the report');
  assert.equal(firstError({ ...base, layout: [{ type: 'text', text: 'Only words' }] }), 'Include a chart or a table so the report shows its figures');
  assert.equal(firstError({ ...base, blocks: ['title', 'notes'] }), 'Include a chart or a table so the report shows its figures');
  assert.match(firstError({ ...base, layout: [{ type: 'image' }] }), /Each block must be one of: text, chart, table/);
});
