import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { fieldUnitLabel, fieldValueLabel, groupFieldsByUnit } from '../src/shared/field-groups.js';

class Element {
  constructor(tagName, nodes, parent = null) {
    this.tagName = tagName;
    this.nodes = nodes;
    this.parentElement = parent;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
  }
  set id(value) { this.identifier = value; this.nodes.set(value, this); }
  get id() { return this.identifier; }
  append(...children) {
    for (const child of children) if (child instanceof Element) child.parentElement = this;
    this.children.push(...children);
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
  }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  closest(selector) {
    if (selector === '[data-no-preview]') {
      if (this.noPreview) return this;
      return this.parentElement?.closest(selector) ?? null;
    }
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => child instanceof Element
      ? [...(selector === '[data-column]' && child.dataset.column ? [child] : []), ...child.querySelectorAll(selector)] : []);
  }
  focus() { this.nodes.focusedId = this.id; }
  get childElementCount() { return this.children.filter((child) => child instanceof Element).length; }
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : child).join(''); }
  set textContent(value) { this.children = [value]; }
  dispatch(type) {
    const pending = [];
    const event = { target: this, currentTarget: this, preventDefault() {} };
    const callback = this[`on${type[0].toUpperCase()}${type.slice(1)}`];
    if (callback) pending.push(callback(event));
    for (let element = this; element; element = element.parentElement) {
      event.currentTarget = element;
      if (element.listeners[type]) pending.push(element.listeners[type](event));
    }
    return Promise.all(pending);
  }
}

const datasets = [
  { id: 1, name: 'Employment', displayName: 'Employment records', vintage: '2026', isActive: true },
  { id: 2, name: 'Categories', displayName: 'Category records', vintage: '2026', isActive: true },
];
const originalFields = [
  { key: 'c0', label: 'Jobs', displayLabel: 'Jobs', type: 'number', unit: 'count', decimals: 0 },
  { key: 'c1', label: 'Revenue', displayLabel: 'Revenue', type: 'number', unit: 'currency', decimals: 2 },
];
const replacementFields = [
  { key: 'c0', label: 'Category', displayLabel: 'Category', type: 'text', unit: 'number' },
  { key: 'c1', label: 'Value', displayLabel: 'Value', type: 'number', unit: 'count', decimals: 0 },
];
const options = (columns) => ({
  columns, filters: [{ ...columns[0], values: ['10', '20'], freeText: false }],
  places: [], hasState: false, dataFormat: 'records', defaultChartType: 'grouped_bar',
});
const draftSelection = () => ({
  dataset: { name: 'Employment', vintage: '2026' }, towns: [], benchmark: false,
  indicators: ['c0', 'c1'], showTitle: true, title: '', subtitle: '', recordFilters: { c0: '10' },
  layout: [{ type: 'chart', chartType: 'grouped_bar', indicators: ['c0'], axisField: '', seriesField: '', aggregation: 'none' }, { type: 'table', indicators: [] }],
});

