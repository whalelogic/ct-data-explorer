import { api, loadSession } from './api.js';
import { h } from './dom.js';
import { boot, formatDate, renderHeader, showStatus } from './layout.js';

async function initializeMyDatasets() {
  const { user } = await loadSession();
  renderHeader(user);
  const datasets = await api('/datasets?scope=private');
  datasets.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  document.getElementById('private-datasets').replaceChildren(...datasets.map(datasetEntry));
  showStatus(document.getElementById('page-status'), datasets.length ? '' : 'Upload a CSV or Excel file to get started.');
}

function datasetEntry(dataset) {
  const detailsUrl = `/dataset?id=${dataset.id}`;
  const meta = [dataset.vintage, `version ${dataset.version}`, formatDate(dataset.uploadedAt)].join(' · ');
  return h('li', { class: 'saved-report' },
    h('div', { class: 'saved-report-body' },
      h('h2', { class: 'saved-report-title' }, h('a', { href: detailsUrl }, dataset.displayName)),
      h('p', { class: 'dash-card-meta' }, meta)),
    h('div', { class: 'saved-report-actions' },
      h('a', { class: 'button secondary', href: `/builder?dataset=${dataset.id}` }, 'Create report'),
      h('a', { href: `/chat?dataset=${dataset.id}` }, 'Ask AI')));
}

boot(initializeMyDatasets);
