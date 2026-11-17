#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

const {
  CTDE_SMOKE_ORIGIN, CTDE_SMOKE_PROVIDER, CTDE_SMOKE_GUEST_ONLY, CTDE_SMOKE_OWNER: ownerEmail,
} = process.env;
const rows = ['Andover', 'Bridgewater', 'Hartford'];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function client(origin) {
  let cookie;
  let csrf;

  async function request(path, { method = 'GET', body, expected = 200 } = {}) {
    const headers = new Headers();
    if (cookie) headers.set('Cookie', cookie);
    if (csrf) headers.set('X-CSRF-Token', csrf);
    if (body && !(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }
    const response = await fetch(new URL(path, origin), {
      method, headers, body, redirect: 'error', signal: AbortSignal.timeout(120_000),
    });
    check(response.status === expected, `${method} ${path} returned HTTP ${response.status}, expected ${expected}`);
    return response;
  }

  async function readSession(response) {
    const session = await response.json();
    const setCookie = response.headers.get('set-cookie');
    check(setCookie?.includes('; HttpOnly') && setCookie.includes('; Secure') && session.csrfToken,
      'Expected a Secure, HttpOnly session cookie and CSRF token');
    cookie = setCookie.split(';')[0];
    csrf = session.csrfToken;
    return session;
  }

  return {
    request,
    async json(path, options) {
      return (await request(path, options)).json();
    },
    async startGuest() {
      return readSession(await request('/api/auth/session'));
    },
    async signIn(prefix = 'CTDE_SMOKE') {
      const password = process.env[`${prefix}_PASSWORD`];
      const email = process.env[`${prefix}_EMAIL`];
      const setup = URL.parse(process.env[`${prefix}_SETUP_URL`] ?? '');
      check(password && (setup || email), `Set ${prefix}_PASSWORD and ${prefix}_EMAIL or ${prefix}_SETUP_URL`);
      const token = setup && new URLSearchParams(setup.hash.slice(1)).get('token');
      check(!setup || (setup.origin === origin && setup.pathname === '/set-password' && token), 'Invalid setup link for this environment');
      const response = await request(setup ? '/api/auth/set-password' : '/api/auth/login', {
        method: 'POST', body: setup ? { token, password } : { email, password },
      });
      return readSession(response);
    },
  };
}

async function sampleDataset(api) {
  const datasets = await api.json('/api/datasets');
  const dataset = datasets.find((item) => item.name === 'ACS 5-Year Town Profile' && item.vintage === '2024' && item.isActive);
  check(dataset, 'Seed the ACS sample dataset before running this check');
  return { dataset, datasets };
}

function comparison(dataset, secondary, indicator) {
  const sources = [{ datasetId: dataset.id, indicator: 'pop' }, { datasetId: secondary.id, indicator }];
  return {
    dataset: { id: dataset.id, name: dataset.name, vintage: dataset.vintage },
    rows,
    benchmark: false,
    comparison: { groupBy: 'town', sources },
    indicators: sources.map((source) => `d${source.datasetId}:${source.indicator}`),
  };
}

async function verifyReport(api, selection) {
  const preview = await api.json('/api/reports/preview', { method: 'POST', body: selection });
  check(preview.places.length === rows.length && preview.indicators.length === 2 &&
    preview.comparison?.relationships?.[0]?.pairedRows === rows.length, 'Expected aligned comparison figures for three towns');
  const pdf = await api.request('/api/reports/pdf', { method: 'POST', body: selection });
  const signature = new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5));
  check(signature === '%PDF-', 'Report export returned an invalid PDF');
}

