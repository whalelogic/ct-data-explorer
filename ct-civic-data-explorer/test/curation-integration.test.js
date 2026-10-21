/** Opt in against a migrated local database: CT_CURATION_INTEGRATION=1 npm test. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, test } from 'node:test';
import bcrypt from 'bcryptjs';
import session from 'express-session';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

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
  const response = await sendWriteRequest(client, 'post', '/api/reports/preview', allTownSelection)
    .expect(200);
  const report = response.body;
  const chartBlocks = report.blocks.filter((block) => block.type === 'chart');
  const chartKeys = chartBlocks.flatMap((block) => block.chart.series.map((series) => series.key));

  assert.equal(report.title, `${report.dataset.displayName}: ${report.indicators.map((field) => field.label).join(' · ')}`.slice(0, 200));
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
  assert.deepEqual(reloadedResponse.body.selection.towns, townNames);
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
    assert.deepEqual(recordOptions.body.filters.map((field) => field.key), ['c2']);
    assert.deepEqual(recordOptions.body.filters[0].values, ['123', '124']);
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
    assert.deepEqual(indicatorOptions.body.filters.map((field) => field.key), [approvedIndicatorKey]);
    assert.equal(indicatorOptions.body.filters[0].values[0], '456');

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
    const filteredIndicators = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...indicatorSelection, towns: [], recordFilters: { [approvedIndicatorKey]: '456' },
    }).expect(200);
    assert.deepEqual(filteredIndicators.body.places.map((place) => place.name), ['Andover']);

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

test('generic datasets retain source records through approval, flexible charts, saved reports and PDFs', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = `generic-records-test-${crypto.randomUUID()}`;
  const userIds = [];
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);
    const csv = [
      'Category,Segment,Jobs,Percentage (decimal format),Hidden category,Private amount',
      'Retail,North,10,0.1,SECRET-A,9000',
      'Retail,North,10,0.1,SECRET-A,9000',
      'Retail,North,20,0.2,SECRET-B,9000',
      'Retail,South,5,0.3,SECRET-C,9000',
      'Services,North,7,0.4,SECRET-D,9000',
      '',
    ].join('\n');
    const uploaded = await uploadDataset(admin, testTag, testTag, csv).expect(201);
    const datasetPath = `/api/datasets/${uploaded.body.id}`;
    assert.equal(uploaded.body.dataFormat, 'records');
    assert.equal(uploaded.body.rowCount, 5);
    await sendWriteRequest(admin, 'put', `${datasetPath}/curation`, { approvedFields: ['c0', 'c1', 'c2', 'c3'] }).expect(200);
    await sendWriteRequest(admin, 'patch', datasetPath, { isActive: true }).expect(200);
    await sendWriteRequest(staff, 'put', `${datasetPath}/presentation`, {
      revision: 0, displayName: 'Employment by category',
      fields: { c0: { label: 'Industry' }, c2: { label: 'Employment', decimals: 0 } },
    }).expect(200);

    const options = await staff.agent.get(`${datasetPath}/report-options`).expect(200);
    assert.deepEqual(options.body.places, []);
    assert.equal(options.body.hasGeography, false);
    assert.equal(options.body.hasLocations, false);
    assert.equal(options.body.hasState, false);
    assert.deepEqual(options.body.columns.map((field) => field.key), ['c0', 'c1', 'c2', 'c3']);
    assert.equal(options.body.columns[0].displayLabel, 'Industry');
    assert.equal(options.body.columns[2].displayLabel, 'Employment');
    assert.equal(options.body.columns[3].unit, 'percent');
    assert.deepEqual(options.body.filters.find((field) => field.key === 'c2').values, ['5', '7', '10', '20']);
    assert.ok(!JSON.stringify(options.body).includes('Hidden category'));

    const overview = await staff.agent.get(datasetPath).expect(200);
    assert.equal(overview.body.preview.total, 5);
    assert.equal(overview.body.preview.rows.length, 5);
    assert.deepEqual(overview.body.preview.rows.map((row) => row.sourceRow), [2, 3, 4, 5, 6]);
    assert.ok(!JSON.stringify(overview.body).includes('SECRET'));

    const chart = {
      type: 'chart', chartType: 'grouped_bar', indicators: ['c2'],
      axisField: 'c0', seriesField: 'c1', aggregation: 'none', title: 'Employment source records',
    };
    const selection = {
      dataset: { name: testTag, vintage: '2026' },
      indicators: ['c0', 'c1', 'c2', 'c3'],
      title: 'Our employment report',
      layout: [chart, { type: 'table' }],
    };
    const raw = await sendWriteRequest(staff, 'post', '/api/reports/preview', selection).expect(200);
    assert.equal(raw.body.title, 'Our employment report');
    const rawChart = raw.body.blocks.find((block) => block.type === 'chart').chart;
    assert.equal(rawChart.title, 'Employment source records');
    assert.equal(rawChart.aggregation, 'none');
    assert.equal(rawChart.labels.length, 5);
    assert.equal(new Set(rawChart.labels).size, 5);
    assert.deepEqual(rawChart.series.flatMap((series) => series.values.filter((value) => value != null)).sort((a, b) => a - b), [5, 7, 10, 10, 20]);
    assert.equal(raw.body.blocks.find((block) => block.type === 'records').records.length, 5);
    assert.deepEqual(raw.body.indicators.find((field) => field.key === 'c2').cells.map((cell) => cell.value), [10, 10, 20, 5, 7]);

    const aggregate = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection, layout: [{ ...chart, aggregation: 'sum', title: '' }, { type: 'table' }],
    }).expect(200);
    const aggregateChart = aggregate.body.blocks.find((block) => block.type === 'chart').chart;
    assert.deepEqual(aggregateChart.labels, ['Retail', 'Services']);
    assert.deepEqual(aggregateChart.series.find((series) => series.label.endsWith('North')).values, [40, 7]);
    assert.deepEqual(aggregateChart.series.find((series) => series.label.endsWith('South')).values, [5, null]);
    assert.equal(aggregate.body.blocks.find((block) => block.type === 'records').records.length, 5);

    const mixed = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection, layout: [{ ...chart, indicators: ['c2', 'c3'], title: '' }],
    }).expect(200);
    const mixedCharts = mixed.body.blocks.filter((block) => block.type === 'chart');
    assert.equal(mixedCharts.length, 2);
    assert.equal(new Set(mixedCharts.map((block) => block.chart.unit)).size, 2);
    for (const block of mixedCharts) {
      assert.ok(block.chart.series.every((series) => series.unit === block.chart.unit));
    }

    const filtered = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection, recordFilters: { c2: '10' },
    }).expect(200);
    assert.equal(filtered.body.blocks.find((block) => block.type === 'records').records.length, 2);
    for (const invalid of [
      { ...selection, layout: [{ ...chart, axisField: 'c4' }] },
      { ...selection, layout: [{ ...chart, seriesField: 'c4' }] },
      { ...selection, recordFilters: { c4: 'SECRET-A' } },
      { ...selection, layout: [{ ...chart, axisField: '@location' }] },
      { ...selection, towns: ['Andover'] },
      { ...selection, benchmark: true },
    ]) {
      await sendWriteRequest(staff, 'post', '/api/reports/preview', invalid).expect(400);
    }

    const defaultTitles = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
      ...selection, title: '', layout: [{ ...chart, title: '' }],
    }).expect(200);
    assert.match(defaultTitles.body.title, /Employment by category/);
    assert.match(defaultTitles.body.blocks[0].chart.title, /Employment/);
    assert.match(defaultTitles.body.blocks[0].chart.title, /Industry/);

    const saved = await sendWriteRequest(staff, 'post', '/api/reports', { title: 'Saved employment', selection }).expect(201);
    const restored = await staff.agent.get(`/api/reports/${saved.body.id}`).expect(200);
    assert.deepEqual(restored.body.selection.towns, []);
    assert.equal(restored.body.selection.benchmark, false);
    assert.equal(restored.body.selection.title, selection.title);
    assert.deepEqual(restored.body.selection.layout[0], chart);
    const reopened = await sendWriteRequest(staff, 'post', '/api/reports/preview', restored.body.selection).expect(200);
    assert.equal(reopened.body.blocks.find((block) => block.type === 'records').records.length, 5);
    const pdf = await staff.agent.get(`/api/reports/${saved.body.id}/pdf`).expect(200).expect('Content-Type', /pdf/);
    assert.ok(pdf.body.length > 1000);
    assert.match(pdf.body.toString('ascii', 0, 8), /^%PDF-/);
  } finally {
    await removeTestData(userIds, testTag);
  }
});

test('mixed Town dimensions cannot expose withheld place labels or drop Connecticut source records', {
  skip: process.env.CT_CURATION_INTEGRATION !== '1',
}, async () => {
  const testTag = `mixed-location-test-${crypto.randomUUID()}`;
  const userIds = [];
  const app = createApp({ sessionStore: new session.MemoryStore(), logRequests: false });
  try {
    const { admin, staff } = await createTestClients(app, testTag, userIds);
    for (const location of ['Andover', 'Connecticut']) {
      const name = `${testTag}-${location}`;
      const uploaded = await uploadDataset(admin, testTag, name, `Town,Jobs\n${location},10\nNew York,20\n`).expect(201);
      const path = `/api/datasets/${uploaded.body.id}`;
      await sendWriteRequest(admin, 'put', `${path}/curation`, { approvedFields: ['c1'] }).expect(200);
      await sendWriteRequest(admin, 'patch', path, { isActive: true }).expect(200);
      const options = await staff.agent.get(`${path}/report-options`).expect(200);
      assert.deepEqual(options.body.places, []);
      assert.equal(options.body.hasGeography, false);
      assert.equal(options.body.hasState, false);
      assert.deepEqual(options.body.columns.map((field) => field.key), ['c1']);

      const selection = {
        dataset: { name, vintage: '2026' }, indicators: ['c1'],
        layout: [{ type: 'chart' }, { type: 'table' }],
      };
      const preview = await sendWriteRequest(staff, 'post', '/api/reports/preview', selection).expect(200);
      assert.equal(preview.body.places.length, 2);
      assert.deepEqual(preview.body.indicators[0].cells.map((cell) => cell.value), [10, 20]);
      assert.equal(preview.body.blocks.find((block) => block.type === 'records').records.length, 2);
      const renderedLabels = preview.body.places.flatMap((place) => [place.label, place.name]);
      assert.ok(renderedLabels.every((label) => !label.includes(location) && !label.includes('New York')));
      assert.ok(preview.body.places.every((place) => !place.geoType));
      await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, benchmark: true }).expect(400);
      await sendWriteRequest(staff, 'post', '/api/reports/preview', { ...selection, towns: [location] }).expect(400);

      // Approving the ordinary dimension reveals source text without enabling geography.
      await sendWriteRequest(admin, 'put', `${path}/curation`, { approvedFields: ['c0', 'c1'] }).expect(200);
      const approved = await sendWriteRequest(staff, 'post', '/api/reports/preview', {
        ...selection, indicators: ['c0', 'c1'],
      }).expect(200);
      assert.deepEqual(approved.body.indicators[0].cells.map((cell) => cell.rawValue), [location, 'New York']);
      assert.equal(approved.body.blocks.find((block) => block.type === 'records').records.length, 2);
    }
  } finally {
    await removeTestData(userIds, testTag);
  }
});

after(() => pool.end());
