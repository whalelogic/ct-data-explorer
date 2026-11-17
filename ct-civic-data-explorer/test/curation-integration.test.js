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

async function createGuestClient(app, { expectAssistant = false } = {}) {
  const agent = request.agent(app);
  const response = await agent.get('/api/auth/session').expect(200);
  assert.equal(response.body.user, null);
  if (expectAssistant) {
    assert.equal(response.body.features.assistant, true);
    assert.equal(response.body.features.assistantReports, true);
  }
  return { agent, csrfToken: response.body.csrfToken };
}

function sendWriteRequest(client, method, path, body) {
  return client.agent[method](path)
    .set('X-CSRF-Token', client.csrfToken)
    .send(body);
}

function uploadDataset(client, sourceName, datasetName, csv, extraFields = {}, path = '/api/datasets') {
  const upload = client.agent.post(path)
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
    const guest = await createGuestClient(app);
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
    await sendWriteRequest(guest, 'post', '/api/reports/comparison-options', { datasetIds: [recordDatasetId] }).expect(404);

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

    const guestPreview = await sendWriteRequest(guest, 'post', '/api/reports/preview', recordSelection).expect(200);
    assert.deepEqual(guestPreview.body.indicators[0].cells.map((cell) => cell.value), [123, 124]);
    assert.deepEqual(guestPreview.body.dataset.columns.map((column) => column.key), ['c0', 'c2']);
    assert.equal(guestPreview.body.dataset.uploadedBy, undefined);
    assert.equal(guestPreview.body.dataset.importNotes, undefined);
    assert.doesNotMatch(JSON.stringify(guestPreview.body), /SECRET|987654|Internal total/);
    await sendWriteRequest(guest, 'post', '/api/reports/preview', { ...recordSelection, compareBy: 'c1' }).expect(400);

    // Every report route must reject hidden values and hidden filter fields.
    for (const client of [staff, admin, guest]) {
      const hiddenMeasureSelection = { ...recordSelection, indicators: ['c3'] };
      const hiddenFilterSelection = { ...recordSelection, recordFilters: { c1: 'SECRET' } };

      for (const path of REPORT_PATHS) {
        await sendWriteRequest(client, 'post', path, hiddenMeasureSelection).expect(400);
        await sendWriteRequest(client, 'post', path, hiddenFilterSelection).expect(400);
      }

      await sendWriteRequest(client, 'post', '/api/reports', {
        title: testTag,
        selection: hiddenMeasureSelection,
      }).expect(client === guest ? 401 : 400);
    }

    for (const client of [staff, guest]) {
      const pdfResponse = await sendWriteRequest(client, 'post', '/api/reports/pdf', recordSelection)
        .expect(200)
        .expect('Content-Type', /pdf/);
      assert.ok(pdfResponse.body.length > 1000);
    }

    const savedReportResponse = await sendWriteRequest(staff, 'post', '/api/reports', {
      title: testTag,
      selection: recordSelection,
    }).expect(201);
    const savedReportPath = `/api/reports/${savedReportResponse.body.id}`;
    await guest.agent.get('/api/reports').expect(401);
    await guest.agent.get(savedReportPath).expect(401);
    await guest.agent.get(`/api/reports/by-slug/${savedReportResponse.body.slug}`).expect(401);
    await guest.agent.get(`${savedReportPath}/pdf`).expect(401);

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
    assert.deepEqual(initial.body.fields.map((field) => field.key), ['c0', 'c1', 'c3']);
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
  const csv = 'Program,Region,Clients,Staff,Cycle\nFood pantry,North,1200,8,Spring\nHousing help,South,300,0,Spring\n'
    + 'Food pantry,South,900,6,Spring\n,North,40,2,Spring\n';
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
    await sendWriteRequest(admin, 'put', `${path}/curation`, { approvedFields: ['c1', 'c2', 'c3', 'c4'] }).expect(200);
    await sendWriteRequest(admin, 'patch', path, { isActive: true }).expect(200);

    const options = await staff.agent.get(`${path}/report-options`).expect(200);
    assert.equal(options.body.rowKind, 'label');
    assert.equal(options.body.rowNoun, 'Program');
    assert.equal(options.body.hasState, false);
    assert.deepEqual(options.body.places.map((place) => place.name), ['Food pantry', 'Housing help', 'Row 5']);
    assert.equal(options.body.defaultCompare, 'c0');
    const comparisons = new Map(options.body.compareOptions.map(({ id, label, values }) => [id, { label, values }]));
    assert.deepEqual(comparisons.get('c0'), { label: 'Program', values: ['Food pantry', 'Housing help', 'Row 5'] });
    assert.deepEqual(comparisons.get('c1'), { label: 'Region', values: ['North', 'South'] });
    assert.equal(comparisons.has('c4'), false);
    const requested = await staff.agent.get(`${path}/report-options?compareBy=c4`).expect(200);
    assert.deepEqual(requested.body.compareOptions.find((option) => option.id === 'c4').values, ['Spring']);

    // Repeated labels stay separate rows; nothing is summed.
    const selection = { dataset: { name: testTag, vintage: '2026' }, rows: ['Food pantry'], benchmark: false, indicators: ['c2'] };
    const preview = await sendWriteRequest(staff, 'post', '/api/reports/preview', selection).expect(200);
    assert.deepEqual(preview.body.indicators[0].cells.map((cell) => cell.value), [1200, 900]);
    const everyRow = await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, rows: [], allRows: true }).expect(200);
    assert.equal(everyRow.body.indicators[0].cells.length, 4);
    await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, rows: ['Andover'] }).expect(400);

    // A report can compare by another approved field without changing the dataset default.
    const byRegionReport = await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, compareBy: 'c1', rows: ['North'] }).expect(200);
    assert.equal(byRegionReport.body.rowNoun, 'Region');
    assert.deepEqual(byRegionReport.body.indicators[0].cells.map((cell) => cell.value), [1200, 40]);
    const byNumber = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection, compareBy: 'c2', rows: ['1200'], indicators: ['c3'],
    }).expect(200);
    assert.equal(byNumber.body.rowNoun, 'Clients');
    assert.deepEqual(byNumber.body.indicators[0].cells.map((cell) => cell.value), [8]);

    const saved = await sendWriteRequest(staff, 'post', '/api/reports', { title: testTag, selection }).expect(201);
    const reloaded = await staff.agent.get(`/api/reports/${saved.body.id}`).expect(200);
    assert.deepEqual(reloaded.body.selection.rows, ['Food pantry']);
    assert.equal(reloaded.body.selection.compareBy, 'c0');
    await staff.agent.get(`/api/reports/${saved.body.id}/pdf`).expect(200).expect('Content-Type', /pdf/);
    const legacy = await sendWriteRequest(staff, 'post', '/api/reports', { title: `${testTag} legacy`, selection }).expect(201);
    await pool.query("UPDATE reports SET selection = JSON_REMOVE(selection, '$.compareBy') WHERE id = ?", [legacy.body.id]);
    const legacySelection = await staff.agent.get(`/api/reports/${legacy.body.id}`).expect(200);
    assert.equal(legacySelection.body.selection.compareBy, 'c0');

    // Staff may use a numeric primary field and give identifier columns visible aliases.
    await sendWriteRequest(staff, 'put', `${path}/row-label`, { rowLabelKey: 'c9' }).expect(400);
    await sendWriteRequest(staff, 'put', `${path}/row-label`, { rowLabelKey: 'c2' }).expect(200);
    await sendWriteRequest(staff, 'put', `${path}/presentation`, {
      revision: 0, fields: { c0: { label: 'Service' }, c1: { label: 'Service area' }, c2: { label: 'Client count' } },
    }).expect(200);
    const numericOptions = await staff.agent.get(`${path}/report-options`).expect(200);
    assert.equal(numericOptions.body.defaultCompare, 'c2');
    assert.equal(numericOptions.body.rowNoun, 'Client count');
    const relabeled = await sendWriteRequest(staff, 'put', `${path}/row-label`, { rowLabelKey: 'c1' }).expect(200);
    assert.equal(relabeled.body.rowLabelKey, 'c1');
    assert.equal(relabeled.body.townKeyed, false);
    const regionOptions = await staff.agent.get(`${path}/report-options`).expect(200);
    assert.equal(regionOptions.body.rowNoun, 'Service area');
    assert.deepEqual(regionOptions.body.places.map((place) => place.name), ['North', 'South']);
    for (const report of [saved.body, legacy.body]) {
      const view = await staff.agent.get(`/api/reports/by-slug/${report.slug}`).expect(200);
      assert.equal(view.body.data.rowNoun, 'Service');
      assert.deepEqual(view.body.data.indicators[0].cells.map((cell) => cell.value), [1200, 900]);
      await staff.agent.get(`/api/reports/${report.id}/pdf`).expect(200).expect('Content-Type', /pdf/);
    }
    const byRegion = await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, rows: ['South'] }).expect(200);
    assert.deepEqual(byRegion.body.indicators[0].cells.map((cell) => cell.value), [300, 900]);
    await sendWriteRequest(admin, 'put', `${path}/curation`, { approvedFields: ['c2', 'c3'] }).expect(200);
    const curatedOptions = await staff.agent.get(`${path}/report-options?compareBy=c1`).expect(200);
    assert.equal(curatedOptions.body.defaultCompare, 'c0');
    assert.ok(curatedOptions.body.compareOptions.every((option) => option.id !== 'c1'));
    await sendWriteRequest(staff, 'put', `${path}/row-label`, { rowLabelKey: 'c1' }).expect(400);
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
    assert.deepEqual(options.body.compareOptions.filter((option) => option.kind === 'place')
      .map((option) => [option.id, option.values.length]), [['town', 1], ['county', 2], ['region', 1]]);
    const counties = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      dataset: { name: testTag, vintage: '2026' }, compareBy: 'county', rows: ['Fairfield County', 'Hartford County'], benchmark: false, indicators: ['c2'],
    }).expect(200);
    assert.equal(counties.body.title, 'Fairfield County and Hartford County');
    const allCounties = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      dataset: { name: testTag, vintage: '2026' }, compareBy: 'county', allRows: true, benchmark: false, indicators: ['c2'],
    }).expect(200);
    assert.deepEqual(allCounties.body.places.map((place) => place.name), ['Fairfield County', 'Hartford County']);

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

