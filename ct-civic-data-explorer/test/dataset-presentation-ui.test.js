import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { unitLabel } from '../src/shared/format.js';

class Element {
  constructor(tagName, nodes) {
    this.tagName = tagName;
    this.nodes = nodes;
    this.children = [];
    this.listeners = {};
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.classList = { add() {} };
  }
  set id(value) { this.identifier = value; this.nodes.set(value, this); }
  get id() { return this.identifier; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener(event, handler) { this.listeners[event] = handler; }
  focus() {}
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : child).join(''); }
  set textContent(value) { this.children = [value]; }
  async dispatch(event) {
    const handler = this.listeners[event] ?? this[`on${event[0].toUpperCase()}${event.slice(1)}`];
    if (handler) await handler({ currentTarget: this, preventDefault() {} });
  }
}

const fields = Array.from({ length: 80 }, (_, index) => ({
  key: `c${index}`, label: `Field ${index}`, type: index === 1 ? 'text' : 'number',
  unit: index === 1 ? 'text' : 'count', decimals: 0,
}));

async function createEditor({ conflict = false } = {}) {
  const nodes = new Map();
  const requests = [];
  let style = {};
  let saves = 0;
  let savedCalls = 0;
  let response = {
    fields,
    settings: {
      revision: 7, displayName: 'Employment', description: 'Source description',
      defaultChartType: 'grouped_bar', fieldOrder: [], fields: {}, style: {},
    },
  };
  const container = new Element('div', nodes);
  const context = vm.createContext({
    structuredClone, unitLabel,
    initializeTabs() {},
    api: async (path, request) => {
      requests.push({ path, request });
      if (request?.method === 'PUT') {
        saves++;
        if (conflict && saves === 1) throw new Error('Defaults changed. Reload before saving.');
        response = { ...response, settings: { ...structuredClone(request.json), revision: 8 } };
      }
      return structuredClone(response);
    },
    mountReportStyleEditor: () => ({
      set: (value) => { style = structuredClone(value ?? {}); },
      read: () => structuredClone(style),
    }),
    showStatus: (element, message) => { element.textContent = message; element.hidden = !message; },
    h: (tagName, properties = {}, ...children) => {
      const element = new Element(tagName, nodes);
      Object.assign(element, properties);
      element.append(...children);
      return element;
    },
  });
  const source = (await readFile(new URL('../public/js/dataset-presentation.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace('export async function', 'async function');
  vm.runInContext(source, context);
  context.container = container;
  context.saved = () => { savedCalls++; };
  await vm.runInContext('mountDatasetPresentation(container, 5, saved)', context);
  return { nodes, context, requests, container, savedCalls: () => savedCalls };
}

test('shared defaults use one field editor and retain drafts when switching and reordering fields', async () => {
  const { nodes, context, requests, savedCalls } = await createEditor();
  assert.equal(nodes.get('presentation-field').children.length, 80);
  assert.equal(nodes.has('presentation-label-79'), false, 'Field inputs are bounded independently of column count');
  nodes.get('presentation-name').value = 'Jobs';
  nodes.get('presentation-field-name').value = 'Employees';
  nodes.get('presentation-field-description').value = 'People employed';
  nodes.get('presentation-field-decimals').value = '2';

  const picker = nodes.get('presentation-field');
  picker.value = 'c1';
  await picker.dispatch('change');
  assert.equal(nodes.get('presentation-field-decimals').disabled, true);
  nodes.get('presentation-field-name').value = 'Industry';
  await vm.runInContext('moveField(1)', context);
  assert.equal(nodes.get('presentation-name').value, 'Jobs');

  picker.value = 'c0';
  await picker.dispatch('change');
  assert.equal(nodes.get('presentation-field-name').value, 'Employees');
  assert.equal(nodes.get('presentation-field-description').value, 'People employed');
  assert.equal(nodes.get('presentation-field-decimals').value, '2');
  await vm.runInContext('saveDefaults({ preventDefault() {} })', context);
  const payload = JSON.parse(JSON.stringify(requests.find(({ request }) => request?.method === 'PUT').request.json));
  assert.equal(payload.revision, 7);
  assert.equal(payload.displayName, 'Jobs');
  assert.deepEqual(payload.fields.c0, { label: 'Employees', description: 'People employed', decimals: 2 });
  assert.deepEqual(payload.fields.c1, { label: 'Industry' });
  assert.deepEqual(payload.fieldOrder.slice(0, 3), ['c0', 'c2', 'c1']);
  assert.equal(savedCalls(), 1);
});

test('shared-default save conflicts preserve unsaved field edits until reload', async () => {
  const { nodes, context, savedCalls } = await createEditor({ conflict: true });
  nodes.get('presentation-field-name').value = 'Unsaved name';
  await vm.runInContext('saveDefaults({ preventDefault() {} })', context);
  assert.equal(nodes.get('presentation-field-name').value, 'Unsaved name');
  assert.equal(savedCalls(), 0);
  const message = vm.runInContext('status.textContent', context);
  assert.match(message, /Reload before saving/);
  await vm.runInContext('load()', context);
  assert.equal(nodes.get('presentation-field-name').value, '');
});