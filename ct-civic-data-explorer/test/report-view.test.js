import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Exercise the browser renderer's DOM and Chart.js contract without a browser.
class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.isConnected = true;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : child).join(''); }
  set textContent(value) { this.children = [value]; }
}

function elements(root, predicate) {
  return [root, ...root.children.flatMap((child) => child instanceof Element ? elements(child, predicate) : [])]
    .filter(predicate);
}

test('chart pages and accessible tables use the chart axis and values, including aggregated series', async (context) => {
  const chartCalls = [];
  class Chart {
    static defaults = { font: {} };
    constructor(canvas, config) {
      this.canvas = canvas;
      chartCalls.push({ config, instance: this });
    }
    destroy() { this.destroyed = true; }
  }
  for (const [name, value] of Object.entries({
    Node: Element,
    document: { createElement: (tagName) => new Element(tagName) },
    window: { Chart },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  let source = await readFile(new URL('../public/js/report-view.js', import.meta.url), 'utf8');
  source = source.replaceAll("from '/shared/", `from '${new URL('../src/shared/', import.meta.url).href}`)
    .replace("from './dom.js'", `from '${new URL('../public/js/dom.js', import.meta.url).href}'`);
  const { renderReport } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

  const labels = Array.from({ length: 23 }, (_, index) => `Category A (source row ${index + 2})`);
  const values = labels.map((_, index) => index + 100);
  const chart = {
    type: 'line', title: 'Employment by category', unit: 'count', decimals: 0,
    axisField: 'category', axisLabel: 'Category', categoryLabel: 'Rows', aggregation: 'none',
    labels, places: labels.map((label) => ({ label })), benchmarkIndex: -1,
    series: [{ key: 'jobs', label: 'Employment', values }],
  };
  const report = {
    places: [{ label: 'Andover' }, { label: 'Hamden' }],
    indicators: [{ key: 'jobs', label: 'Employment', cells: [{ value: 999, display: 'Wrong source cell' }] }],
    blocks: [{ type: 'chart', chart }], sourceLine: 'Source: test',
  };
  const container = new Element('div');
  renderReport(container, report);
  assert.deepEqual(chartCalls[0].config.data.labels, labels.slice(0, 20));
  assert.deepEqual(chartCalls[0].config.data.datasets[0].data, values.slice(0, 20));
  assert.equal(chartCalls[0].config.options.scales.x.title.text, 'Category');
  assert.ok(container.textContent.includes('Rows 1–20 of 23'));
  assert.ok(!container.textContent.includes('Andover'));
  assert.ok(!container.textContent.includes('Wrong source cell'));
  assert.equal(elements(container, (element) => element.tagName === 'td')[0].textContent, '100');
  const next = elements(container, (element) => element.tagName === 'button' && element.textContent === 'Next')[0];
  next.listeners.click();
  assert.ok(chartCalls[0].instance.destroyed);
  assert.deepEqual(chartCalls[1].config.data.labels, labels.slice(20));
  assert.deepEqual(chartCalls[1].config.data.datasets[0].data, values.slice(20));
  assert.ok(container.textContent.includes('Rows 21–23 of 23'));
  assert.deepEqual(elements(container, (element) => element.tagName === 'td').map((cell) => cell.textContent), ['120', '121', '122']);

  const aggregate = {
    ...chart, type: 'grouped_bar', title: 'Total pay by category', unit: 'currency', decimals: 0,
    labels: ['Services'], places: [{ label: 'Services' }], categoryLabel: 'Categories', aggregation: 'sum',
    series: [
      { key: 'pay:a', label: 'Pay — A', values: [234] },
      { key: 'pay:b', label: 'Pay — B', values: [567] },
    ],
  };
  renderReport(container, { ...report, blocks: [{ type: 'chart', chart: aggregate }] });
  assert.deepEqual(elements(container, (element) => element.tagName === 'td').map((cell) => cell.textContent), ['$234', '$567']);
  assert.equal(chartCalls.at(-1).config.options.scales.y.title.text, 'US dollars');
  assert.ok(container.textContent.includes('Pay — A'));
  assert.ok(container.textContent.includes('Pay — B'));
  assert.ok(!container.textContent.includes('Employment'));
});
