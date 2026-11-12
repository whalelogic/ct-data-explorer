import assert from 'node:assert/strict';
import { test } from 'node:test';
import { savedSelection } from '../src/services/reports.service.js';

const selection = {
  dataset: { name: 'ACS 5-Year Town Profile', vintage: '2024' },
  rows: ['Groton'],
  indicators: ['pop'],
};

test('a saved report is titled with its name unless it sets a different title', () => {
  assert.equal(savedSelection({ title: 'Southeastern CT income', selection }).title, 'Southeastern CT income');
  const custom = savedSelection({ title: 'Southeastern CT income', selection: { ...selection, title: 'Income by town' } });
  assert.equal(custom.title, 'Income by town');
});