test('geographic comparisons align source formats and protect private secondary sources', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = `comparison-test-${crypto.randomUUID()}`;
  const userIds = [];
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);
    const original = await uploadDataset(admin, testTag, `${testTag}-public`,
      'Town,pop\nAndover,100\nBolton,200\nHartford,300\nTolland County,900\n').expect(201);
    const base = original.body;
    await sendWriteRequest(admin, 'put', `/api/datasets/${base.id}/curation`, { approvedFields: ['pop'] }).expect(200);
    await sendWriteRequest(admin, 'patch', `/api/datasets/${base.id}`, { isActive: true }).expect(200);

    const second = await staff.agent.post('/api/datasets/private')
      .set('X-CSRF-Token', staff.csrfToken)
      .field('name', `${testTag}-private`)
      .field('source', testTag)
      .field('vintage', '2026')
      .attach('file', Buffer.from('Town,Jobs\nAndover,10\nBolton,20\nHartford,30\n'), 'jobs.csv')
      .expect(201);
    const related = second.body;
    const optionsInput = { datasetIds: [base.id, related.id] };
    const options = await sendWriteRequest(staff, 'post', '/api/reports/comparison-options', optionsInput).expect(200);
    assert.deepEqual(options.body.groupBy.map(({ id }) => id), ['town', 'county', 'region', 'state', 'fields']);
    assert.deepEqual(options.body.groupBy.find(({ id }) => id === 'fields').values, ['Andover', 'Bolton', 'Hartford']);
    assert.deepEqual(options.body.groupBy.find(({ id }) => id === 'county').values, ['Hartford County', 'Tolland County']);
    await sendWriteRequest(admin, 'post', '/api/reports/comparison-options', optionsInput).expect(404);

    const sources = [
      { datasetId: base.id, indicator: 'pop', aggregation: 'sum' },
      { datasetId: related.id, indicator: 'c1', aggregation: 'sum' },
    ];
    const selection = {
      dataset: { id: base.id, name: base.name, vintage: base.vintage },
      benchmark: false,
      rows: ['Tolland County'],
      indicators: sources.map(({ datasetId, indicator }) => `d${datasetId}:${indicator}`),
      comparison: { groupBy: 'county', sources },
    };
    const preview = await sendWriteRequest(staff, 'post', '/api/reports/preview', selection).expect(200);
    assert.deepEqual(preview.body.indicators.map(({ role, cells }) => [role, cells[0].value, cells[0].rollupFrom]), [
      ['primary', 900, undefined], ['secondary', 30, 'town'],
    ]);
    const byRegion = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection, rows: ['Capitol Planning Region'], comparison: { ...selection.comparison, groupBy: 'region' },
    }).expect(200);
    assert.deepEqual(byRegion.body.indicators.map(({ cells }) => cells[0].value), [600, 60]);
    const byState = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection, rows: ['Connecticut'], comparison: { ...selection.comparison, groupBy: 'state' },
    }).expect(200);
    assert.deepEqual(byState.body.indicators.map(({ cells }) => cells[0].value), [600, 60]);
    const byTown = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection, rows: [], allRows: true, comparison: { ...selection.comparison, groupBy: 'town' },
    }).expect(200);
    assert.equal(byTown.body.comparison.relationships[0].pairedRows, 3);
    assert.ok(byTown.body.comparison.relationships[0].correlation > 0.99);
    await sendWriteRequest(admin, 'post', '/api/reports/preview', selection).expect(404);

    const saved = await sendWriteRequest(staff, 'post', '/api/reports', { title: testTag, selection }).expect(201);
    assert.equal(saved.body.isPrivate, true);
    assert.ok(!saved.body.slug.includes(testTag));
    await staff.agent.get(`/api/reports/${saved.body.id}/pdf`).expect(200).expect('Content-Type', /pdf/);
    await admin.agent.get(`/api/reports/${saved.body.id}`).expect(404);
    await admin.agent.get(`/api/reports/by-slug/${saved.body.slug}`).expect(404);
    assert.deepEqual((await admin.agent.get(`/api/reports?q=${testTag}`).expect(200)).body, []);
    await sendWriteRequest(admin, 'post', `/api/reports/${saved.body.id}/duplicate`, {}).expect(404);
  } finally {
    await removeTestData(userIds, testTag);
  }
});

