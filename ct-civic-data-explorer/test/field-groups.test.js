import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldUnitLabel, groupFieldsByUnit } from '../src/shared/field-groups.js';

test('field groups preserve identity and within-unit order without mutating the selected fields', () => {
  const fields = [
    { key: 'pop', label: 'Residents', unit: 'count' },
    { key: 'income', label: 'Income', unit: 'currency' },
    { key: 'households', label: 'Households', unit: 'count' },
    { key: 'poverty', label: 'Poverty', unit: 'percent' },
    { key: 'note', label: 'Notes', type: 'text' },
  ];
  const snapshot = structuredClone(fields);
  const groups = groupFieldsByUnit(fields);
  assert.deepEqual(groups.map((group) => group.label), ['Count', 'US dollars', 'Percent', 'Text / category']);
  assert.deepEqual(groups[0].fields.map((field) => field.key), ['pop', 'households']);
  assert.equal(groups[1].fields[0], fields[1]);
  assert.deepEqual(fields, snapshot);
});

test('generic numbers and text have readable labels while different units remain separate', () => {
  assert.equal(fieldUnitLabel({ type: 'number', unit: 'number' }), 'Number');
  assert.equal(fieldUnitLabel({ type: 'text', unit: 'currency' }), 'Text / category');
  assert.equal(fieldUnitLabel({ unit: 'area' }), 'Square miles');
  assert.equal(fieldUnitLabel({ unit: 'density' }), 'People per square mile');
  assert.equal(groupFieldsByUnit([{ unit: 'count' }, { unit: 'number' }, { unit: 'custom' }]).length, 3);
  assert.deepEqual(groupFieldsByUnit([]), []);
});