async function createBuilder({ loadOptions, preview, selection = draftSelection } = {}) {
  const html = await readFile(new URL('../public/builder.html', import.meta.url), 'utf8');
  const nodes = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    const element = new Element('div', nodes);
    element.id = match[1];
  }
  const form = nodes.get('builder-form');
  for (const node of nodes.values()) if (node !== form) node.parentElement = form;
  const requests = [];
  const snapshots = [];
  const revealed = [];
  let saved;
  const context = vm.createContext({
    URLSearchParams,
    document: { getElementById: (id) => nodes.get(id) ?? null, querySelectorAll: () => [] },
    location: { search: '?dataset=1&from=explore' },
    history: { replaceState() {} },
    sessionStorage: { getItem: () => JSON.stringify(selection()) },
    api: async (path, request) => {
      const json = request?.json && JSON.parse(JSON.stringify(request.json));
      requests.push({ path, method: request?.method, json });
      if (path === '/datasets') return datasets;
      if (path.endsWith('/report-options')) {
        const id = Number(path.split('/')[2]);
        return loadOptions ? loadOptions(id) : options(id === 1 ? originalFields : replacementFields);
      }
      if (path === '/reports/preview') {
        if (preview) return preview(json);
        const dataset = datasets.find((item) => item.name === json.dataset.name);
        const columns = dataset.id === 1 ? originalFields : replacementFields;
        return { title: `${dataset.displayName}: ${columns.filter((field) => json.indicators.includes(field.key)).map((field) => field.label).join(' · ')}`, blocks: [] };
      }
      if (path === '/reports' && request.method === 'POST') {
        saved = { id: 12, title: json.title, selection: json.selection, createdBy: { id: 1 } };
        return saved;
      }
      throw new Error(`Unexpected request: ${path}`);
    },
    loadSession: async () => ({ user: { id: 1 }, features: { aiSummary: false } }),
    renderHeader() {}, boot() {},
    initializeTabs() {}, revealTab: (element) => revealed.push(element.id),
    mountReportStyleEditor: () => ({ set() {} }),
    debounce: (callback) => callback,
    clearReport: (element) => element.replaceChildren(),
    renderReport: (_, report) => { snapshots.push(report); },
    showStatus: (element, message) => { element.textContent = message; },
    createElement: (tagName, properties = {}, ...children) => {
      const element = new Element(tagName, nodes);
      for (const [key, value] of Object.entries(properties)) {
        if (key.startsWith('data-')) element.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
        else element[key] = value;
      }
      element.append(...children);
      return element;
    },
    fieldUnitLabel, fieldValueLabel, groupFieldsByUnit,
  });
  const source = (await readFile(new URL('../public/js/builder.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  await vm.runInContext('initializeBuilder()', context);
  return { nodes, requests, snapshots, revealed, run: (code) => vm.runInContext(code, context), get saved() { return saved; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

test('changing datasets clears old exact filters before the change bubbles through the form', async () => {
  const replacement = deferred();
  const { nodes, requests } = await createBuilder({ loadOptions: (id) => id === 1 ? options(originalFields) : replacement.promise });
  assert.equal(nodes.get('filter-c0').value, '10');
  const dataset = nodes.get('dataset');
  dataset.value = '1';
  const switching = dataset.dispatch('change');
  assert.equal(nodes.get('record-filter-panel').disabled, true);
  assert.equal(nodes.get('save').disabled, true);
  replacement.resolve(options(replacementFields));
  await switching;
  const request = requests.filter(({ path }) => path === '/reports/preview').at(-1);
  assert.equal(request.json.dataset.name, 'Categories');
  assert.deepEqual(request.json.recordFilters, {});
  assert.equal(nodes.get('filter-c0').value, '');
  assert.equal(nodes.get('record-filter-panel').disabled, false);
});

test('a numeric measure that becomes text cannot leave an invisible exclusive chart subset', async () => {
  const { nodes, requests } = await createBuilder();
  nodes.get('dataset').value = '1';
  await nodes.get('dataset').dispatch('change');
  const request = requests.filter(({ path }) => path === '/reports/preview').at(-1);
  assert.deepEqual(request.json.indicators, ['c0', 'c1']);
  assert.deepEqual(request.json.layout[0].indicators, [], 'The chart now uses all selected numeric measures, including Value');
  assert.match(nodes.get('block-0-title').placeholder, /Value/);
  assert.equal(nodes.get('block-0-fields-mode').value, 'all');
  assert.equal(nodes.get('block-0-type').disabled, false);
});

test('switching datasets invalidates an outstanding preview before new field choices load', async () => {
  const replacement = deferred();
  const oldPreview = deferred();
  let previewCount = 0;
  const { nodes, snapshots } = await createBuilder({
    loadOptions: (id) => id === 1 ? options(originalFields) : replacement.promise,
    preview: () => ++previewCount === 1 ? { title: 'Initial preview', blocks: [] }
      : previewCount === 2 ? oldPreview.promise : { title: 'Replacement preview', blocks: [] },
  });
  nodes.get('title').value = 'Edited title';
  await nodes.get('title').dispatch('input');
  assert.equal(previewCount, 2);
  nodes.get('dataset').value = '1';
  const switching = nodes.get('dataset').dispatch('change');
  oldPreview.resolve({ title: 'Outdated dataset preview', blocks: [] });
  await new Promise(setImmediate);
  assert.equal(snapshots.length, 1, 'The old response cannot render during the replacement options request');
  replacement.resolve(options(replacementFields));
  await switching;
  assert.equal(snapshots.at(-1).title, 'Replacement preview');
});

test('a source-record report saves without towns or a manually entered name and preserves chart settings', async () => {
  const builder = await createBuilder();
  const { nodes, requests } = builder;
  assert.equal(nodes.get('location-selection').hidden, true);
  assert.equal(nodes.get('benchmark-control').hidden, true);
  assert.match(nodes.get('title').placeholder, /Employment records.*Jobs.*Revenue/);
  nodes.get('block-0-axisField').value = 'c1';
  await nodes.get('block-0-axisField').dispatch('change');
  nodes.get('block-0-seriesField').value = 'c0';
  await nodes.get('block-0-seriesField').dispatch('change');
  nodes.get('block-0-aggregation').value = 'average';
  await nodes.get('block-0-aggregation').dispatch('change');
  nodes.get('block-0-title').value = 'Employment comparison';
  await nodes.get('block-0-title').dispatch('input');
  await nodes.get('save').dispatch('click');
  const saved = requests.find(({ path, method }) => path === '/reports' && method === 'POST');
  assert.ok(saved, 'A report without town selections can be saved');
  assert.match(saved.json.title, /Employment records.*Jobs.*Revenue/);
  assert.deepEqual(saved.json.selection.towns, []);
  assert.equal(saved.json.selection.layout[0].axisField, 'c1');
  assert.equal(saved.json.selection.layout[0].seriesField, 'c0');
  assert.equal(saved.json.selection.layout[0].aggregation, 'average');
  assert.equal(saved.json.selection.layout[0].title, 'Employment comparison');
  assert.equal(builder.saved.title, saved.json.title);
  assert.equal(nodes.get('builder-heading').textContent, 'Report builder');
});

test('content edits one block at a time and preserves the selected block through reordering', async () => {
  const { nodes, requests, run, revealed } = await createBuilder();
  assert.equal(nodes.get('layout-list').children.length, 1);
  assert.equal(nodes.get('block-picker').children.length, 2);
  nodes.get('block-picker').value = '1';
  await nodes.get('block-picker').dispatch('change');
  assert.equal(nodes.get('layout-list').children.length, 1);
  assert.equal(nodes.get('layout-list').children[0].children[0].children[0].textContent, 'Table 2 of 2');
  assert.equal(nodes.get('block-1-fields-mode').value, 'all');

  run("addBlock('text', { text: 'A note' })");
  assert.equal(nodes.get('block-picker').value, '2');
  assert.equal(nodes.get('block-2-text').value, 'A note');
  assert.equal(revealed.at(-1), 'builder-content-panel');
  await nodes.get('block-2-up').dispatch('click');
  assert.equal(nodes.get('block-picker').value, '1');
  assert.equal(nodes.get('block-1-text').value, 'A note');
  assert.equal(nodes.get('layout-list').children.length, 1);
  await nodes.get('save').dispatch('click');
  const saved = requests.find(({ path, method }) => path === '/reports' && method === 'POST');
  assert.deepEqual(saved.json.selection.layout.map((block) => block.type), ['chart', 'text', 'table']);
  assert.equal(saved.json.selection.layout[1].text, 'A note');
});

test('report titles save alongside chart content through their separate editor', async () => {
  const { nodes, requests } = await createBuilder();
  nodes.get('title').value = 'Employment overview';
  await nodes.get('title').dispatch('input');
  nodes.get('subtitle').value = '2026 source rows';
  await nodes.get('subtitle').dispatch('input');
  nodes.get('show-title').checked = false;
  await nodes.get('show-title').dispatch('change');
  nodes.get('block-0-title').value = 'Jobs by category';
  await nodes.get('block-0-title').dispatch('input');
  await nodes.get('save').dispatch('click');
  const saved = requests.find(({ path, method }) => path === '/reports' && method === 'POST');
  assert.equal(saved.json.title, 'Employment overview');
  assert.equal(saved.json.selection.title, 'Employment overview');
  assert.equal(saved.json.selection.subtitle, '2026 source rows');
  assert.equal(saved.json.selection.showTitle, false);
  assert.equal(saved.json.selection.layout[0].title, 'Jobs by category');
});

test('field modes make all-field defaults explicit and cannot silently reset an empty custom subset', async () => {
  const { nodes, requests } = await createBuilder();
  const mode = nodes.get('block-0-fields-mode');
  mode.value = 'all';
  await mode.dispatch('change');
  assert.equal(nodes.get('block-0-fields-mode').value, 'all');
  assert.equal(nodes.get('block-0-units-note').hidden, false);
  nodes.get('block-0-fields-mode').value = 'custom';
  await nodes.get('block-0-fields-mode').dispatch('change');
  nodes.get('block-0-field-c0').checked = false;
  await nodes.get('block-0-field-c0').dispatch('change');
  assert.equal(nodes.get('block-0-units-note').hidden, true);
  nodes.get('block-0-field-c1').checked = false;
  await nodes.get('block-0-field-c1').dispatch('change');
  assert.equal(nodes.get('block-0-field-c1').checked, true);
  assert.equal(nodes.get('builder-status').textContent, 'Choose at least one field.');
  await nodes.get('save').dispatch('click');
  const saved = requests.find(({ path, method }) => path === '/reports' && method === 'POST');
  assert.deepEqual(saved.json.selection.layout[0].indicators, ['c1']);
});

test('saving an empty selection reveals the Fields tab and focuses its field control', async () => {
  const { nodes, requests, revealed } = await createBuilder({ selection: () => ({ ...draftSelection(), indicators: [] }) });
  await nodes.get('save').dispatch('click');
  assert.equal(requests.some(({ path, method }) => path === '/reports' && method === 'POST'), false);
  assert.equal(revealed.at(-1), 'field-search');
  assert.equal(nodes.focusedId, 'field-search');
  assert.equal(nodes.get('builder-status').textContent, 'Choose report fields.');
});

test('field search leaves selections intact and field customization edits one field at a time', async () => {
  const { nodes, requests } = await createBuilder();
  nodes.get('field-search').value = 'currency';
  await nodes.get('field-search').dispatch('input');
  assert.match(nodes.get('indicator-list').textContent, /Revenue/);
  assert.doesNotMatch(nodes.get('indicator-list').textContent, /Jobs/);
  assert.equal(nodes.get('field-count').textContent, '2 selected');
  assert.equal(nodes.get('field-overrides').children.length, 3);
  nodes.get('override-field-choice').value = 'c1';
  await nodes.get('override-field-choice').dispatch('change');
  nodes.get('override-1-label').value = 'Receipts';
  await nodes.get('override-1-label').dispatch('input');
  await nodes.get('save').dispatch('click');
  const saved = requests.find(({ path, method }) => path === '/reports' && method === 'POST');
  assert.deepEqual(saved.json.selection.indicators, ['c0', 'c1']);
  assert.deepEqual(saved.json.selection.fieldOverrides, { c1: { label: 'Receipts' } });
});