async function verifyGeography(api, selection) {
  for (const [groupBy, name] of [
    ['state', 'Connecticut'], ['county', 'Hartford County'], ['region', 'Capitol Planning Region'],
  ]) {
    const sources = selection.comparison.sources.map((source) => ({ ...source, aggregation: groupBy === 'state' ? 'source' : 'sum' }));
    const body = { ...selection, rows: [name], comparison: { groupBy, sources } };
    const preview = await api.json('/api/reports/preview', { method: 'POST', body });
    check(preview.places.length === 1 && preview.places[0].name === name, `Expected the report to filter to ${name}`);
    const cell = preview.indicators[0].cells[0];
    check(groupBy === 'state' ? cell.value === 3624508 : cell.value > 121127 && cell.rollupFrom === 'town',
      `Expected a population figure for ${name}`);
  }
  console.log('State, county, and planning-region report checks passed.');
}

function assistantBody(dataset) {
  return {
    messages: [{ role: 'user', content: `Use dataset ${dataset.id}. What is Hartford's population in this dataset? Look up the reported figure.` }],
    context: { page: 'chat', datasetIds: [dataset.id], includePrivate: false },
  };
}

async function verifyAssistant(api, dataset) {
  const assistant = await api.json('/api/assistant', { method: 'POST', body: assistantBody(dataset) });
  check(/\b121[,.\s]?127\b/.test(assistant.reply), 'Expected the assistant to return Hartford’s population from the ACS sample');
  const citation = assistant.citations?.find((item) => item.datasetId === dataset.id);
  check(citation?.url === `/dataset?id=${dataset.id}` && citation.source === dataset.source &&
    citation.vintage === dataset.vintage && citation.version === dataset.version,
    'Expected a citation linking to the exact ACS dataset version and naming its source');
  check(citation.locations?.includes('Hartford'), 'Expected the citation to identify Hartford');
  check(citation.sourceUrl === 'https://www.census.gov/data/developers/data-sets/acs-5year/2024.html',
    'Expected a link to the Census Bureau’s 2024 ACS release');
  await api.request(citation.url);
}

async function verifyGuest(origin) {
  const guest = client(origin);
  const session = await guest.startGuest();
  check(session.user === null, 'Expected an anonymous session');

  const { dataset, datasets } = await sampleDataset(guest);
  check(datasets.every((item) => item.isActive && !item.isPrivate), 'Guests should see only published public datasets');
  await guest.request('/api/datasets?scope=private', { expected: 401 });
  await guest.request('/api/datasets/private/inspect', { method: 'POST', expected: 401 });
  await guest.request(`/api/datasets/${dataset.id}`);
  await guest.request(`/api/datasets/${dataset.id}/report-options`);

  const selection = comparison(dataset, dataset, 'households');
  await guest.request('/api/reports', { expected: 401 });
  await guest.request('/api/reports', { method: 'POST', body: {}, expected: 401 });
  await guest.request('/api/ai-settings', { expected: 401 });
  await client(origin).request('/api/reports/preview', { method: 'POST', body: selection, expected: 403 });
  const options = await guest.json('/api/reports/comparison-options', {
    method: 'POST', body: { datasetIds: [dataset.id] },
  });
  check(options.groupBy.some(({ id, values }) => id === 'town' && values.includes('Hartford')),
    'Expected public comparison options for Hartford');
  await verifyReport(guest, selection);
  console.log('Guest browsing, report comparison, PDF export, and account access checks passed.');

  if (session.features.assistant) {
    await client(origin).request('/api/assistant', { method: 'POST', body: assistantBody(dataset), expected: 403 });
    await verifyAssistant(guest, dataset);
    console.log('Grounded guest AI chat and source links passed.');
  } else {
    console.log('Guest AI chat is unavailable in this environment.');
  }
  return session.features.assistant;
}

