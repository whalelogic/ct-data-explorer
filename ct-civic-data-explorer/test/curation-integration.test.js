/** Opt in against a migrated local database: CT_CURATION_INTEGRATION=1 npm test. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import session from 'express-session';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const REPORT_PATHS = ['/api/cards/preview', '/api/cards/pdf', '/api/cards/summary'];

async function createTestClients(app, testTag, userIds) {
  const password = crypto.randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 4);
  const clients = {};

  for (const role of ['admin', 'staff']) {
    const email = `${role}-${testTag}@example.invalid`;
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES (?, ?, ?, ?, ?)',
      [email, passwordHash, 'Curation test', role, role],
    );
    userIds.push(result.insertId);

    const agent = request.agent(app);
    const loginResponse = await agent.post('/api/auth/login').send({ email, password }).expect(200);
    clients[role] = { agent, csrfToken: loginResponse.body.csrfToken };
  }

  return clients;
}

function sendWriteRequest(client, method, path, body) {
  return client.agent[method](path)
    .set('X-CSRF-Token', client.csrfToken)
    .send(body);
}

function uploadDataset(client, sourceName, datasetName, csv) {
  return client.agent.post('/api/datasets')
    .set('X-CSRF-Token', client.csrfToken)
    .field('name', datasetName)
    .field('source', sourceName)
    .field('vintage', '2026')
    .field('activate', 'false')
    .attach('file', Buffer.from(csv), 'curation.csv');
}

async function verifyAllTownCharts(client, selection, townNames) {
  const allTownSelection = {
    ...selection,
    towns: townNames,
    layout: [{ type: 'chart' }, { type: 'table' }],
  };
  const response = await sendWriteRequest(client, 'post', '/api/cards/preview', allTownSelection)
    .expect(200);
  const report = response.body;
  const chartBlocks = report.blocks.filter((block) => block.type === 'chart');
  const chartKeys = chartBlocks.flatMap((block) => block.chart.series.map((series) => series.key));

  assert.equal(report.title, '169 Connecticut towns');
  assert.deepEqual(report.places.map((place) => place.name), townNames);
  assert.deepEqual(chartKeys.sort(), [...selection.indicators].sort());
  for (const chartBlock of chartBlocks) {
    assert.equal(chartBlock.chart.type, 'grouped_bar');
    assert.deepEqual(chartBlock.chart.labels, townNames);
    assert.equal(chartBlock.chart.series[0].values.length, 169);
  }
  assert.equal(report.indicators[0].cells[0].value, 456);
  assert.equal(report.indicators[0].cells.at(-1).value, 624);
  assert.equal(report.indicators[1].cells.at(-1).value, 987654);

  const savedResponse = await sendWriteRequest(client, 'post', '/api/cards', {
    title: 'Every town',
    selection: allTownSelection,
  }).expect(201);
  const reloadedResponse = await client.agent.get(`/api/cards/${savedResponse.body.id}`).expect(200);
  assert.deepEqual(reloadedResponse.body.selection.towns, townNames);
  await sendWriteRequest(client, 'post', '/api/cards/preview', reloadedResponse.body.selection).expect(200);

  for (const towns of [[...townNames, townNames[0]], ['Unknown town'], ['Connecticut']]) {
    await sendWriteRequest(client, 'post', '/api/cards/preview', { ...allTownSelection, towns }).expect(400);
  }
}

async function removeTestData(userIds, testTag) {
  if (userIds.length === 0) {
    return;
  }

  // Only rows owned by this test's randomly named users are eligible for cleanup.
  const { rows: ownedDatasets } = await pool.query(
    'SELECT id FROM datasets WHERE uploaded_by IN (?)',
    [userIds],
  );
  const datasetIds = ownedDatasets.map((dataset) => dataset.id);

  await pool.query('DELETE FROM cards WHERE created_by IN (?)', [userIds]);
  if (datasetIds.length > 0) {
    await pool.query('DELETE FROM dataset_records WHERE dataset_id IN (?)', [datasetIds]);
    await pool.query('DELETE FROM observations WHERE dataset_id IN (?)', [datasetIds]);
    await pool.query('DELETE FROM datasets WHERE id IN (?)', [datasetIds]);
  }

  await pool.query('DELETE FROM sources WHERE name = ?', [testTag]);
  await pool.query('DELETE FROM users WHERE id IN (?)', [userIds]);
}

test('HTTP and database curation protects every report path and preserves source rows', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = `curation-test-${crypto.randomUUID()}`;
  const userIds = [];
  const app = createApp({
    sessionStore: new session.MemoryStore(),
    logRequests: false,
  });

  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);
    await staff.agent.get('/api/indicators').expect(403);
    await admin.agent.get('/api/indicators').expect(200);

    // New record datasets remain private until an administrator approves fields.
    const recordCsv = [
      'Town,Category,Jobs,Internal total',
      'Andover,SECRET,123,987654',
      'Andover,SECRET,124,987654',
      '',
    ].join('\n');
    const uploadResponse = await uploadDataset(admin, testTag, testTag, recordCsv).expect(201);
    const recordDatasetId = uploadResponse.body.id;
    const recordDatasetPath = `/api/datasets/${recordDatasetId}`;

    assert.deepEqual(uploadResponse.body.approvedFields, []);
    assert.equal(uploadResponse.body.curationReviewed, false);
    assert.equal(uploadResponse.body.isActive, false);

    const draftPreview = await admin.agent.get(recordDatasetPath).expect(200);
    assert.deepEqual(draftPreview.body.preview.columns.map((field) => field.key), ['c0', 'c1', 'c2', 'c3']);
    assert.equal(draftPreview.body.preview.rows[0].cells[1].value, 'SECRET');
    assert.equal(draftPreview.body.preview.rows[0].cells[3].value, 987654);
    await staff.agent.get(recordDatasetPath).expect(404);

    const draftOptions = await admin.agent.get(`${recordDatasetPath}/report-options`).expect(200);
    assert.deepEqual(draftOptions.body.columns, [], 'Management preview must not approve report fields');
    await sendWriteRequest(admin, 'patch', recordDatasetPath, { isActive: true }).expect(400);
    await staff.agent.get(`${recordDatasetPath}/curation`).expect(403);
    await sendWriteRequest(staff, 'put', `${recordDatasetPath}/curation`, {
      approvedFields: ['c2'],
    }).expect(403);
    await sendWriteRequest(admin, 'put', `${recordDatasetPath}/curation`, {
      approvedFields: ['c99'],
    }).expect(400);

    const reviewResponse = await admin.agent.get(`${recordDatasetPath}/curation`).expect(200);
    assert.deepEqual(reviewResponse.body.fields.map((field) => field.key), ['c1', 'c2', 'c3']);

    const approvalResponse = await sendWriteRequest(admin, 'put', `${recordDatasetPath}/curation`, {
      approvedFields: ['c2'],
    }).expect(200);
    assert.equal(approvalResponse.body.curationReviewed, true);
    await sendWriteRequest(admin, 'patch', recordDatasetPath, { isActive: true }).expect(200);

    // Published views expose the approved measure and preserve both source rows.
    const recordOptions = await staff.agent.get(`${recordDatasetPath}/report-options`).expect(200);
    assert.deepEqual(recordOptions.body.columns.map((field) => field.key), ['c2']);
    assert.deepEqual(recordOptions.body.filters, []);
    assert.deepEqual(recordOptions.body.places.map((place) => place.name), ['Andover']);
    assert.equal(recordOptions.body.repeatedRows, true);

    const recordOverview = await staff.agent.get(recordDatasetPath).expect(200);
    const recordOverviewJson = JSON.stringify(recordOverview.body);
    assert.deepEqual(recordOverview.body.preview.columns.map((field) => field.key), ['c0', 'c2']);
    assert.ok(!recordOverviewJson.includes('SECRET'));
    assert.ok(!recordOverviewJson.includes('987654'));

    const recordSelection = {
      dataset: { name: testTag, vintage: '2026' },
      towns: ['Andover'],
      benchmark: false,
      indicators: ['c2'],
      layout: [{ type: 'table' }],
    };
    const previewResponse = await sendWriteRequest(staff, 'post', '/api/cards/preview', recordSelection)
      .expect(200);
    assert.deepEqual(previewResponse.body.indicators[0].cells.map((cell) => cell.value), [123, 124]);
    assert.equal(previewResponse.body.blocks[0].records.length, 2);
    assert.deepEqual(previewResponse.body.blocks[0].columns.map((field) => field.key), ['c0', 'c2']);
    assert.ok(!JSON.stringify(previewResponse.body).includes('SECRET'));

    // Every report route must reject hidden values and hidden filter fields.
    for (const client of [staff, admin]) {
      const hiddenMeasureSelection = { ...recordSelection, indicators: ['c3'] };
      const hiddenFilterSelection = { ...recordSelection, recordFilters: { c1: 'SECRET' } };

      for (const path of REPORT_PATHS) {
        await sendWriteRequest(client, 'post', path, hiddenMeasureSelection).expect(400);
        await sendWriteRequest(client, 'post', path, hiddenFilterSelection).expect(400);
      }

      await sendWriteRequest(client, 'post', '/api/cards', {
        title: testTag,
        selection: hiddenMeasureSelection,
      }).expect(400);
    }

    const pdfResponse = await sendWriteRequest(staff, 'post', '/api/cards/pdf', recordSelection)
      .expect(200)
      .expect('Content-Type', /pdf/);
    assert.ok(pdfResponse.body.length > 1000);

    const savedCardResponse = await sendWriteRequest(staff, 'post', '/api/cards', {
      title: testTag,
      selection: recordSelection,
    }).expect(201);
    const savedCardPath = `/api/cards/${savedCardResponse.body.id}`;

    // Revoking a field also prevents existing cards from exporting or duplicating it.
    await sendWriteRequest(admin, 'put', `${recordDatasetPath}/curation`, {
      approvedFields: ['c3'],
    }).expect(200);
    await staff.agent.get(`${savedCardPath}/pdf`).expect(400);
    await sendWriteRequest(staff, 'post', `${savedCardPath}/duplicate`, {}).expect(400);
    await sendWriteRequest(staff, 'put', savedCardPath, {
      title: `${testTag} renamed`,
    }).expect(400);

    // Seeded indicator datasets follow the same approval rules as record datasets.
    const { rows: directIndicators } = await pool.query(
      "SELECT `key` FROM indicators WHERE derivation = 'direct' ORDER BY id LIMIT 2",
    );
    assert.equal(directIndicators.length, 2, 'The local database must contain the seeded indicator definitions');
    const approvedIndicatorKey = directIndicators[0].key;
    const hiddenIndicatorKey = directIndicators[1].key;
    const indicatorDatasetName = `${testTag}-indicators`;
    const { rows: townRows } = await pool.query("SELECT name FROM towns WHERE geo_type = 'town' ORDER BY name");
    const townNames = townRows.map((town) => town.name);
    assert.equal(townNames.length, 169, 'The local database must contain all 169 Connecticut towns');
    const indicatorCsvRows = townNames.map((town, index) => `${town},${456 + index},987654`);
    const indicatorCsv = [`Town,${approvedIndicatorKey},${hiddenIndicatorKey}`, ...indicatorCsvRows, ''].join('\n');
    const indicatorUploadResponse = await uploadDataset(admin, testTag, indicatorDatasetName, indicatorCsv)
      .expect(201);
    const indicatorDatasetId = indicatorUploadResponse.body.id;
    const indicatorDatasetPath = `/api/datasets/${indicatorDatasetId}`;

    assert.equal(indicatorUploadResponse.body.dataFormat, 'indicators');

    const indicatorDraft = await admin.agent.get(indicatorDatasetPath).expect(200);
    assert.ok(indicatorDraft.body.indicators.some((indicator) => indicator.key === hiddenIndicatorKey));
    assert.ok(indicatorDraft.body.preview.rows[0].cells.some((cell) => cell.value === 987654));
    await staff.agent.get(indicatorDatasetPath).expect(404);
    await sendWriteRequest(admin, 'put', `${indicatorDatasetPath}/curation`, {
      approvedFields: [approvedIndicatorKey],
    }).expect(200);
    await sendWriteRequest(admin, 'patch', indicatorDatasetPath, { isActive: true }).expect(200);

    const indicatorOptions = await staff.agent.get(`${indicatorDatasetPath}/report-options`).expect(200);
    assert.deepEqual(indicatorOptions.body.columns.map((field) => field.key), [approvedIndicatorKey]);
    assert.deepEqual(indicatorOptions.body.places.map((place) => place.name), townNames);
    assert.equal(indicatorOptions.body.repeatedRows, false);
    assert.equal(indicatorOptions.body.hasState, false);

    const indicatorOverview = await staff.agent.get(indicatorDatasetPath).expect(200);
    assert.deepEqual(indicatorOverview.body.indicators.map((indicator) => indicator.key), [approvedIndicatorKey]);
    assert.ok(!JSON.stringify(indicatorOverview.body).includes('987654'));

    const andoverId = indicatorOptions.body.places[0].id;
    for (const client of [staff, admin]) {
      const townProfile = await client.agent.get(`/api/towns/${andoverId}`).expect(200);
      const townSection = townProfile.body.datasets.find((section) => {
        return section.dataset.id === indicatorDatasetId;
      });
      assert.ok(townSection, 'Town profiles must retain the approved dataset section');
      assert.deepEqual(townSection.indicators.map((field) => field.key), [approvedIndicatorKey]);
      assert.equal(townSection.indicators[0].town.value, 456);
      assert.ok(!JSON.stringify(townSection).includes('987654'), 'Unapproved figures cannot appear in town profiles');
    }

    const indicatorSelection = {
      ...recordSelection,
      dataset: { name: indicatorDatasetName, vintage: '2026' },
      indicators: [approvedIndicatorKey],
    };
    await sendWriteRequest(staff, 'post', '/api/cards/preview', indicatorSelection).expect(200);

    for (const client of [staff, admin]) {
      const hiddenIndicatorSelection = { ...indicatorSelection, indicators: [hiddenIndicatorKey] };
      for (const path of REPORT_PATHS) {
        await sendWriteRequest(client, 'post', path, hiddenIndicatorSelection).expect(400);
      }
    }

    await sendWriteRequest(admin, 'put', `${indicatorDatasetPath}/curation`, {
      approvedFields: [approvedIndicatorKey, hiddenIndicatorKey],
    }).expect(200);
    await verifyAllTownCharts(staff, {
      ...indicatorSelection,
      indicators: [approvedIndicatorKey, hiddenIndicatorKey],
    }, townNames);

    // Removing every approved field unpublishes the record dataset.
    const unpublishResponse = await sendWriteRequest(admin, 'put', `${recordDatasetPath}/curation`, {
      approvedFields: [],
    }).expect(200);
    assert.equal(unpublishResponse.body.dataset.isActive, false);
    await staff.agent.get(recordDatasetPath).expect(404);
    await sendWriteRequest(admin, 'patch', recordDatasetPath, { isActive: true }).expect(400);
  } finally {
    await removeTestData(userIds, testTag);
    await pool.end();
  }
});
