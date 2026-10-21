import { api, loadSession } from './api.js';
import { reportActionButtons, fetchReports } from './report-library.js';
import { h as createElement } from './dom.js';
import { boot, debounce, formatDate, renderHeader, showStatus } from './layout.js';

const datasetGrid = document.getElementById('datasets-grid');
const datasetStatus = document.getElementById('datasets-status');
const reportsGrid = document.getElementById('reports-grid');
const reportsStatus = document.getElementById('reports-status');
const searchInput = document.getElementById('search-input');
const onlyMine = document.getElementById('only-mine');
const reportSort = document.getElementById('report-sort');
const scheduleReportSearch = debounce(loadReports, 250);

let currentUser;
let publishedDatasets = [];
let matchingReports = [];
let reportRequestNumber = 0;
let reportsLoaded = false;

async function initializeDashboard() {
  const session = await loadSession();
  currentUser = session.user;
  renderHeader(currentUser);
  document.getElementById('manage-datasets').hidden = currentUser.role !== 'admin';
  searchInput.addEventListener('input', handleSearchInput);
  document.getElementById('dashboard-search').addEventListener('submit', handleSearchSubmit);
  document.getElementById('clear-search').addEventListener('click', clearSearch);
  document.getElementById('retry-datasets').addEventListener('click', loadDatasets);
  document.getElementById('retry-reports').addEventListener('click', loadReports);
  onlyMine.addEventListener('change', renderReports);
  reportSort.addEventListener('change', renderReports);
  await Promise.all([loadDatasets(), loadReports()]);
}

async function loadDatasets() {
  datasetGrid.setAttribute('aria-busy', 'true');
  document.getElementById('retry-datasets').hidden = true;
  showStatus(datasetStatus, 'Loading datasets…');
  try {
    const datasets = await api('/datasets');
    publishedDatasets = datasets.filter((dataset) => dataset.isActive);
    publishedDatasets.sort((first, second) => (first.displayName || first.name).localeCompare(second.displayName || second.name));
    renderDatasets();
  } catch (error) {
    showStatus(datasetStatus, error.message, 'error');
    document.getElementById('retry-datasets').hidden = false;
  } finally {
    datasetGrid.setAttribute('aria-busy', 'false');
  }
}

function renderDatasets() {
  const searchText = searchInput.value.trim().toLowerCase();
  datasetGrid.replaceChildren();
  let matchingDatasetCount = 0;
  for (const dataset of publishedDatasets) {
    const searchableValues = [dataset.displayName, dataset.name, dataset.source, dataset.vintage];
    const matchesSearch = searchableValues.some((value) => String(value).toLowerCase().includes(searchText));
    if (matchesSearch) {
      datasetGrid.append(createDatasetTile(dataset));
      matchingDatasetCount += 1;
    }
  }
  document.getElementById('dataset-count').textContent = searchText
    ? `${matchingDatasetCount} of ${publishedDatasets.length}`
    : String(publishedDatasets.length);
  let emptyMessage = 'No matching datasets.';
  if (!searchText) {
    emptyMessage = 'No published datasets.';
  }
  showStatus(datasetStatus, matchingDatasetCount ? '' : emptyMessage);
}

function createDatasetTile(dataset) {
  const exploreUrl = `/explore?dataset=${dataset.id}`;
  const detailsUrl = `/dataset?id=${dataset.id}`;
  const hasApprovedFields = dataset.approvedFields === null || dataset.approvedFields?.length > 0;
  const titleLink = createElement('a', {
    href: hasApprovedFields ? exploreUrl : detailsUrl,
    class: 'stretched-link',
  }, dataset.displayName || dataset.name);
  const title = createElement('h3', { class: 'saved-report-title' }, titleLink);
  const metadata = `${dataset.vintage} · ${dataset.rowCount.toLocaleString()} rows`;
  const body = createElement('div', { class: 'saved-report-body' });
  body.append(
    title,
    createElement('p', { class: 'muted small' }, metadata),
    createElement('p', { class: 'dashboard-dataset-source' }, dataset.source),
    ...(!hasApprovedFields ? [createElement('p', { class: 'dashboard-review' }, 'Fields awaiting approval')] : []),
  );
  const actions = createElement('div', { class: 'saved-report-actions' });
  if (hasApprovedFields) {
    actions.append(createElement('a', { href: exploreUrl }, 'Explore'));
    actions.append(createElement('a', { href: `/builder?dataset=${dataset.id}` }, 'New report'));
  }
  actions.append(createElement('a', { href: detailsUrl }, 'Details'));
  return createElement('li', { class: 'saved-report dashboard-dataset' }, body, actions);
}

