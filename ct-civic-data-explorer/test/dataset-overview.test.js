import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import session from 'express-session';
import { datasetIndicators } from '../src/services/datasets.service.js';
import { datasetsRouter } from '../src/routes/datasets.routes.js';
import { errorHandler } from '../src/middleware/errors.js';
import { createApp } from '../src/app.js';

const definitions = [
  { key: 'pop', derivation: 'direct' },
  { key: 'numerator', derivation: 'direct' },
  { key: 'denominator', derivation: 'direct' },
  { key: 'rate', derivation: 'ratio', numerator_key: 'numerator', denominator_key: 'denominator' },
];

test('overview excludes other datasets columns and ratios with missing components', () => {
  assert.deepEqual(datasetIndicators(definitions, ['numerator']).map((i) => i.key), ['numerator']);
  assert.deepEqual(datasetIndicators(definitions, []), []);
});

test('overview includes computable ratios alongside their stored input columns', () => {
  assert.deepEqual(datasetIndicators(definitions, ['denominator', 'numerator']).map((i) => i.key),
    ['numerator', 'denominator', 'rate']);
});

test('dataset overview cannot be read anonymously', async () => {
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  await request(app).get('/api/datasets/1').expect(401);
});

test('dataset preview rejects unbounded or invalid paging before querying data', async () => {
  const app = express();
  app.use('/datasets', (req, _res, next) => { req.user = { role: 'admin' }; next(); }, datasetsRouter);
  app.use(errorHandler);
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=1.5', 'offset=1000001', 'limit=all']) {
    await request(app).get(`/datasets/1?${query}`).expect(400);
  }
  await request(app).get('/datasets/not-a-number').expect(400);
});
