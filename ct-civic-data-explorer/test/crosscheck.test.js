import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossCheckFigures, extractFigures } from '../src/services/ai/crosscheck.js';
import { summaryFacts } from '../src/services/ai/index.js';

const card = {
  dataset: { name: 'ACS 5-Year Town Profile', source: 'U.S. Census Bureau', vintage: '2024' },
  places: [
    { name: 'West Hartford', geoType: 'town' },
    { name: 'Connecticut', geoType: 'state' },
  ],
  indicators: [
    { displayLabel: 'Median Household Income', cells: [{ value: 129890, display: '$129,890' }, { value: 95781, display: '$95,781' }] },
    { displayLabel: 'Poverty Rate', cells: [{ value: 6.3279, display: '6.3%' }, { value: 10.0167, display: '10.0%' }] },
  ],
};

test('extracts figures with their stated precision', () => {
  assert.deepEqual(
    extractFigures('Income was $129,890, about $130 thousand; poverty 6.3% and 10 percent.').map((f) => [f.raw, f.value]),
    [['$129,890', 129890], ['$130 thousand', 130000], ['6.3%', 6.3], ['10 percent', 10]],
  );
});

test('figures copied or fairly rounded from the card pass', () => {
  const text =
    'In the 2024 ACS 5-Year profile, West Hartford had a median household income of $129,890, above the statewide $95,781 ' +
    '(roughly $130 thousand versus $96 thousand). Its poverty rate of 6.3% was lower than the statewide 10.0%.';
  assert.deepEqual(crossCheckFigures(text, card), []);
});

test('numbers that are not on the card are flagged', () => {
  const text = 'West Hartford earned $129,980, and its poverty rate was 3.7 points below the state.';
  assert.deepEqual(
    crossCheckFigures(text, card).map((m) => m.figure),
    ['$129,980', '3.7'],
  );
});

test('only public aggregate figures and labels are sent to the provider', () => {
  assert.deepEqual(summaryFacts(card), {
    dataset: { name: 'ACS 5-Year Town Profile', source: 'U.S. Census Bureau', vintage: '2024' },
    places: [
      { name: 'West Hartford', type: 'town' },
      { name: 'Connecticut', type: 'statewide' },
    ],
    indicators: [
      { label: 'Median Household Income', values: { 'West Hartford': '$129,890', Connecticut: '$95,781' } },
      { label: 'Poverty Rate', values: { 'West Hartford': '6.3%', Connecticut: '10.0%' } },
    ],
  });
});