test('non-geographic comparisons align shared labels and indicators across different columns', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = `label-comparison-test-${crypto.randomUUID()}`;
  const userIds = [];
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);
    const fixtures = [
      ['first', 'Program,Clients\nFood aid,100\nHousing,80\nFirst only,25\n,99\n', 'c1'],
      ['second', 'Program,Staff,Clients\nfood  aid,5,25\nFood aid,2,40\nHousing,4,90\nSecond only,1,50\n,3,99\n', 'c2'],
    ];
    const datasets = [];
    for (const [name, csv, indicator] of fixtures) {
      const result = await uploadDataset(admin, testTag, `${testTag}-${name}`, csv, {
        labelColumn: 'Program', labelIsTown: 'false',
      }).expect(201);
      const { id } = result.body;
      await sendWriteRequest(admin, 'put', `/api/datasets/${id}/curation`, { approvedFields: [indicator] }).expect(200);
      await sendWriteRequest(admin, 'patch', `/api/datasets/${id}`, { isActive: true }).expect(200);
      datasets.push(result.body);
    }
    const [first, second] = datasets;
    const presentationPath = `/api/datasets/${first.id}/presentation`;
    const { body: { settings } } = await admin.agent.get(presentationPath).expect(200);
    await sendWriteRequest(admin, 'put', presentationPath, {
      ...settings, fields: { c0: { label: 'Service program' }, c1: { label: 'People served' } },
    }).expect(200);
    const options = await sendWriteRequest(staff, 'post', '/api/reports/comparison-options', {
      datasetIds: [first.id, second.id],
    }).expect(200);
    assert.equal(options.body.defaultCompare, 'label');
    assert.deepEqual(options.body.groupBy.map(({ id, kind, noun, values }) => [id, kind, noun, values]), [
      ['label', 'column', 'Service program', ['Food aid', 'Housing']],
      ['fields', 'column', 'Service program', ['Food aid', 'Housing']],
    ]);
    const sources = [{ datasetId: first.id, indicator: 'c1' }, { datasetId: second.id, indicator: 'c2' }];
    const selection = {
      dataset: { id: first.id, name: first.name, vintage: first.vintage },
      benchmark: false,
      allRows: true,
      indicators: [`d${first.id}:c1`, `d${second.id}:c2`],
      comparison: { groupBy: 'label', sources },
    };
    const preview = await sendWriteRequest(staff, 'post', '/api/reports/preview', selection).expect(200);
    assert.equal(preview.body.rowNoun, 'Service program');
    assert.equal(preview.body.indicators[0].indicatorLabel, 'People served');
    assert.deepEqual(preview.body.indicators.map(({ cells }) => cells.map(({ value }) => value)), [[100, 80], [null, 90]]);
    assert.deepEqual(preview.body.comparison.sharedIndicators[0].datasets.map(({ indicator }) => indicator), ['c1', 'c2']);
    assert.equal(preview.body.comparison.relationships[0].correlation, null);
    const byAverage = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection,
      comparison: { groupBy: 'label', sources: [sources[0], { ...sources[1], aggregation: 'average' }] },
    }).expect(200);
    assert.deepEqual(byAverage.body.indicators[1].cells.map(({ value, display }) => [value, display]), [[32.5, '32.5'], [90, '90']]);
  } finally {
    await removeTestData(userIds, testTag);
  }
});

