/** Opt in against a migrated local database: CT_CURATION_INTEGRATION=1 npm test. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, test } from 'node:test';
import bcrypt from 'bcryptjs';
import session from 'express-session';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { canGenerateReports, setAssistantClientForTests } from '../src/services/ai/assistant.js';

const REPORT_PATHS = ['/api/reports/preview', '/api/reports/pdf', '/api/reports/summary'];

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

function uploadDataset(client, sourceName, datasetName, csv, extraFields = {}) {
  const upload = client.agent.post('/api/datasets')
    .set('X-CSRF-Token', client.csrfToken)
    .field('name', datasetName)
    .field('source', sourceName)
    .field('vintage', '2026')
    .field('activate', 'false');
  for (const [name, value] of Object.entries(extraFields)) {
    upload.field(name, value);
  }
  return upload.attach('file', Buffer.from(csv), 'curation.csv');
}

async function verifyAllTownCharts(client, selection, townNames) {
  const allTownSelection = {
    ...selection,
    towns: townNames,
    layout: [{ type: 'chart' }, { type: 'table' }],
  };
  const response = await sendWriteRequest(client, 'post', '/api/reports/preview', allTownSelection)
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

  const savedResponse = await sendWriteRequest(client, 'post', '/api/reports', {
    title: 'Every town',
    selection: allTownSelection,
  }).expect(201);
  const reloadedResponse = await client.agent.get(`/api/reports/${savedResponse.body.id}`).expect(200);
  assert.deepEqual(reloadedResponse.body.selection.rows, townNames);
  await sendWriteRequest(client, 'post', '/api/reports/preview', reloadedResponse.body.selection).expect(200);

  for (const towns of [[...townNames, townNames[0]], ['Unknown town'], ['Connecticut']]) {
    await sendWriteRequest(client, 'post', '/api/reports/preview', { ...allTownSelection, towns }).expect(400);
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

  await pool.query('DELETE FROM reports WHERE created_by IN (?)', [userIds]);
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
    const previewResponse = await sendWriteRequest(staff, 'post', '/api/reports/preview', recordSelection)
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

      await sendWriteRequest(client, 'post', '/api/reports', {
        title: testTag,
        selection: hiddenMeasureSelection,
      }).expect(400);
    }

    const pdfResponse = await sendWriteRequest(staff, 'post', '/api/reports/pdf', recordSelection)
      .expect(200)
      .expect('Content-Type', /pdf/);
    assert.ok(pdfResponse.body.length > 1000);

    const savedReportResponse = await sendWriteRequest(staff, 'post', '/api/reports', {
      title: testTag,
      selection: recordSelection,
    }).expect(201);
    const savedReportPath = `/api/reports/${savedReportResponse.body.id}`;

    // Revoking a field also prevents existing reports from exporting or duplicating it.
    await sendWriteRequest(admin, 'put', `${recordDatasetPath}/curation`, {
      approvedFields: ['c3'],
    }).expect(200);
    await staff.agent.get(`${savedReportPath}/pdf`).expect(400);
    await sendWriteRequest(staff, 'post', `${savedReportPath}/duplicate`, {}).expect(400);
    await sendWriteRequest(staff, 'put', savedReportPath, {
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
    await sendWriteRequest(staff, 'post', '/api/reports/preview', indicatorSelection).expect(200);

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

  }
});

test('staff customize shared presentation and report overrides without bypassing curation', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = `presentation-test-${crypto.randomUUID()}`;
  const userIds = [];
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);
    const uploaded = await uploadDataset(admin, testTag, testTag, 'Town,Jobs,Private count,Category\nAndover,123.45,987654,Services\n').expect(201);
    const path = `/api/datasets/${uploaded.body.id}`;
    await staff.agent.get(`${path}/presentation`).expect(404);
    await sendWriteRequest(admin, 'put', `${path}/presentation`, {
      revision: 0, fields: { c2: { label: 'Hidden label', description: 'Hidden note' } },
    }).expect(200);
    await sendWriteRequest(admin, 'put', `${path}/curation`, { approvedFields: ['c1', 'c3'] }).expect(200);
    await sendWriteRequest(admin, 'patch', path, { isActive: true }).expect(200);
    const initial = await staff.agent.get(`${path}/presentation`).expect(200);
    assert.ok(!JSON.stringify(initial.body).includes('Hidden'));
    assert.deepEqual(initial.body.fields.map((field) => field.key), ['c1', 'c3']);
    const defaults = {
      ...initial.body.settings, displayName: 'Local employment', description: 'An explanation for readers',
      defaultChartType: 'line', fieldOrder: ['c3', 'c1'],
      style: { palette: ['#123456', '#654321', '#225588', '#884422', '#336699', '#993366'], headingColor: '#663399', tableHeaderColor: '#FFF3CD', benchmarkColor: '#666666', textSize: 'large', spacing: 'compact' },
      fields: { c1: { label: 'Employment', decimals: 1, description: 'Jobs reported by employers' } },
    };
    const saved = await sendWriteRequest(staff, 'put', `${path}/presentation`, defaults).expect(200);
    await sendWriteRequest(staff, 'put', `${path}/presentation`, defaults).expect(409);
    for (const fields of [{ c2: { label: 'Forbidden' } }, { c99: { label: 'Unknown' } }, { c3: { decimals: 1 } }, { c1: { decimals: 5 } }, { c1: { unit: 'percent' } }]) {
      await sendWriteRequest(staff, 'put', `${path}/presentation`, { ...saved.body.settings, fields }).expect(400);
    }
    const options = await staff.agent.get(`${path}/report-options`).expect(200);
    assert.deepEqual(options.body.columns.map((field) => field.key), ['c3', 'c1']);
    assert.equal(options.body.columns[1].label, 'Employment');
    assert.equal(options.body.defaultChartType, 'line');
    const adminSettings = await admin.agent.get(`${path}/presentation`).expect(200);
    assert.equal(adminSettings.body.settings.fields.c2.label, 'Hidden label');
    const selection = { dataset: { name: testTag, vintage: '2026' }, towns: ['Andover'], benchmark: false, indicators: ['c1'] };
    const preview = await sendWriteRequest(staff, 'post', '/api/reports/preview', selection).expect(200);
    assert.equal(preview.body.indicators[0].label, 'Employment');
    assert.equal(preview.body.style.headingColor, '#663399');
    assert.equal(preview.body.style.palette[0], '#123456');
    assert.equal(preview.body.style.textSize, 'large');
    assert.equal(preview.body.indicators[0].cells[0].value, 123.45);
    assert.equal(preview.body.indicators[0].cells[0].display, '123.5');
    assert.match(preview.body.sourceLine, new RegExp(testTag));
    assert.ok(!JSON.stringify(preview.body).includes('Hidden'));
    const overridden = {
      ...selection, styleOverrides: { headingColor: '#17395C', spacing: 'comfortable' }, fieldOverrides: { c1: { label: 'Local jobs', decimals: 0, description: 'Report-specific note' } },
      layout: [{ type: 'chart', title: 'Our economy' }, { type: 'table' }],
    };
    const custom = await sendWriteRequest(staff, 'post', '/api/reports/preview', overridden).expect(200);
    assert.equal(custom.body.indicators[0].label, 'Local jobs');
    assert.equal(custom.body.style.headingColor, '#17395C');
    assert.equal(custom.body.style.spacing, 'comfortable');
    assert.equal(custom.body.style.textSize, 'large');
    assert.equal(custom.body.style.palette[0], '#123456');
    assert.equal(custom.body.indicators[0].cells[0].display, '123');
    assert.equal(custom.body.blocks[0].chart.title, 'Our economy');
    assert.ok(JSON.stringify(custom.body.blocks).includes('Report-specific note'));
    const stored = await sendWriteRequest(staff, 'post', '/api/reports', { title: testTag, selection: overridden }).expect(201);
    const restored = await staff.agent.get(`/api/reports/${stored.body.id}`).expect(200);
    assert.deepEqual(restored.body.selection.fieldOverrides, overridden.fieldOverrides);
    assert.deepEqual(restored.body.selection.styleOverrides, overridden.styleOverrides);
    await staff.agent.get(`/api/reports/${stored.body.id}/pdf`).expect(200).expect('Content-Type', /pdf/);
    await sendWriteRequest(staff, 'put', `${path}/presentation`, { ...saved.body.settings, style: { headingColor: '#FFFFFF' } }).expect(400);
    await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...overridden, styleOverrides: { tableHeaderColor: '#000000' } }).expect(400);
    const inheritedAgain = await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...overridden, styleOverrides: {} }).expect(200);
    assert.equal(inheritedAgain.body.style.headingColor, '#663399');
    const searched = await staff.agent.get('/api/reports?q=Local%20employment').expect(200);
    assert.ok(searched.body.some((report) => report.id === stored.body.id));
    await sendWriteRequest(staff, 'put', `${path}/presentation`, { ...saved.body.settings, fields: {} }).expect(200);
    const reset = await sendWriteRequest(staff, 'post', '/api/reports/preview', selection).expect(200);
    assert.equal(reset.body.indicators[0].label, 'Jobs');
    const stillCustom = await sendWriteRequest(staff, 'post', '/api/reports/preview', overridden).expect(200);
    assert.equal(stillCustom.body.indicators[0].label, 'Local jobs');
    await sendWriteRequest(admin, 'put', `${path}/curation`, { approvedFields: ['c3'] }).expect(200);
    await sendWriteRequest(staff, 'post', '/api/reports/preview', overridden).expect(400);

    const indicatorsUpload = await uploadDataset(admin, testTag, `${testTag}-numeric`, 'Town,pop,households\nAndover,1234,500\n').expect(201);
    const numericPath = `/api/datasets/${indicatorsUpload.body.id}`;
    assert.equal(indicatorsUpload.body.dataFormat, 'indicators');
    await sendWriteRequest(admin, 'put', `${numericPath}/curation`, { approvedFields: ['pop'] }).expect(200);
    await sendWriteRequest(admin, 'patch', numericPath, { isActive: true }).expect(200);
    await sendWriteRequest(staff, 'put', `${numericPath}/presentation`, { revision: 0, fields: { pop: { label: 'Residents', decimals: 2 } } }).expect(200);
    const numericSelection = { dataset: { name: `${testTag}-numeric`, vintage: '2026' }, towns: ['Andover'], benchmark: false, indicators: ['pop'] };
    const numericPreview = await sendWriteRequest(staff, 'post', '/api/reports/preview', numericSelection).expect(200);
    const averaged = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...numericSelection,
      indicators: ['pop', 'ratio_1'],
      customIndicators: [{ key: 'ratio_1', label: 'Average residents per town', numerator: 'pop', calculation: 'average', decimals: 0 }],
      layout: [{ type: 'chart', indicators: ['pop', 'ratio_1'] }, { type: 'table' }],
    }).expect(200);
    assert.deepEqual(averaged.body.summaries.map((summary) => [summary.label, summary.value, summary.explanation]), [
      ['Average residents per town', 1234, '1,234 total Residents ÷ 1 town'],
    ]);
    assert.ok(averaged.body.indicators.every((row) => row.key !== 'ratio_1'));
    assert.equal(numericPreview.body.indicators[0].label, 'Residents');
    const styledNumeric = await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...numericSelection, styleOverrides: { headingColor: '#663399', spacing: 'compact' } }).expect(200);
    assert.equal(styledNumeric.body.style.headingColor, '#663399');
    assert.equal(styledNumeric.body.style.spacing, 'compact');
    assert.equal(numericPreview.body.indicators[0].cells[0].value, 1234);
    assert.equal(numericPreview.body.indicators[0].cells[0].display, '1,234.00');
    const numericOverride = await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...numericSelection, fieldOverrides: { pop: { label: 'People', decimals: 0 } } }).expect(200);
    assert.equal(numericOverride.body.indicators[0].label, 'People');
    assert.equal(numericOverride.body.indicators[0].cells[0].display, '1,234');
  } finally {
    await removeTestData(userIds, testTag);
  }
});

test('datasets without a town column upload, publish, report and export by their label column', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = `row-label-test-${crypto.randomUUID()}`;
  const userIds = [];
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  const csv = 'Program,Region,Clients,Staff\nFood pantry,North,1200,8\nHousing help,South,300,0\nFood pantry,South,900,6\n,North,40,2\n';
  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);

    // Inspection suggests a label column; without one the upload is rejected and nothing is saved.
    const inspection = await admin.agent.post('/api/datasets/inspect')
      .set('X-CSRF-Token', admin.csrfToken)
      .attach('file', Buffer.from(csv), 'programs.csv')
      .expect(200);
    assert.deepEqual(inspection.body.suggested, { label: 'Program', isTown: false });
    await uploadDataset(admin, testTag, testTag, csv).expect(422);
    await uploadDataset(admin, testTag, testTag, csv, { labelColumn: 'Program', labelIsTown: 'true' }).expect(422);

    const uploaded = await uploadDataset(admin, testTag, testTag, csv, { labelColumn: 'Program', labelIsTown: 'false' }).expect(201);
    assert.equal(uploaded.body.dataFormat, 'records');
    const path = `/api/datasets/${uploaded.body.id}`;
    const { rows: [stored] } = await pool.query('SELECT row_label_key FROM datasets WHERE id = ?', [uploaded.body.id]);
    assert.equal(stored.row_label_key, 'c0');
    const { rows: storedRows } = await pool.query(
      'SELECT town_id, source_row FROM dataset_records WHERE dataset_id = ? ORDER BY source_row', [uploaded.body.id],
    );
    assert.deepEqual(storedRows.map((row) => row.town_id), [null, null, null, null]);

    // The label column is the row's identity, not a field to approve.
    await sendWriteRequest(admin, 'put', `${path}/curation`, { approvedFields: ['c0'] }).expect(400);
    await sendWriteRequest(admin, 'put', `${path}/curation`, { approvedFields: ['c1', 'c2', 'c3'] }).expect(200);
    await sendWriteRequest(admin, 'patch', path, { isActive: true }).expect(200);

    const options = await staff.agent.get(`${path}/report-options`).expect(200);
    assert.equal(options.body.rowKind, 'label');
    assert.equal(options.body.rowNoun, 'Program');
    assert.equal(options.body.hasState, false);
    assert.deepEqual(options.body.places.map((place) => place.name), ['Food pantry', 'Housing help', 'Row 5']);
    assert.equal(options.body.defaultCompare, 'c0');
    assert.deepEqual(options.body.compareOptions.map((option) => [option.id, option.label, option.values]), [
      ['c0', 'Program', ['Food pantry', 'Housing help', 'Row 5']],
      ['c1', 'Region', ['North', 'South']],
    ]);

    // Repeated labels stay separate rows; nothing is summed.
    const selection = { dataset: { name: testTag, vintage: '2026' }, rows: ['Food pantry'], benchmark: false, indicators: ['c2'] };
    const preview = await sendWriteRequest(staff, 'post', '/api/reports/preview', selection).expect(200);
    assert.deepEqual(preview.body.indicators[0].cells.map((cell) => cell.value), [1200, 900]);
    const everyRow = await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, rows: [], allRows: true }).expect(200);
    assert.equal(everyRow.body.indicators[0].cells.length, 4);
    await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, rows: ['Andover'] }).expect(400);

    // A report can compare by another approved text column without changing the dataset default.
    const byRegionReport = await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, compareBy: 'c1', rows: ['North'] }).expect(200);
    assert.equal(byRegionReport.body.rowNoun, 'Region');
    assert.deepEqual(byRegionReport.body.indicators[0].cells.map((cell) => cell.value), [1200, 40]);
    await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, compareBy: 'c2', rows: ['1200'] }).expect(400);

    const saved = await sendWriteRequest(staff, 'post', '/api/reports', { title: testTag, selection }).expect(201);
    const reloaded = await staff.agent.get(`/api/reports/${saved.body.id}`).expect(200);
    assert.deepEqual(reloaded.body.selection.rows, ['Food pantry']);
    await staff.agent.get(`/api/reports/${saved.body.id}/pdf`).expect(200).expect('Content-Type', /pdf/);

    // Staff may relabel rows by another approved text field, never by a number or an unknown column.
    await sendWriteRequest(staff, 'put', `${path}/row-label`, { rowLabelKey: 'c2' }).expect(400);
    await sendWriteRequest(staff, 'put', `${path}/row-label`, { rowLabelKey: 'c9' }).expect(400);
    const relabeled = await sendWriteRequest(staff, 'put', `${path}/row-label`, { rowLabelKey: 'c1' }).expect(200);
    assert.equal(relabeled.body.rowLabelKey, 'c1');
    assert.equal(relabeled.body.townKeyed, false);
    const regionOptions = await staff.agent.get(`${path}/report-options`).expect(200);
    assert.equal(regionOptions.body.rowNoun, 'Region');
    assert.deepEqual(regionOptions.body.places.map((place) => place.name), ['North', 'South']);
    // The saved report named Program values, which no longer label rows.
    await staff.agent.get(`/api/reports/${saved.body.id}/pdf`).expect(400);
    const byRegion = await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, rows: ['South'] }).expect(200);
    assert.deepEqual(byRegion.body.indicators[0].cells.map((cell) => cell.value), [300, 900]);
  } finally {
    await removeTestData(userIds, testTag);
  }
});

test('town files with county and planning region rows upload and report those rows separately', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = `county-test-${crypto.randomUUID()}`;
  const userIds = [];
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  // Repeated towns make this a source-row dataset; the county rows were rejected before 011.
  const csv = 'Town,Sector,Jobs\nAndover,Retail,5\nAndover,Services,7\nFairfield County,Retail,900\n'
    + 'Hartford County,Retail,800\nCapitol Planning Region,Retail,700\nConnecticut,Retail,5000\n';
  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);
    const uploaded = await uploadDataset(admin, testTag, testTag, csv).expect(201);
    assert.equal(uploaded.body.dataFormat, 'records');
    assert.ok(uploaded.body.importNotes.some((note) => note.includes('3 county or planning region labels')));
    const path = `/api/datasets/${uploaded.body.id}`;
    await sendWriteRequest(admin, 'put', `${path}/curation`, { approvedFields: ['c1', 'c2'] }).expect(200);
    await sendWriteRequest(admin, 'patch', path, { isActive: true }).expect(200);

    const options = await staff.agent.get(`${path}/report-options`).expect(200);
    assert.equal(options.body.rowKind, 'town');
    assert.equal(options.body.hasState, true);
    const geoTypes = Object.fromEntries(options.body.places.map((place) => [place.name, place.geoType]));
    assert.equal(geoTypes['Fairfield County'], 'county');
    assert.equal(geoTypes['Capitol Planning Region'], 'region');
    assert.deepEqual(options.body.compareOptions.map((option) => [option.id, option.values.length]), [['town', 1], ['county', 2], ['region', 1], ['c1', 2]]);
    const counties = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      dataset: { name: testTag, vintage: '2026' }, compareBy: 'county', rows: ['Fairfield County', 'Hartford County'], benchmark: false, indicators: ['c2'],
    }).expect(200);
    assert.equal(counties.body.title, 'Fairfield County and Hartford County');

    const selection = {
      dataset: { name: testTag, vintage: '2026' }, rows: ['Andover', 'Fairfield County'], benchmark: true, indicators: ['c2'],
    };
    const preview = await sendWriteRequest(staff, 'post', '/api/reports/preview', selection).expect(200);
    assert.deepEqual(preview.body.indicators[0].cells.map((cell) => cell.value), [5, 7, 900, 5000]);
    assert.equal(preview.body.title, 'Andover and Fairfield County');
    const everyRow = await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, rows: [], allRows: true, benchmark: false }).expect(200);
    assert.equal(everyRow.body.indicators[0].cells.length, 5);
    assert.equal(everyRow.body.title, 'All Connecticut places');
    const saved = await sendWriteRequest(staff, 'post', '/api/reports', { title: testTag, selection }).expect(201);
    await staff.agent.get(`/api/reports/${saved.body.id}/pdf`).expect(200).expect('Content-Type', /pdf/);

    await uploadDataset(admin, testTag, `${testTag}-bad`, 'Town,Jobs\nGotham County,1\n').expect(422);
  } finally {
    await removeTestData(userIds, testTag);
  }
});

/** A stand-in for the Claude client that plays back tool calls and records what it was sent. */
function scriptedClaude(steps) {
  const requests = [];
  let id = 0;
  return {
    requests,
    beta: {
      messages: {
        async create(params) {
          requests.push(structuredClone(params));
          const step = steps.shift();
          if (!step) throw new Error('scripted Claude ran out of steps');
          if (step.text) {
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: step.text }] };
          }
          return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tool_${++id}`, name: step.tool, input: step.input }] };
        },
      },
    },
  };
}

function lastToolResult(claude) {
  return claude.requests.at(-1).messages.at(-1).content[0];
}

test('the data assistant reads published figures, keeps record values private and proposes reports', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = `assistant-test-${crypto.randomUUID()}`;
  const userIds = [];
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);
    const numeric = await uploadDataset(admin, testTag, `${testTag}-towns`, 'Town,pop,households\nAndover,1234,500\nBridgewater,2000,800\n').expect(201);
    await sendWriteRequest(admin, 'put', `/api/datasets/${numeric.body.id}/curation`, { approvedFields: ['pop', 'households'] }).expect(200);
    await sendWriteRequest(admin, 'patch', `/api/datasets/${numeric.body.id}`, { isActive: true }).expect(200);
    const records = await uploadDataset(admin, testTag, `${testTag}-programs`, 'Program,Clients\nFood pantry,1200\nHousing help,300\n', { labelColumn: 'Program', labelIsTown: 'false' }).expect(201);
    await sendWriteRequest(admin, 'put', `/api/datasets/${records.body.id}/curation`, { approvedFields: ['c1'] }).expect(200);
    await sendWriteRequest(admin, 'patch', `/api/datasets/${records.body.id}`, { isActive: true }).expect(200);

    const figures = scriptedClaude([
      { tool: 'get_figures', input: { dataset_id: numeric.body.id, compare_by: 'town', places: ['Andover', 'Bridgewater'], fields: ['pop'], include_statewide: false, summaries: [{ field: 'pop', calculation: 'average' }] } },
      { tool: 'get_figures', input: { dataset_id: records.body.id, compare_by: 'town', places: [], fields: ['c1'], include_statewide: false, summaries: [] } },
      { text: 'The average is **1,617.00** people per town.' },
    ]);
    setAssistantClientForTests(figures);
    const session = await staff.agent.get('/api/auth/me').expect(200);
    assert.deepEqual(session.body.features, { aiSummary: session.body.features.aiSummary, assistant: true, assistantReports: true });
    const answer = await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'What is the average population?' }],
      context: { page: 'dataset', datasetId: numeric.body.id },
    }).expect(200);
    assert.equal(answer.body.reply, 'The average is **1,617.00** people per town.');
    assert.equal(answer.body.proposal, null);
    // The app context rides along with the question, and the figures come from the report engine.
    assert.match(figures.requests[0].messages[0].content[0].text, new RegExp(`Open dataset: id ${numeric.body.id}`));
    const first = JSON.parse(figures.requests[1].messages.at(-1).content[0].content);
    assert.deepEqual(first.values, { Population: { Andover: '1,234', Bridgewater: '2,000' } });
    assert.equal(first.summaries[0].value, '1,617.00');
    const privateResult = lastToolResult(figures);
    assert.equal(privateResult.is_error, true);
    assert.match(privateResult.content, /private/);
    assert.ok(!JSON.stringify(figures.requests).includes('Food pantry'), 'record values never reach the model');

    const proposing = scriptedClaude([
      { tool: 'propose_report', input: { dataset_id: numeric.body.id, compare_by: 'town', rows: ['Andover'], fields: ['pop', 'households'], summaries: [{ field: 'pop', calculation: 'median', name: 'Median population' }], include_statewide: false, title: '' } },
      { text: 'I set up a report on Andover.' },
    ]);
    setAssistantClientForTests(proposing);
    const proposal = await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'Build a report on Andover' }],
    }).expect(200);
    assert.equal(proposal.body.proposal.datasetId, numeric.body.id);
    assert.deepEqual(proposal.body.proposal.selection.rows, ['Andover']);
    assert.deepEqual(proposal.body.proposal.selection.indicators, ['pop', 'households', 'ratio_1']);
    assert.equal(proposal.body.proposal.selection.customIndicators[0].calculation, 'median');
    await sendWriteRequest(staff, 'post', '/api/reports/preview', proposal.body.proposal.selection).expect(200);

    await sendWriteRequest(staff, 'post', '/api/assistant', { messages: [{ role: 'assistant', content: 'Hi' }] }).expect(400);
    await staff.agent.post('/api/assistant').send({ messages: [{ role: 'user', content: 'Hi' }] }).expect(403);
    assert.equal(canGenerateReports({ role: 'viewer' }), false);
  } finally {
    setAssistantClientForTests(undefined);
    await removeTestData(userIds, testTag);
  }
});

after(() => pool.end());
