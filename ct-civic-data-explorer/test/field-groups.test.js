import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldUnitLabel, fieldValueLabel, groupFieldsByUnit } from '../src/shared/field-groups.js';

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

test('filter choices use displayed units and precision without changing the source filter value', () => {
  const value = '0.2';
  assert.equal(fieldValueLabel({ type: 'number', unit: 'percent', scale: 100, decimals: 1 }, value), '20.0%');
  assert.equal(value, '0.2');
  assert.equal(fieldValueLabel({ type: 'number', unit: 'currency', decimals: 0 }, '1234'), '$1,234');
  assert.equal(fieldValueLabel({ type: 'number', unit: 'number', decimals: 9 }, '10'), '10');
  assert.equal(fieldValueLabel({ type: 'text', unit: 'number' }, 'Health'), 'Health');
});
