import { api, loadSession } from './api.js';
import { reportActionButtons, fetchReports } from './report-library.js';
import { h } from './dom.js';
import { boot, debounce, formatDate, renderHeader, showStatus } from './layout.js';

boot(async () => {
  const { user } = await loadSession();
  renderHeader(user);
  const datasets = await api('/datasets');
  const active = datasets.filter((d) => d.isActive);
  const datasetGrid = document.getElementById('datasets-grid');
  const datasetStatus = document.getElementById('datasets-status');
  const grid = document.getElementById('reports-grid');
  const reportsStatus = document.getElementById('reports-status');
  const search = document.getElementById('search-input');
  let reportRequest = 0;

  function renderDatasets() {
    const query = search.value.trim().toLowerCase();
    const matches = active.filter((dataset) => dataset.name.toLowerCase().includes(query));
    datasetGrid.replaceChildren(...matches.map(datasetTile));
    const empty = query ? 'No datasets match this name.'
      : `No active datasets yet. ${user.role === 'admin' ? 'Select Upload dataset to add one.' : 'Ask an administrator to upload one.'}`;
    showStatus(datasetStatus, matches.length ? '' : empty);
  }

  function datasetTile(dataset) {
    const href = `/builder.html?dataset=${dataset.id}`;
    return h('li', { class: 'saved-report' },
      h('div', { class: 'saved-report-body' },
        h('h3', { class: 'saved-report-title' }, h('a', { href: `/dataset.html?id=${dataset.id}`, class: 'stretched-link' }, dataset.name)),
        h('p', { class: 'muted small' }, `${dataset.vintage} · Version ${dataset.version} · ${dataset.rowCount} rows`),
        h('p', { class: 'small' }, dataset.source),
      ),
      h('div', { class: 'saved-report-actions' }, h('a', { href }, 'Make report')),
    );
  }

  async function loadrReports() {
    const request = ++reportRequest;
    try {
      const query = search.value.trim();
      const reports = await fetchReports(query);
      if (request !== reportRequest) return;
      grid.replaceChildren(...reports.map(reportTile));
      const empty = query ? 'No reports match this dataset or report name.' : 'No saved reports yet. Choose a dataset or select Make report to begin.';
      showStatus(reportsStatus, reports.length ? '' : empty);
    } catch (err) {
      if (request !== reportRequest) return;
      grid.replaceChildren();
      showStatus(reportsStatus, err.message, 'error');
    }
  }

  /** The title link stretches over the whole report (see .stretched-link); the action buttons sit above it. */
  function reportTile(report) {
    return h(
      'li',
      { class: 'saved-report' },
      h(
        'div',
        { class: 'saved-report-body' },
        h('h3', { class: 'saved-report-title' }, h('a', { href: `/builder.html?report=${report.id}`, class: 'stretched-link' }, report.title)),
        h('p', { class: 'saved-report-towns' }, report.towns.join(', ')),
        h(
          'dl',
          { class: 'saved-report-meta' },
          h('dt', {}, 'Dataset'),
          h('dd', {}, `${report.dataset.name}, ${report.dataset.vintage}`),
          h('dt', {}, 'Created by'),
          h('dd', {}, report.createdBy.name),
          h('dt', {}, 'Updated'),
          h('dd', {}, h('time', { datetime: report.updatedAt }, formatDate(report.updatedAt))),
        ),
      ),
      h('div', { class: 'saved-report-actions' }, ...reportActionButtons(report, { user, status: reportsStatus, reload: loadReports })),
    );
  }

  const scheduleReports = debounce(loadReports, 250);
  search.addEventListener('input', () => {
    reportRequest++;
    renderDatasets();
    scheduleReports();
  });
  document.getElementById('dashboard-search').addEventListener('submit', (event) => {
    event.preventDefault();
    renderDatasets();
    loadReports();
  });
  renderDatasets();
  await loadReports();
});
