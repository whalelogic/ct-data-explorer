import { api, loadSession } from './api.js';
import { h } from './dom.js';
import { boot, renderAdminNav, renderHeader, showStatus } from './layout.js';

const ACTIVITY = {
  view: 'Dataset views',
  access: 'Dataset accesses',
  ai_analysis: 'AI analyses',
  report_preview: 'Report previews',
  report_created: 'Reports created',
  report_updated: 'Reports updated',
  report_view: 'Reports viewed',
  report_export: 'PDF exports',
  report_summary: 'AI summaries',
};
const number = new Intl.NumberFormat('en-US');

function datasetLink(dataset) {
  return h('a', { href: `/dataset?id=${dataset.id}` }, `${dataset.name} (${dataset.vintage}, v${dataset.version})`);
}

function heading(text) {
  return h('th', { scope: 'row' }, text);
}

function countCell(count) {
  return h('td', { class: 'num' }, number.format(count));
}

function renderRows(id, rows, columns) {
  const empty = h('tr', {}, h('td', { colspan: columns, class: 'muted' }, 'No activity yet'));
  document.getElementById(id).replaceChildren(...(rows.length ? rows : [empty]));
}

boot(async () => {
  const { user } = await loadSession();
  if (user.role !== 'admin') {
    location.assign('/');
    return;
  }
  renderHeader(user);
  renderAdminNav(document.getElementById('admin-nav'));

  const { activity, datasets, indicators } = await api('/admin/usage');
  renderRows('usage-activity', Object.entries(ACTIVITY).map(([event, label]) =>
    h('tr', {}, heading(label), countCell(activity[event] ?? 0))), 2);
  renderRows('usage-datasets', datasets.map((dataset) =>
    h('tr', {}, heading(datasetLink(dataset)), countCell(dataset.count))), 2);
  renderRows('usage-indicators', indicators.map((indicator) =>
    h('tr', {}, heading(indicator.label), h('td', {}, datasetLink(indicator)), countCell(indicator.count))), 3);
  document.getElementById('usage-data').hidden = false;
  showStatus(document.getElementById('page-status'), '');
});
