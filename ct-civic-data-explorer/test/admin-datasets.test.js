import assert from 'node:assert/strict';
import { test } from 'node:test';
import { datasetFilterChoices, defaultDatasetQuery, filterAndSortDatasets } from '../public/js/admin-datasets.js';

const datasets = [
  { id: 1, name: 'ACS housing', displayName: 'Housing 10', source: 'Census Bureau', vintage: '2024', version: 10, rowCount: 1200, uploadedAt: '2026-01-02T00:00:00Z', isActive: true, curationReviewed: true },
  { id: 2, name: 'ACS housing', displayName: 'Housing 2', source: 'Census Bureau', vintage: '2024', version: 2, rowCount: 90, uploadedAt: '2026-01-01T19:00:00-05:00', isActive: false, curationReviewed: false },
  { id: 3, name: 'Schools', source: 'Education', vintage: '2023', version: 1, rowCount: 100, uploadedAt: '2025-12-31T00:00:00Z', isActive: true, curationReviewed: false },
  { id: 4, name: 'Employment', source: { name: 'Labor Department' }, vintage: '2024', version: 3, rowCount: 200, uploadedAt: '2026-01-03T00:00:00Z', isActive: false, curationReviewed: true },
];

function ids(query, rows = datasets) {
  return filterAndSortDatasets(rows, query).map((dataset) => dataset.id);
}

test('dataset search combines display and source names, vintage, publication, and review', () => {
  assert.deepEqual(ids({ search: 'HOUSING census 2024', vintage: '2024', publication: 'unpublished', review: 'needs-review' }), [2]);
  assert.deepEqual(ids({ search: 'acs', review: 'reviewed' }), [1]);
  assert.deepEqual(ids({ search: 'labor' }), [4]);
  assert.deepEqual(ids({ vintage: '202' }), []);
  assert.deepEqual(ids({ search: 'unmatched' }), []);
});

test('the default query retains unpublished datasets and resets every filter', () => {
  const query = defaultDatasetQuery();
  assert.deepEqual(query, { search: '', vintage: '', publication: '', review: '', sortKey: 'uploadedAt', sortDirection: 'descending' });
  Object.assign(query, { search: 'Schools', vintage: '2023', publication: 'published', review: 'needs-review', sortKey: 'name', sortDirection: 'ascending' });
  assert.deepEqual(ids(query), [3]);
  assert.deepEqual(ids(defaultDatasetQuery()), [4, 1, 2, 3]);
  assert.deepEqual(defaultDatasetQuery().search, '');
});

test('dataset filtering and sorting do not mutate the list, its objects, or query', () => {
  const rows = Object.freeze(datasets.map((dataset) => Object.freeze({ ...dataset })));
  const query = Object.freeze({ search: 'housing', sortKey: 'name', sortDirection: 'ascending' });
  const result = filterAndSortDatasets(rows, query);
  assert.deepEqual(result.map((dataset) => dataset.id), [2, 1]);
  assert.equal(result[0], rows[1]);
  assert.deepEqual(rows.map((dataset) => dataset.id), [1, 2, 3, 4]);
});

test('names use display names, natural numeric order, and stable case-insensitive ties', () => {
  const rows = [
    { id: 1, name: 'Zebra', displayName: 'Area 10' },
    { id: 2, name: 'Area 2' },
    { id: 3, displayName: 'area 2' },
    { id: 4, name: 'alpha' },
  ];
  assert.deepEqual(ids({ sortKey: 'name', sortDirection: 'ascending' }, rows), [4, 2, 3, 1]);
  assert.deepEqual(ids({ sortKey: 'name', sortDirection: 'descending' }, rows), [1, 2, 3, 4]);
});

test('version and row counts sort numerically with stable equal values', () => {
  const rows = [{ id: 1, version: '10', rowCount: '1000' }, { id: 2, version: 2, rowCount: 90 }, { id: 3, version: '2', rowCount: '100' }];
  assert.deepEqual(ids({ sortKey: 'version', sortDirection: 'ascending' }, rows), [2, 3, 1]);
  assert.deepEqual(ids({ sortKey: 'version', sortDirection: 'descending' }, rows), [1, 2, 3]);
  assert.deepEqual(ids({ sortKey: 'rowCount', sortDirection: 'ascending' }, rows), [2, 3, 1]);
  assert.deepEqual(ids({ sortKey: 'rowCount', sortDirection: 'descending' }, rows), [1, 3, 2]);
});

test('uploads use timestamps, retain equal instants, and put invalid or missing dates last in either direction', () => {
  const rows = [
    { id: 1, uploadedAt: null },
    { id: 2, uploadedAt: '2026-01-02T00:00:00Z' },
    { id: 3, uploadedAt: '2026-01-01T19:00:00-05:00' },
    { id: 4, uploadedAt: 'invalid' },
    { id: 5, uploadedAt: '2025-12-31T00:00:00Z' },
    { id: 6 },
    { id: 7, uploadedAt: '' },
  ];
  assert.deepEqual(ids({ sortDirection: 'ascending' }, rows), [5, 2, 3, 1, 4, 6, 7]);
  assert.deepEqual(ids({ sortDirection: 'descending' }, rows), [2, 3, 5, 1, 4, 6, 7]);
});

test('vintage, publication, and review sorting follow displayed values and retain ties', () => {
  assert.deepEqual(ids({ sortKey: 'vintage', sortDirection: 'ascending' }), [3, 1, 2, 4]);
  assert.deepEqual(ids({ sortKey: 'publication', sortDirection: 'ascending' }), [1, 3, 2, 4]);
  assert.deepEqual(ids({ sortKey: 'publication', sortDirection: 'descending' }), [2, 4, 1, 3]);
  assert.deepEqual(ids({ sortKey: 'review', sortDirection: 'ascending' }), [2, 3, 1, 4]);
  assert.deepEqual(ids({ sortKey: 'review', sortDirection: 'descending' }), [1, 4, 2, 3]);
});

test('filter choices are unique, dynamic, and show only available statuses', () => {
  assert.deepEqual(datasetFilterChoices(datasets), {
    vintages: ['2023', '2024'], publications: ['published', 'unpublished'], reviews: ['needs-review', 'reviewed'],
  });
  assert.deepEqual(datasetFilterChoices([datasets[0]]), {
    vintages: ['2024'], publications: ['published'], reviews: ['reviewed'],
  });
  assert.deepEqual(datasetFilterChoices([{ vintage: 'Year 10' }, { vintage: 'Year 2' }, { vintage: '' }, {}]), {
    vintages: ['Year 2', 'Year 10'], publications: ['unpublished'], reviews: ['needs-review'],
  });
  assert.deepEqual(datasetFilterChoices([]), { vintages: [], publications: [], reviews: [] });
  assert.deepEqual(filterAndSortDatasets([], defaultDatasetQuery()), []);
});

test('field-review sorting orders approval counts and keeps unreviewed datasets distinct', () => {
  const rows = [
    { id: 1, curationReviewed: true, approvedFields: ['a', 'b', 'c'] },
    { id: 2, curationReviewed: false, approvedFields: [] },
    { id: 3, curationReviewed: true, approvedFields: ['a'] },
    { id: 4, curationReviewed: true, approvedFields: [] },
  ];
  assert.deepEqual(ids({ sortKey: 'review', sortDirection: 'ascending' }, rows), [2, 4, 3, 1]);
  assert.deepEqual(ids({ sortKey: 'review', sortDirection: 'descending' }, rows), [1, 3, 4, 2]);
});
