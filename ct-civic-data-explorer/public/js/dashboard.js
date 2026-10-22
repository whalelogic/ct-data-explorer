import { api, loadSession } from './api.js';
import { reportActionButtons, fetchReports, summarizeRows } from './report-library.js';
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
  document.getElementById('dash-greeting').textContent = greeting(currentUser.firstName);
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

function greeting(firstName) {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return firstName ? `${part}, ${firstName}` : part;
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
  let emptyMessage = 'No datasets match your search. Try a different name, source, or period.';
  if (!searchText) {
    const nextStep = currentUser.role === 'admin'
      ? 'Use Manage datasets to upload and approve data.'
      : 'Your data administrator can publish a dataset here.';
    emptyMessage = `No published datasets yet. ${nextStep}`;
  }
  showStatus(datasetStatus, matchingDatasetCount ? '' : emptyMessage);
}

/** Title, one line about where the data comes from, an optional description, and two actions. */
function createDatasetTile(dataset) {
  const reportUrl = `/builder?dataset=${dataset.id}`;
  const detailsUrl = `/dataset?id=${dataset.id}`;
  const hasApprovedFields = dataset.approvedFields === null || dataset.approvedFields?.length > 0;
  const title = createElement('h3', { class: 'saved-report-title' },
    createElement('a', { href: detailsUrl, class: 'stretched-link' }, dataset.displayName || dataset.name));
  // Period and size first: the source can be long and is the part that gets cut off.
  const facts = [dataset.vintage, `${dataset.rowCount.toLocaleString('en-US')} rows`, dataset.source].filter(Boolean).join(' · ');
  const body = createElement('div', { class: 'saved-report-body' },
    title,
    createElement('p', { class: 'dash-card-meta', title: facts }, facts));
  if (dataset.description) {
    body.append(createElement('p', { class: 'dash-card-description' }, dataset.description));
  }
  // Review status is an administrator's task, so only they see it, and only when it needs doing.
  if (currentUser.role === 'admin' && !dataset.curationReviewed) {
    body.append(createElement('span', { class: 'tag warn' }, 'Fields need review'));
  }
  const actions = createElement('div', { class: 'saved-report-actions' });
  if (hasApprovedFields) {
    actions.append(createElement('a', { href: reportUrl, class: 'button secondary dash-card-primary' }, 'Create a report'));
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
  let title = 'Your first report starts with a dataset';
  let description = 'Choose the places and measures you need, then save your report here.';
  if (searchInput.value.trim()) {
    title = 'No reports match your search';
    description = 'Try another dataset or report name, or clear the search to see more reports.';
  } else if (onlyMine.checked) {
    title = 'You haven’t saved a report yet';
    description = 'Create a report, or turn off Only my reports to browse your team’s work.';
  }
  document.getElementById('reports-empty-title').textContent = title;
  document.getElementById('reports-empty-description').textContent = description;
}

function compareReports(first, second) {
  if (reportSort.value === 'title') {
    return first.title.localeCompare(second.title);
  }
  const difference = new Date(second.updatedAt) - new Date(first.updatedAt);
  return reportSort.value === 'oldest' ? -difference : difference;
}

/** Title, what it compares, one line of facts, then the actions in one consistent style. */
function createReportTile(report) {
  const title = createElement('h3', { class: 'saved-report-title' },
    createElement('a', { href: report.viewUrl ?? `/builder?report=${report.id}`, class: 'stretched-link' }, report.title));
  const rows = createElement('p', { class: 'saved-report-towns' }, summarizeRows(report));
  const author = report.createdBy.id === currentUser.id ? 'you' : report.createdBy.name;
  const dataset = `${report.dataset.displayName || report.dataset.name}, ${report.dataset.vintage}`;
  const meta = createElement('p', { class: 'dash-card-meta', title: dataset }, dataset);
  const updated = createElement('p', { class: 'dash-card-meta' }, 'Updated ',
    createElement('time', { datetime: report.updatedAt }, formatDate(report.updatedAt)), ` by ${author}`);
  const body = createElement('div', { class: 'saved-report-body' }, title, rows, meta, updated);
  const actions = createElement('div', { class: 'saved-report-actions' });
  actions.append(createElement('a', { href: `/builder?report=${report.id}`, class: 'button secondary dash-card-primary' }, 'Edit'));
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
  // Results already update as you type; Enter just runs the search immediately.
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
