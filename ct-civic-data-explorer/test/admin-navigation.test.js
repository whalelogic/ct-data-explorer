import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function renderNavigation(pathname, role) {
  function element(tag, props = {}, ...children) {
    return {
      tag, props, children: children.flat(),
      append(...items) { this.children.push(...items); },
      prepend(...items) { this.children.unshift(...items); },
      replaceChildren(...items) { this.children = items; },
      querySelector(selector) { return this.children.find((child) => selector === '.brand' && child.props?.class === 'brand'); },
    };
  }
  const header = element('header', {}, element('a', { class: 'brand' }));
  const main = element('main');
  const context = vm.createContext({
    createElement: element, location: { pathname },
    document: { querySelector: (selector) => selector === 'main' ? main : header },
  });
  const source = (await readFile(new URL('../public/js/layout.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  context.user = { role, firstName: 'Test', lastName: 'User' };
  vm.runInContext('renderHeader(user)', context);
  return { header, main };
}

test('administrators get dedicated Data management and Manage users destinations', async () => {
  for (const pathname of ['/admin', '/dataset', '/users']) {
    const { header, main } = await renderNavigation(pathname, 'admin');
    const primary = header.children.find((child) => child.props?.['aria-label'] === 'Main');
    assert.equal(primary.children.at(-1).props.href, '/admin');
    assert.equal(primary.children.at(-1).props['aria-current'], 'page');
    const admin = main.children[0];
    assert.equal(admin.props['aria-label'], 'Administration');
    assert.deepEqual(admin.children.map((link) => link.children[0]), ['Data management', 'Manage users']);
    assert.deepEqual(admin.children.map((link) => link.props.href), ['/admin', '/users']);
    const selected = admin.children.find((link) => link.props['aria-current'] === 'page');
    assert.equal(selected.props.href, pathname === '/users' ? '/users' : '/admin');
  }
});

test('staff do not receive administration links or controls', async () => {
  const { header, main } = await renderNavigation('/dataset', 'staff');
  const primary = header.children.find((child) => child.props?.['aria-label'] === 'Main');
  assert.deepEqual(primary.children.map((link) => link.props.href), ['/', '/explore', '/builder']);
  assert.equal(main.children.length, 0);
});

test('administrators retain a concise entry point outside the administration workspace', async () => {
  const { header, main } = await renderNavigation('/', 'admin');
  const primary = header.children.find((child) => child.props?.['aria-label'] === 'Main');
  assert.equal(primary.children.at(-1).children[0], 'Admin');
  assert.equal(main.children.length, 0);
});