test('field comparisons use approved source keys and save the keys used by the report', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = "field-comparison-test-" + crypto.randomUUID();
  const userIds = [];
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);
    const { body: base } = await uploadDataset(admin, testTag, testTag, [
      'Region title,Census ID,Clients,Internal',
      'Capitol Planning Region,001,12,Secret A',
      'Western Planning Region,002,40,Secret B',
      'Exact Case,003,75,Secret C',
    ].join('\n'), { labelColumn: 'Region title' }).expect(201);
    const basePath = '/api/datasets/' + base.id;
    await sendWriteRequest(admin, 'put', basePath + '/curation', { approvedFields: ['c1', 'c2'] }).expect(200);
    await sendWriteRequest(admin, 'put', basePath + '/presentation', {
      revision: 0, fields: { c0: { label: 'Planning region' }, c1: { label: 'Census code' } },
    }).expect(200);
    await sendWriteRequest(admin, 'patch', basePath, { isActive: true }).expect(200);

    const { body: related } = await uploadDataset(staff, testTag, testTag + '-private', [
      'Area,Area Code,Participants',
      'Capitol Planning Region,001,81',
      'Western Planning Region,2,82',
      'EXACT CASE,003,83',
      'Boundary,004,84',
    ].join('\n'), { labelColumn: 'Area' }, '/api/datasets/private').expect(201);
    const datasetIds = [base.id, related.id];
    const primaryFields = { [base.id]: 'c0', [related.id]: 'c0' };
    const codeFields = { [base.id]: 'c1', [related.id]: 'c1' };
    const optionsPath = '/api/reports/comparison-options';
    const { body: options } = await sendWriteRequest(staff, 'post', optionsPath, { datasetIds }).expect(200);
    const primaryOption = options.groupBy.find(({ id }) => id === 'fields');
    assert.equal(options.defaultCompare, 'fields');
    assert.equal(primaryOption.noun, 'Planning region');
    assert.deepEqual(primaryOption.matchFields, primaryFields);
    assert.deepEqual(primaryOption.values, ['Capitol Planning Region', 'Western Planning Region']);
    assert.deepEqual(options.datasets[0].matchFields.map(({ key, label }) => [key, label]), [
      ['c0', 'Planning region'], ['c1', 'Census code'], ['c2', 'Clients'],
    ]);

    const { body: byCodeOptions } = await sendWriteRequest(staff, 'post', optionsPath, {
      datasetIds, matchFields: codeFields,
    }).expect(200);
    assert.deepEqual(byCodeOptions.groupBy.find(({ id }) => id === 'fields').values, ['001', '003']);
    const { body: noMatchOptions } = await sendWriteRequest(staff, 'post', optionsPath, {
      datasetIds, matchFields: { [base.id]: 'c1' },
    }).expect(200);
    assert.deepEqual(noMatchOptions.groupBy.find(({ id }) => id === 'fields').values, []);

    await sendWriteRequest(staff, 'post', optionsPath, { datasetIds, matchFields: { [base.id]: 'c3' } }).expect(400);
    await sendWriteRequest(staff, 'post', optionsPath, { datasetIds, matchFields: { 99999999: 'c0' } }).expect(400);
    await sendWriteRequest(admin, 'post', optionsPath, { datasetIds, matchFields: codeFields }).expect(404);

    const sources = [{ datasetId: base.id, indicator: 'c2' }, { datasetId: related.id, indicator: 'c2' }];
    const selection = {
      dataset: { id: base.id, name: base.name, vintage: base.vintage },
      benchmark: false,
      allRows: true,
      indicators: sources.map(({ datasetId, indicator }) => 'd' + datasetId + ':' + indicator),
      comparison: { groupBy: 'fields', sources },
    };
    const { body: byCode } = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection, comparison: { ...selection.comparison, matchFields: codeFields },
    }).expect(200);
    assert.equal(byCode.rowNoun, 'Census code');
    assert.deepEqual(byCode.places.map(({ name }) => name), ['001', '003']);
    assert.deepEqual(byCode.indicators.map(({ cells }) => cells.map(({ value }) => value)), [[12, 75], [81, 83]]);
    await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection, comparison: { ...selection.comparison, matchFields: { [base.id]: 'c3' } },
    }).expect(400);

    const { body: saved } = await sendWriteRequest(staff, 'post', '/api/reports', { title: testTag, selection }).expect(201);
    assert.deepEqual(saved.selection.comparison.matchFields, primaryFields);
    await sendWriteRequest(staff, 'put', basePath + '/row-label', { rowLabelKey: 'c1' }).expect(200);
    const { body: reopened } = await staff.agent.get('/api/reports/by-slug/' + saved.slug).expect(200);
    assert.deepEqual(reopened.data.places.map(({ name }) => name), primaryOption.values);
    await staff.agent.get('/api/reports/' + saved.id + '/pdf').expect(200).expect('Content-Type', /pdf/);
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
    const numeric = await uploadDataset(admin, testTag, `${testTag}-towns`, 'Town,pop,households\nAndover,1234,500\nBridgewater,2000,800\nConnecticut,4000,2000\n').expect(201);
    await sendWriteRequest(admin, 'put', `/api/datasets/${numeric.body.id}/curation`, { approvedFields: ['pop', 'households'] }).expect(200);
    await sendWriteRequest(admin, 'patch', `/api/datasets/${numeric.body.id}`, { isActive: true }).expect(200);
    const records = await uploadDataset(admin, testTag, `${testTag}-programs`, 'Program,Clients\nFood pantry,1200\nHousing help,300\n', { labelColumn: 'Program', labelIsTown: 'false' }).expect(201);
    await sendWriteRequest(admin, 'put', `/api/datasets/${records.body.id}/curation`, { approvedFields: ['c1'] }).expect(200);
    await sendWriteRequest(admin, 'patch', `/api/datasets/${records.body.id}`, { isActive: true }).expect(200);

    const figures = scriptedClaude([
      { tool: 'list_datasets', input: {} },
      { tool: 'get_figures', input: { dataset_id: numeric.body.id, compare_by: 'town', places: ['Andover', 'Bridgewater'], fields: ['pop'], include_statewide: false, summaries: [{ field: 'pop', calculation: 'average' }] } },
      { tool: 'get_figures', input: { dataset_id: records.body.id, compare_by: 'town', places: [], fields: ['c1'], include_statewide: false, summaries: [] } },
      { text: 'The average is **1,617.00** people per town.' },
    ]);
    setAssistantClientForTests(figures);
    const session = await staff.agent.get('/api/auth/me').expect(200);
    assert.deepEqual(session.body.features, { aiSummary: session.body.features.aiSummary, assistant: true, assistantReports: true });
    const answer = await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'What is the average population?' }],
      context: { page: 'chat' },
    }).expect(200);
    assert.equal(answer.body.reply, 'The average is **1,617.00** people per town.');
    assert.equal(answer.body.proposal, null);
    assert.deepEqual(answer.body.citations, [{
      datasetId: numeric.body.id,
      name: numeric.body.name,
      source: testTag,
      vintage: '2026',
      version: 1,
      url: `/dataset?id=${numeric.body.id}`,
      fields: ['Population', 'average of pop'],
      fieldCount: 2,
      locations: ['Andover', 'Bridgewater'],
      locationCount: 2,
    }]);
    const catalog = JSON.parse(figures.requests[1].messages.at(-1).content[0].content);
    assert.ok(catalog.some(({ id }) => id === numeric.body.id));
    assert.ok(catalog.some(({ id }) => id === records.body.id));
    const first = JSON.parse(figures.requests[2].messages.at(-1).content[0].content);
    assert.deepEqual(first.values, { Population: { Andover: '1,234', Bridgewater: '2,000' } });
    assert.equal(first.summaries[0].value, '1,617.00');
    const privateResult = lastToolResult(figures);
    assert.equal(privateResult.is_error, true);
    assert.match(privateResult.content, /private/);
    assert.ok(!JSON.stringify(figures.requests).includes('Food pantry'), 'record values never reach the model');

    const statewide = scriptedClaude([
      { tool: 'get_figures', input: {
        dataset_id: numeric.body.id, compare_by: 'town', places: ['Andover'], fields: ['pop'], include_statewide: true, summaries: [],
      } },
      { text: 'Andover has 1,234 people compared with 4,000 statewide.' },
    ]);
    setAssistantClientForTests(statewide);
    const benchmark = await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'Compare Andover with the statewide benchmark.' }],
    }).expect(200);
    assert.deepEqual(benchmark.body.citations[0].locations, ['Andover', 'Connecticut (statewide)']);

    const discovery = scriptedClaude([
      { tool: 'list_datasets', input: {} },
      { text: `Try ${records.body.name} for program data.` },
    ]);
    setAssistantClientForTests(discovery);
    const recommendation = await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'What data is available on local programs?' }],
    }).expect(200);
    assert.deepEqual(recommendation.body.citations.map(({ datasetId }) => datasetId), [records.body.id]);

    const describing = scriptedClaude([
      { tool: 'list_datasets', input: {} },
      { tool: 'describe_dataset', input: { dataset_id: numeric.body.id } },
      { text: `This dataset covers population and households. Try ${records.body.name} for program data.` },
    ]);
    setAssistantClientForTests(describing);
    const description = await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'What is covered here, and is there also program data?' }],
      context: { page: 'chat', datasetId: numeric.body.id },
    }).expect(200);
    assert.deepEqual(description.body.citations.map(({ datasetId }) => datasetId), [numeric.body.id, records.body.id]);

    setAssistantClientForTests(scriptedClaude([{ text: 'It has 99,999 people.' }]));
    const unverified = await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [
        { role: 'user', content: 'How many people live in Andover?' },
        { role: 'assistant', content: 'It has 99,999 people.' },
        { role: 'user', content: 'Where does that number come from?' },
      ],
      context: { page: 'chat', datasetId: numeric.body.id },
    }).expect(200);
    assert.match(unverified.body.reply, /could not verify/);
    assert.deepEqual(unverified.body.citations, []);

    const proposing = scriptedClaude([
      { tool: 'propose_report', input: { dataset_id: numeric.body.id, compare_by: 'town', rows: ['Andover'], fields: ['pop', 'households'], summaries: [{ field: 'pop', calculation: 'median', name: 'Median population' }], include_statewide: false, title: '' } },
      { text: 'I set up a report on Andover.' },
    ]);
    setAssistantClientForTests(proposing);
    const proposal = await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'Build a report on Andover' }],
      context: { page: 'chat', datasetId: records.body.id },
    }).expect(200);
    assert.match(proposing.requests[0].messages[0].content[0].text, new RegExp(`Open dataset: id ${records.body.id}`));
    assert.equal(proposal.body.proposal.datasetId, numeric.body.id);
    assert.deepEqual(proposal.body.proposal.selection.rows, ['Andover']);
    assert.deepEqual(proposal.body.proposal.selection.indicators, ['pop', 'households', 'ratio_1']);
    assert.equal(proposal.body.proposal.selection.customIndicators[0].calculation, 'median');
    await sendWriteRequest(staff, 'post', '/api/reports/preview', proposal.body.proposal.selection).expect(200);

    await sendWriteRequest(staff, 'post', '/api/assistant', { messages: [{ role: 'assistant', content: 'Hi' }] }).expect(400);
    await staff.agent.post('/api/assistant').send({ messages: [{ role: 'user', content: 'Hi' }] }).expect(403);
    assert.equal(canGenerateReports({ role: 'viewer' }), false);

    const guest = await createGuestClient(app, { expectAssistant: true });
    const guestProposal = scriptedClaude([
      { tool: 'propose_report', input: {
        dataset_id: numeric.body.id, compare_by: 'town', rows: ['Andover'], fields: ['pop'],
        summaries: [], include_statewide: false, title: 'Andover population',
      } },
      { text: 'I set up a report on Andover.' },
    ]);
    setAssistantClientForTests(guestProposal);
    const guestQuestion = {
      messages: [{ role: 'user', content: 'Make a report for Andover population' }],
      context: { page: 'chat', datasetId: numeric.body.id },
    };
    await guest.agent.post('/api/assistant').send(guestQuestion).expect(403);
    const guestAnswer = await sendWriteRequest(guest, 'post', '/api/assistant', guestQuestion).expect(200);
    assert.equal(guestAnswer.body.proposal.datasetId, numeric.body.id);
    assert.deepEqual(guestAnswer.body.proposal.selection.rows, ['Andover']);
    assert.deepEqual(guestAnswer.body.citations.map(({ datasetId, fields, locations }) => ({ datasetId, fields, locations })), [{
      datasetId: numeric.body.id, fields: ['Population'], locations: ['Andover'],
    }]);
    const guestPreview = await sendWriteRequest(guest, 'post', '/api/reports/preview', guestAnswer.body.proposal.selection).expect(200);
    assert.equal(guestPreview.body.indicators[0].cells[0].value, 1234);
  } finally {
    setAssistantClientForTests(undefined);
    await removeTestData(userIds, testTag);
  }
});

