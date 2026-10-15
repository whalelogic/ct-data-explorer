import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import session from 'express-session';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/middleware/errors.js';
import { datasetsRouter } from '../src/routes/datasets.routes.js';
import { indicatorsRouter } from '../src/routes/indicators.routes.js';
import {
  approvedDefinitions,
  datasetIndicators,
  requireApprovedSelection,
  requirePublishable,
  validateApprovedFields,
} from '../src/services/field-curation.js';
import { presentDataset } from '../src/services/presenters.js';
import { renderRecordReport } from '../src/services/record-reports.js';
import { summaryFacts } from '../src/services/ai/index.js';
import { selectionSchema } from '../src/services/selection.js';
import * as datasets from '../src/repositories/datasets.js';

const sourceFields = [
  { key: 'c0', label: 'Town', role: 'town', type: 'text' },
  { key: 'c1', label: 'Internal category', role: 'dimension', type: 'text' },
  { key: 'c2', label: 'Jobs', role: 'measure', type: 'number', unit: 'count', decimals: 0 },
  { key: 'c3', label: 'Private total', role: 'measure', type: 'number', unit: 'count', decimals: 0 },
];

const sourceRow = {
  id: 1,
  town_id: 1,
  name: 'Andover',
  geo_type: 'town',
  source_row: 2,
  cell_values: {
    c0: 'Andover',
    c1: 'INTERNAL CATEGORY',
    c2: 123,
    c3: 987654,
  },
};

function createCuratedReport(overrides = {}) {
  const dataset = {
    name: 'Jobs',
    vintage: '2026',
    source: 'Example',
    version: 1,
    columns: sourceFields,
    approvedFields: ['c2'],
  };
  const selection = selectionSchema.parse({
    dataset,
    towns: ['Andover'],
    benchmark: false,
    indicators: ['c2'],
    layout: [{ type: 'table' }],
    ...overrides,
  });
  const sourceRows = [sourceRow, { ...sourceRow, id: 2, source_row: 3 }];

  return renderRecordReport(selection, dataset, sourceRows);
}

function setStaffUser(req, _res, next) {
  req.user = { role: 'staff' };
  next();
}

function setAdminUser(req, _res, next) {
  req.user = { role: 'admin' };
  next();
}

test('legacy datasets retain available fields while explicit empty approval exposes no measures', () => {
  assert.deepEqual(approvedDefinitions(sourceFields, null), sourceFields);
  assert.deepEqual(approvedDefinitions(sourceFields, []), []);

  const townOnlyFields = approvedDefinitions(sourceFields, [], { includeTown: true });
  const approvedFields = approvedDefinitions(sourceFields, ['c2']);
  assert.deepEqual(townOnlyFields.map((field) => field.key), ['c0']);
  assert.deepEqual(approvedFields.map((field) => field.key), ['c2']);
});

test('curation rejects unknown, geographic and duplicate fields', () => {
  const invalidSelections = [['c99'], ['c0'], ['c2', 'c2']];
  for (const selection of invalidSelections) {
    assert.throws(() => validateApprovedFields(sourceFields, selection), { status: 400 });
  }

  assert.deepEqual(validateApprovedFields(sourceFields, ['c2']), ['c2']);
  assert.deepEqual(validateApprovedFields(sourceFields, []), []);
});

test('indicators must both exist in the selected dataset and be approved', () => {
  const definitions = [
    { key: 'jobs', derivation: 'direct' },
    { key: 'population', derivation: 'direct' },
    {
      key: 'jobs_rate',
      derivation: 'ratio',
      numerator_key: 'jobs',
      denominator_key: 'population',
    },
  ];
  const availableIndicators = datasetIndicators(definitions, ['jobs']);

  assert.throws(() => {
    requireApprovedSelection({ indicators: ['population'] }, availableIndicators, null);
  }, /not approved/);
  assert.throws(() => {
    requireApprovedSelection({ indicators: ['jobs_rate'] }, availableIndicators, ['jobs_rate']);
  }, /not approved/);
  assert.throws(() => {
    requireApprovedSelection({ indicators: ['jobs'] }, availableIndicators, []);
  }, /not approved/);
  assert.doesNotThrow(() => {
    requireApprovedSelection({ indicators: ['jobs'] }, availableIndicators, ['jobs']);
  });
});

test('unapproved record fields cannot be requested as values or filters', () => {
  assert.throws(() => createCuratedReport({ indicators: ['c3'] }), /not approved/);
  assert.throws(() => {
    createCuratedReport({ recordFilters: { c1: 'INTERNAL CATEGORY' } });
  }, /not approved/);
});

