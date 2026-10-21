import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeTabs, revealTab } from '../public/js/tabs.js';

class Element {
  constructor(document, attributes = {}) {
    this.ownerDocument = document;
    this.attributes = attributes;
    this.id = attributes.id;
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    if (this.id) document.nodes.set(this.id, this);
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  matches(selector) {
    if (selector === '[data-tabs]') return 'data-tabs' in this.attributes;
    if (selector === '[role="tab"]') return this.attributes.role === 'tab';
    if (selector === '[role="tabpanel"]') return this.attributes.role === 'tabpanel';
    return false;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  contains(child) { return child === this || this.children.some((node) => node.contains(child)); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  dispatchEvent(event) {
    for (const callback of this.listeners.get(event.type) ?? []) callback(event);
  }
  focus() { this.ownerDocument.activeElement = this; }
}

function workspace(document, name, count = 3) {
  const root = new Element(document, { 'data-tabs': name });
  const list = new Element(document, { role: 'tablist' });
  const tabs = [];
  const panels = [];
  root.append(list);
  for (let index = 0; index < count; index++) {
    const tab = new Element(document, {
      id: `${name}-tab-${index}`, role: 'tab', 'aria-controls': `${name}-panel-${index}`,
      'aria-selected': index === 0 ? 'true' : 'false',
    });
    const panel = new Element(document, {
      id: `${name}-panel-${index}`, role: 'tabpanel', 'aria-labelledby': tab.id,
    });
    list.append(tab);
    root.append(panel);
    tabs.push(tab);
    panels.push(panel);
  }
  return { root, tabs, panels };
}

function createDocument() {
  return { nodes: new Map(), getElementById(id) { return this.nodes.get(id) ?? null; } };
}

test('task tabs keep one panel visible and one tab in the keyboard sequence', () => {
  const { root, tabs, panels } = workspace(createDocument(), 'builder');
  initializeTabs(root);
  assert.deepEqual(panels.map((panel) => panel.hidden), [false, true, true]);
  tabs[1].dispatchEvent({ type: 'click' });
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, false, true]);
  assert.deepEqual(tabs.map((tab) => tab.tabIndex), [-1, 0, -1]);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
});

test('arrow, Home and End navigation skip unavailable tasks and retain keyboard focus', () => {
  const document = createDocument();
  const { root, tabs } = workspace(document, 'dataset', 5);
  tabs[1].hidden = true;
  tabs[3].disabled = true;
  initializeTabs(root);
  const press = (tab, key) => {
    let prevented = false;
    tab.dispatchEvent({ type: 'keydown', key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  };
  press(tabs[0], 'ArrowRight');
  assert.equal(document.activeElement, tabs[2]);
  press(tabs[2], 'End');
  assert.equal(document.activeElement, tabs[4]);
  press(tabs[4], 'ArrowRight');
  assert.equal(document.activeElement, tabs[0]);
  press(tabs[0], 'ArrowLeft');
  assert.equal(document.activeElement, tabs[4]);
  press(tabs[4], 'Home');
  assert.equal(document.activeElement, tabs[0]);
});

test('errors and validation reveal nested tasks without resetting other selected tabs', () => {
  const document = createDocument();
  const outer = workspace(document, 'dataset');
  const inner = workspace(document, 'appearance');
  const input = new Element(document);
  inner.panels[2].append(input);
  outer.panels[1].append(inner.root);
  initializeTabs(outer.root);
  outer.root.dispatchEvent({ type: 'invalid', target: input });
  assert.equal(outer.panels[1].hidden, false);
  assert.equal(inner.panels[2].hidden, false);
  initializeTabs(outer.root);
  assert.equal(inner.panels[2].hidden, false);
  revealTab(input);
  assert.equal(outer.tabs[1].getAttribute('aria-selected'), 'true');
});

test('hiding the selected task recovers to an available task without duplicate listeners', () => {
  const { root, tabs, panels } = workspace(createDocument(), 'explore');
  initializeTabs(root);
  initializeTabs(root);
  assert.equal(tabs[1].listeners.get('click').length, 1);
  tabs[1].dispatchEvent({ type: 'click' });
  tabs[1].hidden = true;
  initializeTabs(root);
  assert.equal(panels[0].hidden, false);
  assert.equal(panels[1].hidden, true);
});

test('a task action recovers focus when it hides itself, while background reveals leave focus alone', () => {
  const document = createDocument();
  const { root, tabs, panels } = workspace(document, 'explore');
  const button = new Element(document);
  panels[0].append(button);
  initializeTabs(root);
  button.focus();
  revealTab(panels[1]);
  assert.equal(document.activeElement, tabs[1]);
  const outside = new Element(document);
  outside.focus();
  revealTab(panels[2]);
  assert.equal(document.activeElement, outside);
});
