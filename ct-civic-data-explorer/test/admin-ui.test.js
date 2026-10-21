import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { defaultDatasetQuery, datasetFilterChoices, filterAndSortDatasets } from '../public/js/admin-datasets.js';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
  }
  append(...children) {
    for (const child of children) {
      if (child instanceof Element) child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(event, handler) { this.listeners[event] = handler; }
  closest(selector) { return this.tagName === selector ? this : this.parentElement?.closest(selector); }
  querySelector(selector) {
    const tagName = selector.startsWith('.') ? null : selector.split('[')[0];
    return this.children.find((child) => child instanceof Element && (
      tagName ? child.tagName === tagName : child.className === selector.slice(1)
    ));
  }
  focus() { this.ownerDocument.activeElement = this; }
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : String(child)).join(''); }
  set textContent(value) { this.children = [value]; }
  async dispatch(event) {
    await this.listeners[event]?.({ target: this, currentTarget: this, preventDefault() {} });
  }
}

const rows = [
  { id: 1, name: 'Employment', source: 'Labor', vintage: '2024', version: 2, rowCount: 90, uploadedAt: '2026-02-01T12:00:00Z', isActive: true, curationReviewed: true, approvedFields: ['jobs'] },
  { id: 2, name: 'Housing', source: 'Census', vintage: '2025', version: 10, rowCount: 200, uploadedAt: '2026-01-20T12:00:00Z', isActive: false, curationReviewed: false, approvedFields: [] },
  { id: 3, name: 'Housing', source: 'Census', vintage: '2024', version: 9, rowCount: 80, uploadedAt: '2025-12-10T12:00:00Z', isActive: false, curationReviewed: true, approvedFields: ['homes'] },
];

