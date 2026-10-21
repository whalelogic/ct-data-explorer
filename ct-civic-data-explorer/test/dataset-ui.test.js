import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { unitLabel } from '../src/shared/format.js';

class Element {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.children = [];
    this.listeners = {};
    this.hidden = Object.hasOwn(attributes, 'hidden');
    this.disabled = false;
    this.value = '';
    this.dataset = {};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : child).join(''); }
  set textContent(value) { this.children = [value]; }
}

const recordFields = [
  { key: 'c0', label: 'Region', type: 'text', role: 'town' },
  { key: 'c1', label: 'Category', type: 'text', role: 'dimension' },
  { key: 'c2', label: 'Jobs', type: 'number', unit: 'count', decimals: 0, role: 'measure' },
];

function recordOverview() {
  return {
    dataset: {
      id: 17, name: 'Source records', displayName: 'Employment', dataFormat: 'records', source: 'Data office',
      vintage: '2026', version: 2, rowCount: 999, uploadedBy: 'Test user', uploadedAt: '2026-10-17',
      isActive: true, curationReviewed: true, approvedFields: ['c1', 'c2'], importNotes: ['Source note'],
    },
    indicators: recordFields.slice(1),
    preview: { total: 28, columns: recordFields, rows: [
      { sourceRow: 2, cells: [{ display: 'North' }, { display: 'Retail' }, { display: '12' }] },
      { sourceRow: 3, cells: [{ display: 'North' }, { display: 'Retail' }, { display: '13' }] },
    ] },
  };
}

async function createDatasetPage({ role = 'staff', data = recordOverview() } = {}) {
  const html = await readFile(new URL('../public/dataset.html', import.meta.url), 'utf8');
  const nodes = new Map();
  for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const attributes = {};
    for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes[attribute[1]] = attribute[2] ?? '';
    nodes.set(match[3], new Element(match[1], attributes));
  }
  const requests = [];
  let response = data;
  const context = vm.createContext({
    URLSearchParams, unitLabel,
    document: { getElementById: (id) => {
      assert.ok(nodes.has(id), `Dataset references a real element: ${id}`);
      return nodes.get(id);
    } },
    location: { search: '?id=17' },
    loadSession: async () => ({ user: { role } }),
    renderHeader() {}, boot() {}, formatDate: (value) => value,
    mountDatasetPresentation: async () => {}, mountIndicatorEditor() {},
    api: async (path) => {
      requests.push(path);
      if (path.endsWith('/curation')) return { fields: recordFields.slice(1), approvedFields: ['c1', 'c2'], curationReviewed: true };
      return structuredClone(response);
    },
    showStatus: (element, text) => { element.textContent = text; element.hidden = !text; },
    createElement: (tagName, properties = {}, ...children) => {
      const element = new Element(tagName);
      Object.assign(element, properties);
      element.append(...children);
      return element;
    },
  });
  const script = (await readFile(new URL('../public/js/dataset.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(script, context);
  await vm.runInContext('initializeDatasetPage()', context);
  return { html, nodes, requests, context, setResponse: (next) => { response = next; } };
}

function summaryValues(nodes) {
  return Object.fromEntries(nodes.get('dataset-summary').children.map((pair) => [
    pair.children[0].textContent, pair.children[1].textContent,
  ]));
}

test('dataset opens on Data preview with live counts and carries its ID to the report builder', async () => {
  const { nodes, html } = await createDatasetPage();
  assert.equal(nodes.has('dataset-overview-tab'), false);
  assert.equal(nodes.get('dataset-data-tab').getAttribute('aria-selected'), 'true');
  assert.equal(nodes.get('dataset-data-tab').getAttribute('tabindex'), '0');
  assert.match(html, /id="dataset-data-tab"[^>]*>Data preview<\/button>/);
  assert.equal(nodes.get('dataset-data').hidden, false);
  assert.equal(nodes.get('dataset-fields').hidden, true);
  assert.equal(nodes.get('dataset-appearance').hidden, true);
  assert.deepEqual(summaryValues(nodes), { Source: 'Data office', Period: '2026', Rows: '28 rows', Fields: '3 fields' });
  assert.equal(nodes.get('make-report').href, '/builder?dataset=17');
  assert.match(html, /id="make-report"[^>]*>Create a report with this data<\/a>/);
  assert.match(nodes.get('data-preview').textContent, /Source rowRegionCategoryJobs/);
  assert.equal(nodes.get('data-preview').children[0].children[2].children.length, 2, 'Repeated source rows remain separate');
  assert.equal(nodes.get('dataset-summary').hidden, false);
  assert.equal(nodes.get('dataset-details').hidden, false);
  assert.equal(nodes.get('dataset-details').getAttribute('open'), undefined, 'Secondary details start collapsed');
});

test('dataset counts refresh from each preview and exclude only the synthetic source-row index', async () => {
  const { nodes, context, setResponse } = await createDatasetPage();
  const next = recordOverview();
  next.preview.total = 31;
  next.preview.columns = [recordFields[2]];
  next.indicators = [recordFields[2]];
  next.preview.rows = [{ sourceRow: 27, cells: [{ display: '12' }] }];
  setResponse(next);
  await vm.runInContext('loadDataset(25)', context);
  assert.deepEqual(summaryValues(nodes), { Source: 'Data office', Period: '2026', Rows: '31 rows', Fields: '1 field' });
  assert.equal(nodes.get('preview-summary').textContent, 'Rows 26–26 of 31');
  assert.equal(nodes.get('previous').disabled, false);
  assert.equal(nodes.get('next').disabled, false);
});

test('indicator dataset field count includes its visible Town field', async () => {
  const data = recordOverview();
  data.dataset.dataFormat = 'indicators';
  data.indicators = [recordFields[2]];
  data.preview = { total: 2, rows: [{ place: { label: 'Andover' }, cells: [{ display: '12' }] }] };
  const { nodes } = await createDatasetPage({ data });
  assert.equal(summaryValues(nodes).Fields, '2 fields');
  assert.match(nodes.get('data-preview').textContent, /TownJobs/);
});

test('dataset summary keeps staff and admin field-approval permissions unchanged', async () => {
  const staff = await createDatasetPage();
  assert.equal(staff.nodes.get('curation-panel').hidden, true);
  assert.equal(staff.nodes.get('toggle-active').hidden, true);
  assert.ok(!staff.requests.some((path) => path.endsWith('/curation')));

  const data = recordOverview();
  data.dataset.isActive = false;
  const admin = await createDatasetPage({ role: 'admin', data });
  assert.equal(admin.nodes.get('curation-panel').hidden, false);
  assert.equal(admin.nodes.get('field-metadata').hidden, true);
  assert.equal(admin.nodes.get('toggle-active').hidden, false);
  assert.equal(admin.nodes.get('make-report').hidden, true);
  assert.equal(admin.nodes.get('data-preview').children[0].children[2].children.length, 2);
});
