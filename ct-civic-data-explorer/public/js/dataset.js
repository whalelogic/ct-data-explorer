import { api, loadSession } from './api.js';
import { h } from './dom.js';
import { mountIndicatorEditor } from './indicator-editor.js';
import { boot, formatDate, renderHeader, showStatus } from './layout.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 25;

boot(async () => {
  const { user } = await loadSession();
  renderHeader(user);
  const id = new URLSearchParams(location.search).get('id');
  if (!id || !/^[1-9]\d*$/.test(id)) throw new Error('Choose a dataset from the dataset table.');
  const admin = user.role === 'admin';
  $('back-link').href = admin ? '/admin.html' : '/';
  let current;
  let offset = 0;

  async function load(nextOffset = offset) {
    $('dataset-content').setAttribute('aria-busy', 'true');
    $('previous').disabled = $('next').disabled = true;
    $('retry').hidden = true;
    try {
      const overview = await api(`/datasets/${id}?offset=${nextOffset}&limit=${PAGE_SIZE}`);
      current = overview;
      offset = nextOffset;
      render(overview);
      showStatus($('page-status'), '');
      $('dataset-content').hidden = false;
    } catch (err) {
      showStatus($('page-status'), err.message, 'error');
      $('retry').hidden = false;
    } finally {
      $('dataset-content').setAttribute('aria-busy', 'false');
    }
  }

  function render({ dataset, indicators, preview }) {
    document.title = `${dataset.name} · Dataset overview`;
    $('dataset-heading').textContent = dataset.name;
    const metadata = [
      ['Source', dataset.source], ['Year or period', dataset.vintage], ['Version', dataset.version],
      ['Uploaded rows', dataset.rowCount.toLocaleString('en-US')], ['Uploaded by', dataset.uploadedBy],
      ['Uploaded', formatDate(dataset.uploadedAt)], ['Status', dataset.isActive ? 'Active' : 'Inactive'],
    ];
    $('dataset-metadata').replaceChildren(...metadata.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)]));
    for (const note of dataset.importNotes) $('dataset-metadata').append(h('dt', {}, 'Import note'), h('dd', {}, note));
    $('make-report').hidden = !dataset.isActive;
    $('make-report').href = `/builder.html?dataset=${dataset.id}`;
    $('toggle-active').hidden = !admin;
    $('toggle-active').textContent = dataset.isActive ? 'Deactivate version' : 'Activate version';
    $('indicators-body').replaceChildren(...indicators.map((indicator) => h('tr', {},
      h('th', { scope: 'row' }, h('code', {}, indicator.key)), h('td', {}, indicator.label),
      h('td', {}, indicator.type === 'text' ? 'Text' : indicator.unit), h('td', {}, indicator.type === 'text' ? '—' : indicator.decimals),
      h('td', {}, indicator.derivation === 'ratio' ? `${indicator.numeratorKey} ÷ ${indicator.denominatorKey}` : indicator.type === 'text' ? 'Category / text' : 'Uploaded column'))));
    if (!indicators.length) $('indicators-body').append(h('tr', {}, h('td', { colspan: 5 }, 'No stored indicator values.')));

    const tabular = dataset.dataFormat === 'records';
    $('indicators-heading').textContent = tabular ? 'Dataset columns' : 'Dataset indicators';
    const table = h('table', { class: 'data' },
      h('caption', { class: 'sr-only' }, `${dataset.name}, ${dataset.vintage}, version ${dataset.version}`),
      h('thead', {}, h('tr', {}, ...(tabular ? [h('th', { scope: 'col' }, 'Source row'), ...preview.columns.map((column) => h('th', { scope: 'col' }, column.label))]
        : [h('th', { scope: 'col' }, 'Town'), ...indicators.map((indicator) =>
          h('th', { scope: 'col', class: 'num' }, `${indicator.displayLabel}${indicator.derivation === 'ratio' ? ' (computed)' : ''}`))]))),
      h('tbody', {}, ...preview.rows.map((row) => h('tr', {}, h('th', { scope: 'row' }, tabular ? row.sourceRow : row.place.label),
        ...row.cells.map((cell, index) => h('td', { class: !tabular || preview.columns[index].type === 'number' ? 'num' : null }, cell.display))))));
    $('data-preview').replaceChildren(table);
    $('preview-summary').textContent = preview.total
      ? `Rows ${preview.rows.length ? offset + 1 : 0}–${offset + preview.rows.length} of ${preview.total} ${tabular ? 'source records' : 'places with stored values'}. Unavailable values are shown as N/A.`
      : 'This dataset has no stored values to preview.';
    $('previous').disabled = offset === 0;
    $('next').disabled = offset + preview.rows.length >= preview.total;
  }

  $('previous').addEventListener('click', () => load(Math.max(0, offset - PAGE_SIZE)));
  $('next').addEventListener('click', () => load(offset + PAGE_SIZE));
  $('retry').addEventListener('click', () => load());
  $('toggle-active').addEventListener('click', async () => {
    $('toggle-active').disabled = true;
    try {
      const dataset = await api(`/datasets/${id}`, { method: 'PATCH', json: { isActive: !current.dataset.isActive } });
      await load();
      showStatus($('dataset-status'), dataset.isActive ? 'This version is now available for reports.' : 'This version has been deactivated.', 'ok');
    } catch (err) {
      showStatus($('dataset-status'), err.message, 'error');
    } finally {
      $('toggle-active').disabled = false;
    }
  });
  if (admin) {
    $('indicator-setup').hidden = false;
    mountIndicatorEditor($('dataset-indicator-editor'), 'dataset-indicator', () => load());
  }
  await load();
});
