import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { fieldUnitLabel, fieldValueLabel } from '../src/shared/field-groups.js';
import { unitLabel } from '../src/shared/format.js';

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.hidden = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelectorAll() { return []; }
  get options() { return this.children; }
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : child).join(''); }
  set textContent(value) { this.children = [value]; }
}

async function createExplorer(options, search = '?dataset=1&field=category&field=jobs&filter.category=Category+251') {
  const html = await readFile(new URL('../public/explore.html', import.meta.url), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element('div')]));
  nodes.get('chart-type').children = ['grouped_bar', 'bar', 'line', 'table'].map((value) => ({ value }));
  const requests = [];
  const stored = new Map();
  const columns = [
    { key: 'category', label: 'Category', displayLabel: 'Industry', type: 'text', unit: 'text' },
    { key: 'jobs', label: 'Jobs', displayLabel: 'Employment', type: 'number', unit: 'count' },
  ];
  const dataset = { id: 1, name: 'Source records', displayName: 'Employment records', source: 'Test', vintage: '2026', version: 1, isActive: true };
  const context = vm.createContext({
    URLSearchParams,
    document: { getElementById: (id) => {
      assert.ok(nodes.has(id), `Explore references a real element: ${id}`);
      return nodes.get(id);
    }, body: { classList: { contains: () => false } } },
    location: { search, pathname: '/explore', assign: (url) => stored.set('destination', url) },
    history: { replaceState() {} },
    sessionStorage: { setItem: (key, value) => stored.set(key, value) },
    api: async (path, request) => {
      requests.push({ path, request });
      if (path === '/datasets') return [dataset];
      if (path.endsWith('/report-options')) return {
        columns, filters: [{ ...columns[0], values: [], freeText: true }], places: [],
        hasState: false, dataFormat: 'records', curationReviewed: true, ...options,
      };
      if (path === '/reports/preview') return { blocks: [] };
      throw new Error(`Unexpected request: ${path}`);
    },
    loadSession: async () => ({ user: { id: 1 } }),
    renderHeader() {}, boot() {},
    revealTab: (element) => {
      stored.set('activeTab', element);
      for (const id of ['explore-fields', 'explore-filters', 'explore-view']) {
        nodes.get(id).hidden = nodes.get(id) !== element;
      }
    },
    debounce: (callback) => callback,
    clearReport: (element) => element.replaceChildren(),
    renderReport() {},
    showStatus: (element, message) => { element.textContent = message; },
    createElement: (tagName, properties = {}, ...children) => {
      const element = new Element(tagName);
      Object.assign(element, properties);
      element.append(...children);
      return element;
    },
    fieldUnitLabel, fieldValueLabel, unitLabel,
  });
  const source = (await readFile(new URL('../public/js/explore.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  await vm.runInContext('initializeExplorer()', context);
  await new Promise(setImmediate);
  return { context, nodes, requests, stored };
}

test('Explore previews approved record fields without towns and transfers exact filters to the builder', async () => {
  const { context, nodes, requests, stored } = await createExplorer();
  const preview = requests.find(({ path }) => path === '/reports/preview');
  assert.ok(preview, 'A dataset without towns can be previewed');
  assert.deepEqual(Array.from(preview.request.json.towns), []);
  assert.equal(preview.request.json.recordFilters.category, 'Category 251');
  assert.equal(preview.request.json.benchmark, false);
  assert.equal(nodes.get('location-controls').hidden, true);
  assert.equal(nodes.get('benchmark-control').hidden, true);
  assert.match(nodes.get('field-list').textContent, /Industry.*Text/);
  assert.match(nodes.get('field-list').textContent, /Employment.*Number · Count/);
  assert.equal(nodes.get('record-filters').children[0].children[1].tagName, 'input');
  assert.equal(nodes.get('record-filters').children[0].children[1].value, 'Category 251');
  assert.match(nodes.get('selection-summary').textContent, /All source rows/);
  assert.equal(nodes.get('open-builder').disabled, false);
  assert.equal(nodes.get('show-view').disabled, false);
  assert.equal(stored.get('activeTab'), nodes.get('explore-view'), 'Linked views open on their data');
  vm.runInContext('openBuilder()', context);
  const selection = JSON.parse(stored.get('ctdata:explore-selection'));
  assert.deepEqual(selection.towns, []);
  assert.deepEqual(selection.indicators, ['category', 'jobs']);
  assert.equal(selection.recordFilters.category, 'Category 251');
  assert.equal(stored.get('destination'), '/builder?from=explore&dataset=1');
});

test('Explore keeps geographic controls when applicable and permits all rows without selecting towns', async () => {
  const { nodes, requests } = await createExplorer({
    dataFormat: 'indicators', places: [{ name: 'Hartford', geoType: 'town' }, { name: 'Connecticut', geoType: 'state' }], hasState: true,
  });
  assert.equal(nodes.get('location-controls').hidden, false);
  assert.equal(nodes.get('town-controls').hidden, false);
  assert.equal(nodes.get('benchmark-control').hidden, false);
  assert.equal(nodes.get('explore-filters-tab').hidden, false);
  assert.ok(requests.some(({ path }) => path === '/reports/preview'));
  assert.equal(nodes.get('export-pdf').disabled, false);
});

test('Explore hides inapplicable filters and uses a single fields-to-view action', async () => {
  const { context, nodes, stored } = await createExplorer({ filters: [] }, '?dataset=1');
  assert.equal(nodes.get('explore-filters-tab').hidden, true);
  assert.equal(nodes.get('show-view').disabled, true);
  assert.equal(nodes.get('open-builder').disabled, true);
  assert.match(nodes.get('explorer-empty').textContent, /No fields selected.*Choose fields/);
  nodes.get('choose-fields').listeners.click();
  assert.equal(stored.get('activeTab'), nodes.get('explore-fields'));
  vm.runInContext("selectedFieldKeys = ['jobs']; handleSelectionChange()", context);
  await new Promise(setImmediate);
  assert.equal(nodes.get('show-view').disabled, false);
  nodes.get('show-view').listeners.click();
  assert.equal(stored.get('activeTab'), nodes.get('explore-view'));
  assert.equal(nodes.get('explore-fields').hidden, true);
  assert.equal(nodes.get('chart-help').hidden, true, 'Routine chart instructions stay out of the workspace');
});

test('Explore groups controls into accessible tabs and keeps exports before the workspace', async () => {
  const html = await readFile(new URL('../public/explore.html', import.meta.url), 'utf8');
  for (const name of ['fields', 'filters', 'view']) {
    assert.match(html, new RegExp(`id="explore-${name}-tab"[^>]+role="tab"[^>]+aria-controls="explore-${name}"`));
    assert.match(html, new RegExp(`id="explore-${name}"[^>]+role="tabpanel"[^>]+aria-labelledby="explore-${name}-tab"`));
  }
  assert.ok(html.indexOf('id="share-view"') < html.indexOf('id="explorer-form"'));
  assert.ok(html.indexOf('id="export-pdf"') < html.indexOf('id="explorer-form"'));
  assert.ok(html.indexOf('id="action-status"') < html.indexOf('id="explorer-form"'), 'Action feedback stays next to the top toolbar');
  assert.ok(html.indexOf('id="share-fallback"') < html.indexOf('id="explorer-form"'), 'The manual copy link stays next to its action');
  assert.doesNotMatch(html, /explorer-steps|explorer-layout|explorer-footer/);
});