// The opt-in private check reuses a synthetic fixture owned by a dedicated staging user.
async function verifyPrivate(origin, admin, dataset) {
  const owner = client(origin);
  const session = await owner.signIn('CTDE_SMOKE_OWNER');
  check(session.user.role === 'staff' && session.user.email === ownerEmail, 'Use dedicated staff credentials for the private smoke check');
  await owner.request('/api/admin/usage', { expected: 403 });
  await owner.request('/api/ai-settings', { expected: 403 });

  const name = 'Deployment smoke test (synthetic)';
  const ownDatasets = await owner.json('/api/datasets?scope=private');
  let fixture = ownDatasets.find((item) => item.name === name);
  if (!fixture) {
    const body = new FormData();
    body.append('file', new Blob(['Town,Visits\nAndover,12\nBridgewater,7\nHartford,23\n']), 'smoke.csv');
    body.append('name', name);
    body.append('source', 'Deployment smoke test');
    body.append('vintage', 'Test');
    fixture = await owner.json('/api/datasets/private', { method: 'POST', body, expected: 201 });
  }
  const options = await owner.json(`/api/datasets/${fixture.id}/report-options`);
  const visits = options.columns.find((field) => field.label === 'Visits');
  check(visits, 'Expected uploaded Visits indicator');
  const selection = comparison(dataset, fixture, visits.key);
  await verifyReport(owner, selection);

  const saved = await owner.json('/api/reports', {
    method: 'POST', body: { title: `Smoke ${randomUUID()}`, selection }, expected: 201,
  });
  try {
    await owner.request(`/api/reports/${saved.id}`);
    await admin.request(`/api/datasets/${fixture.id}`, { expected: 404 });
    await admin.request('/api/reports/preview', { method: 'POST', body: selection, expected: 404 });
    await admin.request(`/api/reports/${saved.id}`, { expected: 404 });
  } finally {
    await owner.request(`/api/reports/${saved.id}`, { method: 'DELETE', expected: 204 });
    await owner.request('/api/auth/logout', { method: 'POST', expected: 204 });
  }
  console.log('Private upload, cross-dataset export, and ownership checks passed.');
}

async function main() {
  const base = URL.parse(CTDE_SMOKE_ORIGIN ?? '');
  check(base?.protocol === 'https:' && base.href === `${base.origin}/`, 'Set CTDE_SMOKE_ORIGIN to the HTTPS origin');
  const api = client(base.origin);
  check((await api.json('/healthz')).status === 'ok', 'Database health check failed');
  for (const page of ['/', '/login', '/builder', '/chat']) {
    const response = await api.request(page);
    check(response.headers.get('content-type')?.includes('text/html'), `Expected a page at ${page}`);
    await response.body.cancel();
  }
  const guestAssistantAvailable = await verifyGuest(base.origin);
  if (CTDE_SMOKE_GUEST_ONLY === '1') return;

  const session = await api.signIn();
  check(session.user.role === 'admin', 'Use administrator credentials for the deployment smoke check');
  const { dataset } = await sampleDataset(api);
  const selection = comparison(dataset, dataset, 'households');
  await verifyReport(api, selection);
  console.log('HTTPS, sign-in, database, report comparison, and PDF checks passed.');
  await verifyGeography(api, selection);

  const settings = await api.json('/api/ai-settings');
  check(settings.available && settings.provider === (CTDE_SMOKE_PROVIDER || 'google'), 'Expected the configured AI provider to be available');

  check(guestAssistantAvailable, 'Expected the configured AI provider to be available for guests');
  await verifyAssistant(api, dataset);
  console.log(`Grounded AI chat passed with ${settings.provider}.`);

  const usage = await api.json('/api/admin/usage');
  check(usage.activity?.report_preview > 0 && usage.activity?.ai_analysis > 0, 'Expected report and AI usage statistics');
  console.log('Usage analytics checks passed.');
  if (ownerEmail) await verifyPrivate(base.origin, api, dataset);
  await api.request('/api/auth/logout', { method: 'POST', expected: 204 });
}

try {
  await main();
} catch (error) {
  console.error(`Deployment smoke check failed: ${error instanceof SyntaxError ? 'invalid server response' : error.message}`);
  process.exitCode = 1;
}