test('record reports and AI facts exclude hidden categories while preserving repeated source rows', () => {
  const report = createCuratedReport();
  const table = report.blocks[0];

  assert.equal(table.records.length, 2);
  assert.deepEqual(table.columns.map((column) => column.key), ['c0', 'c2']);
  assert.deepEqual(table.records.map((record) => record.values), [
    ['Andover', '123'],
    ['Andover', '123'],
  ]);
  assert.deepEqual(report.indicators[0].cells.map((cell) => cell.value), [123, 123]);

  const output = JSON.stringify({
    blocks: report.blocks,
    places: report.places,
    facts: summaryFacts(report),
  });
  assert.ok(!output.includes('INTERNAL CATEGORY'));
  assert.ok(!output.includes('987654'));
  assert.ok(!output.includes('Private total'));
});

test('dataset summaries expose only approved source columns and track review separately', () => {
  const recordDataset = presentDataset({
    data_format: 'records',
    column_definitions: sourceFields,
    approved_fields: ['c2'],
    curation_reviewed_at: new Date(),
  });

  assert.deepEqual(recordDataset.columns.map((field) => field.key), ['c0', 'c2']);
  assert.equal(recordDataset.curationReviewed, true);
  assert.equal(presentDataset({}).curationReviewed, false);

  const indicatorDataset = presentDataset({
    data_format: 'indicators',
    approved_fields: ['jobs'],
    column_definitions: [
      { key: 'c0', role: 'town', label: 'Town' },
      { key: 'c1', role: 'measure', label: 'jobs' },
      { key: 'c2', role: 'measure', label: 'population' },
    ],
  });
  assert.deepEqual(indicatorDataset.columns.map((field) => field.label), ['Town', 'jobs']);
});

test('publishing requires an explicit review and at least one approved field', () => {
  const unpublishableDatasets = [
    {},
    { approved_fields: [] },
    { approved_fields: ['c2'] },
    { approved_fields: [], curation_reviewed_at: new Date() },
  ];

  for (const dataset of unpublishableDatasets) {
    assert.throws(() => requirePublishable(dataset), /before publishing/);
  }

  const reviewedDataset = {
    approved_fields: ['c2'],
    curation_reviewed_at: new Date(),
  };
  assert.doesNotThrow(() => requirePublishable(reviewedDataset));
});

test('new dataset inserts explicitly start with no approved fields', async () => {
  let executedQuery;
  const mockDatabase = {
    async query(sql, parameters) {
      executedQuery = { sql, parameters };
      return { insertId: 10 };
    },
  };
  const dataset = {
    name: 'Jobs',
    sourceId: 1,
    vintage: '2026',
    version: 1,
    rowCount: 2,
    uploadedBy: 1,
  };

  await datasets.insert(dataset, mockDatabase);

  assert.match(executedQuery.sql, /approved_fields/);
  assert.match(executedQuery.sql, /JSON_ARRAY\(\)/);
});

test('curation routes reject anonymous users and staff before accessing dataset data', async () => {
  const anonymousApp = createApp({
    sessionStore: new session.MemoryStore(),
    logRequests: false,
  });
  await request(anonymousApp).get('/api/datasets/1/curation').expect(401);

  const staffApp = express();
  staffApp.use(express.json());
  staffApp.use('/datasets', setStaffUser, datasetsRouter);
  staffApp.use(errorHandler);

  await request(staffApp).get('/datasets/1/curation').expect(403);
  await request(staffApp)
    .put('/datasets/1/curation')
    .send({ approvedFields: ['c2'] })
    .expect(403);
});

test('global indicator definitions are restricted to administrators', async () => {
  const staffApp = express();
  staffApp.use('/indicators', setStaffUser, indicatorsRouter);
  staffApp.use(errorHandler);

  await request(staffApp).get('/indicators').expect(403);
});

test('curation validates administrator requests before accessing dataset data', async () => {
  const adminApp = express();
  adminApp.use(express.json());
  adminApp.use('/datasets', setAdminUser, datasetsRouter);
  adminApp.use(errorHandler);

  const invalidRequests = [{}, { approvedFields: 'c2' }, { approvedFields: [''] }];
  for (const body of invalidRequests) {
    await request(adminApp).put('/datasets/1/curation').send(body).expect(400);
  }
  await request(adminApp).get('/datasets/not-an-id/curation').expect(400);
});