async function loadReports() {
  const requestNumber = ++reportRequestNumber;
  reportsLoaded = false;
  matchingReports = [];
  reportsGrid.replaceChildren();
  reportsGrid.setAttribute('aria-busy', 'true');
  document.getElementById('reports-empty').hidden = true;
  document.getElementById('retry-reports').hidden = true;
  document.getElementById('report-count').textContent = '';
  document.getElementById('reports-limit').hidden = true;
  showStatus(reportsStatus, 'Loading reports…');
  try {
    const reports = await fetchReports(searchInput.value.trim());
    // A newer search may finish first; never replace it with an older response.
    if (requestNumber !== reportRequestNumber) {
      return;
    }
    matchingReports = reports;
    reportsLoaded = true;
    showStatus(reportsStatus, '');
    renderReports();
  } catch (error) {
    if (requestNumber !== reportRequestNumber) {
      return;
    }
    showStatus(reportsStatus, error.message, 'error');
    document.getElementById('retry-reports').hidden = false;
  } finally {
    if (requestNumber === reportRequestNumber) {
      reportsGrid.setAttribute('aria-busy', 'false');
    }
  }
}

function renderReports() {
  if (!reportsLoaded) {
    return;
  }
  const visibleReports = matchingReports.filter((report) => !onlyMine.checked || report.createdBy.id === currentUser.id);
  visibleReports.sort(compareReports);
  reportsGrid.replaceChildren();
  for (const report of visibleReports) {
    reportsGrid.append(createReportTile(report));
  }
  document.getElementById('report-count').textContent = String(visibleReports.length);
  document.getElementById('reports-limit').hidden = matchingReports.length < 200;
  document.getElementById('reports-empty').hidden = visibleReports.length > 0;
  let title = 'No saved reports';
  if (searchInput.value.trim()) {
    title = 'No matching reports';
  } else if (onlyMine.checked) {
    title = 'No reports saved by you';
  }
  document.getElementById('reports-empty-title').textContent = title;
}

function compareReports(first, second) {
  if (reportSort.value === 'title') {
    return first.title.localeCompare(second.title);
  }
  const difference = new Date(second.updatedAt) - new Date(first.updatedAt);
  return reportSort.value === 'oldest' ? -difference : difference;
}

function createReportTile(report) {
  const titleLink = createElement('a', {
    href: `/builder?report=${report.id}`,
    class: 'stretched-link',
  }, report.title);
  const title = createElement('h3', { class: 'saved-report-title' }, titleLink);
  // Keep large selections readable without hiding the full selection in the builder.
  const townSummary = report.towns.length > 3
    ? `${report.towns.slice(0, 3).join(', ')} + ${report.towns.length - 3} more`
    : report.towns.join(', ');
  const towns = createElement('p', { class: 'saved-report-towns' }, townSummary || 'All source rows');
  const updatedTime = createElement('time', { datetime: report.updatedAt }, formatDate(report.updatedAt));
  const metadata = createElement('dl', { class: 'saved-report-meta' });
  metadata.append(
    createElement('dt', {}, 'Dataset'),
    createElement('dd', {}, `${report.dataset.displayName || report.dataset.name}, ${report.dataset.vintage}`),
    createElement('dt', {}, 'Created by'),
    createElement('dd', {}, report.createdBy.id === currentUser.id ? 'You' : report.createdBy.name),
    createElement('dt', {}, 'Updated'),
    createElement('dd', {}, updatedTime),
  );
  const body = createElement('div', { class: 'saved-report-body' }, title, towns, metadata);
  const actions = createElement('div', { class: 'saved-report-actions' });
  actions.append(createElement('a', { href: `/builder?report=${report.id}` }, 'Open'));
  actions.append(...reportActionButtons(report, {
    user: currentUser,
    status: document.getElementById('report-action-status'),
    reload: loadReports,
  }).filter(Boolean));
  return createElement('li', { class: 'saved-report' }, body, actions);
}

function handleSearchInput() {
  // Invalidate active requests immediately, including during the debounce window.
  reportRequestNumber += 1;
  reportsLoaded = false;
  document.getElementById('clear-search').hidden = !searchInput.value;
  renderDatasets();
  scheduleReportSearch();
}

function handleSearchSubmit(event) {
  event.preventDefault();
  renderDatasets();
  loadReports();
}

function clearSearch() {
  searchInput.value = '';
  document.getElementById('clear-search').hidden = true;
  renderDatasets();
  loadReports();
  searchInput.focus();
}

boot(initializeDashboard);