test('only the uploader can access a private dataset or any report using it', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = `private-test-${crypto.randomUUID()}`;
  const userIds = [];
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });

  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);
    const csv = 'Town,Clients,Category\nAndover,54321,unshared-label\n';
    const published = await uploadDataset(admin, testTag, testTag, 'Town,Clients\nAndover,19\n').expect(201);
    await sendWriteRequest(admin, 'put', `/api/datasets/${published.body.id}/curation`, { approvedFields: ['c1'] }).expect(200);
    await sendWriteRequest(admin, 'patch', `/api/datasets/${published.body.id}`, { isActive: true }).expect(200);

    const privateSourceUrl = 'https://example.invalid/client-data';
    const first = await uploadDataset(staff, privateSourceUrl, testTag, csv, {}, '/api/datasets/private').expect(201);
    const second = await uploadDataset(staff, testTag, testTag, csv, {}, '/api/datasets/private').expect(201);
    const { id, isPrivate, isActive } = first.body;
    assert.equal(isPrivate, true);
    assert.equal(isActive, true);
    assert.equal(first.body.version, 1);
    assert.equal(second.body.version, 2);
    const datasetPath = `/api/datasets/${id}`;
    const uploaded = await staff.agent.get('/api/datasets?scope=private').expect(200);
    assert.deepEqual(uploaded.body.map((dataset) => dataset.id), [second.body.id, id]);
    const curated = await staff.agent.get('/api/datasets?scope=public').expect(200);
    assert.ok(curated.body.some((dataset) => dataset.id === published.body.id && dataset.isActive));
    assert.ok(curated.body.every((dataset) => !dataset.isPrivate));

    const ownerPreview = await staff.agent.get(datasetPath).expect(200);
    assert.equal(ownerPreview.body.preview.rows[0].cells[1].value, 54321);
    await staff.agent.get(`${datasetPath}/report-options`).expect(200);
    const unrelated = await admin.agent.get('/api/datasets').expect(200);
    assert.ok(unrelated.body.every((dataset) => dataset.id !== id));
    for (const suffix of ['', '/curation', '/presentation', '/row-label', '/report-options']) {
      await admin.agent.get(datasetPath + suffix).expect(404);
    }
    await sendWriteRequest(admin, 'patch', datasetPath, { isActive: false }).expect(404);

    const selection = {
      dataset: { id, name: testTag, vintage: '2026' },
      compareBy: 'town',
      rows: ['Andover'],
      benchmark: false,
      indicators: ['c1'],
    };
    await sendWriteRequest(admin, 'post', '/api/reports/preview', selection).expect(404);
    const preview = await sendWriteRequest(staff, 'post', '/api/reports/preview', selection).expect(200);
    assert.equal(preview.body.indicators[0].cells[0].value, 54321);
    const secondary = {
      ...selection,
      dataset: { id: published.body.id, name: testTag, vintage: '2026' },
      comparison: {
        groupBy: 'town',
        sources: [published.body.id, id].map((datasetId) => ({ datasetId, indicator: 'c1' })),
      },
      indicators: [`d${published.body.id}:c1`, `d${id}:c1`],
    };
    await sendWriteRequest(admin, 'post', '/api/reports/preview', secondary).expect(404);
    for (const reportSelection of [selection, secondary]) {
      const saved = await sendWriteRequest(staff, 'post', '/api/reports', { title: testTag, selection: reportSelection }).expect(201);
      assert.equal(saved.body.isPrivate, true);
      const reportPath = `/api/reports/${saved.body.id}`;
      const slugPath = `/api/reports/by-slug/${saved.body.slug}`;
      await staff.agent.get(reportPath).expect(200);
      await staff.agent.get(slugPath).expect(200);
      await staff.agent.get(`${reportPath}/pdf`).expect(200).expect('Content-Type', /pdf/);
      await admin.agent.get(reportPath).expect(404);
      await admin.agent.get(slugPath).expect(404);
      await admin.agent.get(`${reportPath}/pdf`).expect(404);
      await sendWriteRequest(admin, 'post', `${reportPath}/duplicate`, {}).expect(404);
    }
    const found = await admin.agent.get('/api/reports').query({ q: testTag }).expect(200);
    assert.deepEqual(found.body, []);

    const scripted = scriptedClaude([
      { tool: 'describe_dataset', input: { dataset_id: id } },
      { text: 'That dataset is unavailable.' },
    ]);
    setAssistantClientForTests(scripted);
    const unauthorized = await sendWriteRequest(admin, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'Describe this dataset' }],
      context: { page: 'chat', datasetId: id, includePrivate: true },
    }).expect(200);
    assert.deepEqual(unauthorized.body.citations, []);
    assert.equal(lastToolResult(scripted).is_error, true);
    assert.ok(!JSON.stringify(scripted.requests).includes(testTag));

    const publicChat = scriptedClaude([
      { tool: 'list_datasets', input: {} },
      { tool: 'describe_dataset', input: { dataset_id: id } },
      { text: 'That dataset is unavailable.' },
    ]);
    setAssistantClientForTests(publicChat);
    await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'What data is available?' }],
      context: { page: 'chat', datasetId: id },
    }).expect(200);
    assert.doesNotMatch(publicChat.requests[0].messages[0].content[0].text, /Open dataset:/);
    const publicCatalog = JSON.parse(publicChat.requests[1].messages.at(-1).content[0].content);
    assert.ok(publicCatalog.some((dataset) => dataset.id === published.body.id));
    assert.ok(publicCatalog.every((dataset) => dataset.id !== id && dataset.id !== second.body.id));
    assert.equal(lastToolResult(publicChat).is_error, true);

    const guest = await createGuestClient(app, { expectAssistant: true });
    for (const path of REPORT_PATHS) {
      await sendWriteRequest(guest, 'post', path, selection).expect(404);
      await sendWriteRequest(guest, 'post', path, secondary).expect(404);
    }
    await sendWriteRequest(guest, 'post', '/api/reports/comparison-options', {
      datasetIds: [published.body.id, id],
    }).expect(404);
    const guestChat = scriptedClaude([
      { tool: 'list_datasets', input: {} },
      { tool: 'describe_dataset', input: { dataset_id: id } },
      { text: 'That dataset is unavailable.' },
    ]);
    setAssistantClientForTests(guestChat);
    const guestResponse = await sendWriteRequest(guest, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'What data is available?' }],
      context: { page: 'chat', datasetId: id, includePrivate: true },
    }).expect(200);
    assert.deepEqual(guestResponse.body.citations, []);
    assert.doesNotMatch(guestChat.requests[0].messages[0].content[0].text, /Open dataset:/);
    const guestCatalog = JSON.parse(guestChat.requests[1].messages.at(-1).content[0].content);
    assert.ok(guestCatalog.some((dataset) => dataset.id === published.body.id));
    assert.ok(guestCatalog.every((dataset) => dataset.id !== id && dataset.id !== second.body.id));
    assert.equal(lastToolResult(guestChat).is_error, true);

    const ownerChat = scriptedClaude([
      { tool: 'list_datasets', input: {} },
      { tool: 'compare_datasets', input: {
        sources: [id, published.body.id].map((dataset_id) => ({ dataset_id, indicator: 'c1', aggregation: 'source' })),
        group_by: 'town',
        rows: ['Andover'],
        create_report: false,
        title: '',
      } },
      { text: 'Andover has 54,321 clients.' },
    ]);
    setAssistantClientForTests(ownerChat);
    await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'How many clients does Andover have?' }],
      context: { page: 'chat', datasetIds: [id] },
    }).expect(404);
    assert.equal(ownerChat.requests.length, 0);
    const ownerAnswer = await sendWriteRequest(staff, 'post', '/api/assistant', {
      messages: [{ role: 'user', content: 'How many clients does Andover have?' }],
      context: { page: 'chat', includePrivate: true },
    }).expect(200);
    assert.deepEqual(ownerAnswer.body.citations.map(({ datasetId, sourceUrl, fields, locations }) =>
      ({ datasetId, sourceUrl, fields, locations })), [
      { datasetId: id, sourceUrl: privateSourceUrl, fields: ['Clients'], locations: ['Andover'] },
      { datasetId: published.body.id, sourceUrl: undefined, fields: ['Clients'], locations: ['Andover'] },
    ]);
    const ownerCatalog = JSON.parse(ownerChat.requests[1].messages.at(-1).content[0].content);
    assert.ok(ownerCatalog.some((dataset) => dataset.id === id));
    assert.ok(ownerCatalog.some((dataset) => dataset.id === second.body.id));
    assert.deepEqual(JSON.parse(lastToolResult(ownerChat).content).values, {
      [`d${id}:c1`]: { Andover: '54,321' },
      [`d${published.body.id}:c1`]: { Andover: '19' },
    });
    assert.ok(!JSON.stringify(ownerChat.requests).includes('unshared-label'));
  } finally {
    setAssistantClientForTests(undefined);
    await removeTestData(userIds, testTag);
  }
});

after(() => pool.end());
