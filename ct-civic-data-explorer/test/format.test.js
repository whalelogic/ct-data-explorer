import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeValue } from '../src/services/compute.js';
import { formatAxisValue, formatValue, indicatorLabel } from '../src/shared/format.js';

const povertyRate = {
  key: 'poverty_rate',
  unit: 'percent',
  decimals: 1,
  derivation: 'ratio',
  numerator_key: 'povnumerator',
  denominator_key: 'povdenominator',
};

const rate = (numerator, denominator) =>
  computeValue(povertyRate, new Map([['povnumerator', numerator], ['povdenominator', denominator]]));

test('poverty rate matches hand-computed values from the ACS 2024 extract (SRS §6.1)', () => {
  assert.equal(formatValue(rate(5126, 55147), povertyRate), '9.3%'); // Hamden
  assert.equal(formatValue(rate(3953, 62469), povertyRate), '6.3%'); // West Hartford
  assert.equal(formatValue(rate(353604, 3530170), povertyRate), '10.0%'); // Connecticut
});

test('a ratio with a missing or zero component is unavailable, not zero', () => {
  assert.equal(computeValue(povertyRate, new Map([['povnumerator', 10]])), null);
  assert.equal(rate(10, 0), null);
  assert.equal(computeValue(povertyRate, undefined), null);
  assert.equal(formatValue(null, povertyRate), 'N/A');
});

test('direct indicators read the stored value', () => {
  const income = { key: 'medhouseholdincome', unit: 'currency', decimals: 0, derivation: 'direct' };
  assert.equal(computeValue(income, new Map([['medhouseholdincome', 129890]])), 129890);
  assert.equal(computeValue(income, new Map()), null);
});

test('formatting: separators for counts and currency, fixed decimals for rates and density', () => {
  assert.equal(formatValue(129890, { unit: 'currency', decimals: 0 }), '$129,890');
  assert.equal(formatValue(61045, { unit: 'count', decimals: 0 }), '61,045');
  assert.equal(formatValue(204.01294498381878, { unit: 'density', decimals: 1 }), '204.0');
  assert.equal(formatValue(3161.6279069767443, { unit: 'density', decimals: 1 }), '3,161.6');
  assert.equal(formatValue(22.3, { unit: 'area', decimals: 2 }), '22.30');
});

test('axis labels and unit-bearing indicator labels', () => {
  assert.equal(formatAxisValue(130000, { unit: 'currency' }), '$130K');
  assert.equal(formatAxisValue(7.5, { unit: 'percent' }), '7.5%');
  assert.equal(indicatorLabel({ label: 'Population Density', unit: 'density' }), 'Population Density (per sq mi)');
  assert.equal(indicatorLabel({ label: 'Population', unit: 'count' }), 'Population');
});