async function createPage() {
  const nodes = new Map();
  const filterIds = ['dataset-search', 'dataset-period', 'dataset-publication', 'dataset-review'];
  const ids = [
    ...filterIds, 'add-dataset', 'back-to-datasets', 'datasets-panel', 'upload-panel', 'dataset-filters',
    'reset-dataset-filters', 'dataset-count', 'datasets-body', 'ds-file', 'upload-form', 'upload-details',
    'worksheet-field', 'ds-worksheet', 'ds-name', 'ds-source', 'ds-vintage', 'upload-status', 'upload-errors',
  ];
  const sortButtons = [];
  const document = {
    getElementById: (id) => nodes.get(id),
    querySelectorAll: (selector) => selector === '[data-sort]' ? sortButtons
      : [...filterIds.map((id) => nodes.get(id)), ...sortButtons],
  };
  for (const id of ids) {
    const element = new Element();
    element.ownerDocument = document;
    nodes.set(id, element);
  }
  nodes.get('upload-panel').hidden = true;
  nodes.get('upload-details').hidden = true;
  nodes.get('ds-file').files = [];
  nodes.get('dataset-filters').reset = () => {
    for (const id of filterIds) nodes.get(id).value = '';
  };
  for (const key of ['name', 'vintage', 'version', 'rowCount', 'uploadedAt', 'publication', 'review']) {
    const heading = new Element('th');
    const button = new Element('button');
    const indicator = new Element('span');
    indicator.className = 'sort-indicator';
    button.dataset.sort = key;
    button.append(indicator);
    heading.append(button);
    sortButtons.push(button);
  }
  const createElement = (tagName, props = {}, ...children) => {
    const element = new Element(tagName);
    element.ownerDocument = document;
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'class') element.className = value;
      else element[key] = value;
    }
    element.append(...children);
    return element;
  };
  const context = vm.createContext({
    document, createElement, defaultDatasetQuery, datasetFilterChoices, filterAndSortDatasets,
    loadSession: async () => ({ user: { role: 'admin' } }),
    api: async () => structuredClone(rows),
    renderHeader() {}, formatDate: (value) => value,
    showStatus(element, message) { element.textContent = message; element.hidden = !message; },
    boot(initialize) { context.ready = initialize(); },
  });
  const source = (await readFile(new URL('../public/js/admin.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  await context.ready;
  const visibleIds = () => nodes.get('datasets-body').children
    .filter((row) => row.className === 'dataset-row')
    .map((row) => Number(row.children[0].children[0].href.split('=')[1]));
  return { nodes, document, sortButtons, visibleIds };
}

test('Add dataset opens its form and Back restores browsing state and focus', async () => {
  const { nodes, document, visibleIds } = await createPage();
  nodes.get('dataset-search').value = 'Housing';
  await nodes.get('dataset-search').dispatch('input');
  assert.deepEqual(visibleIds(), [2, 3]);
  await nodes.get('add-dataset').dispatch('click');
  assert.equal(nodes.get('datasets-panel').hidden, true);
  assert.equal(nodes.get('upload-panel').hidden, false);
  assert.equal(nodes.get('add-dataset').getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, nodes.get('ds-file'));
  nodes.get('ds-name').value = 'Draft upload';
  await nodes.get('back-to-datasets').dispatch('click');
  assert.equal(nodes.get('datasets-panel').hidden, false);
  assert.equal(nodes.get('upload-panel').hidden, true);
  assert.equal(document.activeElement, nodes.get('add-dataset'));
  assert.equal(nodes.get('dataset-search').value, 'Housing');
  assert.equal(nodes.get('ds-name').value, 'Draft upload');
  assert.deepEqual(visibleIds(), [2, 3]);
});

test('table controls combine, announce counts, reset no matches, and toggle accessible sorting', async () => {
  const { nodes, document, sortButtons, visibleIds } = await createPage();
  assert.deepEqual(visibleIds(), [1, 2, 3]);
  assert.equal(nodes.get('dataset-count').textContent, '3 of 3 datasets');
  assert.deepEqual(nodes.get('dataset-period').children.map((choice) => choice.value), ['', '2024', '2025']);
  assert.equal(nodes.get('reset-dataset-filters').disabled, true);
  for (const [id, value] of [['dataset-search', 'Census'], ['dataset-period', '2024'], ['dataset-publication', 'unpublished'], ['dataset-review', 'reviewed']]) {
    nodes.get(id).value = value;
    await nodes.get(id).dispatch(id === 'dataset-search' ? 'input' : 'change');
  }
  assert.deepEqual(visibleIds(), [3]);
  assert.equal(nodes.get('dataset-count').textContent, '1 of 3 datasets');
  nodes.get('dataset-review').value = 'needs-review';
  await nodes.get('dataset-review').dispatch('change');
  assert.deepEqual(visibleIds(), []);
  assert.equal(nodes.get('dataset-count').textContent, '0 of 3 datasets');
  assert.match(nodes.get('datasets-body').textContent, /No matching datasets/);
  const resetInEmptyState = nodes.get('datasets-body').children[0].children[0].children.find((child) => child instanceof Element);
  await resetInEmptyState.dispatch('click');
  assert.deepEqual(visibleIds(), [1, 2, 3]);
  assert.equal(document.activeElement, nodes.get('dataset-search'));
  assert.equal(nodes.get('reset-dataset-filters').disabled, true);
  const version = sortButtons.find((button) => button.dataset.sort === 'version');
  await version.dispatch('click');
  assert.deepEqual(visibleIds(), [1, 3, 2]);
  assert.equal(version.closest('th').getAttribute('aria-sort'), 'ascending');
  await version.dispatch('click');
  assert.deepEqual(visibleIds(), [2, 3, 1]);
  assert.equal(version.closest('th').getAttribute('aria-sort'), 'descending');
  assert.equal(sortButtons.filter((button) => button.closest('th').getAttribute('aria-sort') !== 'none').length, 1);
});

test('admin markup exposes Add dataset as an ordinary button with a separate upload form', async () => {
  const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(html, /<button type="button" id="add-dataset"[^>]*>Add dataset<\/button>/);
  assert.match(html, /<section[^>]*id="upload-panel"[^>]*hidden>/);
  assert.match(html, /id="back-to-datasets"[^>]*>Back to datasets<\/button>/);
  assert.match(html, /name="activate" value="false"/);
});
