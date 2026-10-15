import { api, loadSession } from './api.js';
import { reportActionButtons, fetchReports } from './report-library.js';
import { h as createElement } from './dom.js';
import { boot, debounce, formatDate, renderHeader, showStatus } from './layout.js';

const datasetGrid = document.getElementById('datasets-grid');
const datasetStatus = document.getElementById('datasets-status');
const reportsGrid = document.getElementById('reports-grid');
const reportsStatus = document.getElementById('reports-status');
const searchInput = document.getElementById('search-input');
const scheduleReportSearch = debounce(loadReports, 250);

let currentUser;
let publishedDatasets = [];
let reportRequestNumber = 0;

async function initializeDashboard() {
  const session = await loadSession();
  currentUser = session.user;
  renderHeader(currentUser);

  const datasets = await api('/datasets');
  publishedDatasets = datasets.filter((dataset) => dataset.isActive);
  searchInput.addEventListener('input', handleSearchInput);
  document.getElementById('dashboard-search').addEventListener('submit', handleSearchSubmit);
  renderDatasets();
  await loadReports();
}

function renderDatasets() {
  const searchText = searchInput.value.trim().toLowerCase();
  datasetGrid.replaceChildren();
  let matchingDatasetCount = 0;

  for (const dataset of publishedDatasets) {
    const searchableValues = [dataset.name, dataset.source, dataset.vintage];
    const matchesSearch = searchableValues.some((value) => String(value).toLowerCase().includes(searchText));
    if (matchesSearch) {
      datasetGrid.append(createDatasetTile(dataset));
      matchingDatasetCount += 1;
    }
  }

  let emptyMessage = 'No datasets match this name.';
  if (!searchText) {
    const nextStep = currentUser.role === 'admin'
      ? 'Open Data management to upload and approve data.'
      : 'Your data administrator can publish a dataset here.';
    emptyMessage = `No published datasets yet. ${nextStep}`;
  }
  showStatus(datasetStatus, matchingDatasetCount ? '' : emptyMessage);
}

function createDatasetTile(dataset) {
  const exploreUrl = `/explore.html?dataset=${dataset.id}`;
  const detailsUrl = `/dataset.html?id=${dataset.id}`;
  const hasApprovedFields = dataset.approvedFields === null || dataset.approvedFields?.length > 0;

  const titleLink = createElement('a', {
    href: hasApprovedFields ? exploreUrl : detailsUrl,
    class: 'stretched-link',
  }, dataset.name);
  const title = createElement('h3', { class: 'saved-report-title' }, titleLink);
  const metadata = `${dataset.vintage} · Version ${dataset.version} · ${dataset.rowCount} rows`;
  let reviewStatus = 'Awaiting field approval';
  if (hasApprovedFields) {
    reviewStatus = dataset.curationReviewed
      ? 'Fields reviewed by staff'
      : 'Existing published fields · review pending';
  }

  const body = createElement('div', { class: 'saved-report-body' }, title);
  body.append(
    createElement('p', { class: 'muted small' }, metadata),
    createElement('p', { class: 'small' }, dataset.source),
    createElement('p', { class: 'muted small' }, reviewStatus),
  );

  const actions = createElement('div', { class: 'saved-report-actions' });
  if (hasApprovedFields) {
    actions.append(createElement('a', { href: exploreUrl }, 'Explore dataset'));
  }
  const detailsLabel = currentUser.role === 'admin' ? 'Review dataset' : 'Dataset details';
  actions.append(createElement('a', { href: detailsUrl }, detailsLabel));
  return createElement('li', { class: 'saved-report' }, body, actions);
}

async function loadReports() {
  reportRequestNumber += 1;
  const currentRequestNumber = reportRequestNumber;
  try {
    const searchText = searchInput.value.trim();
    const reports = await fetchReports(searchText);
    // A newer search may finish first. Keep its results on screen.
    if (currentRequestNumber !== reportRequestNumber) {
      return;
    }

    reportsGrid.replaceChildren();
    for (const report of reports) {
      reportsGrid.append(createReportTile(report));
    }
    const emptyMessage = searchText
      ? 'No reports match this dataset or report name.'
      : 'No saved reports yet. Explore a dataset, then save a report when you are ready.';
    showStatus(reportsStatus, reports.length ? '' : emptyMessage);
  } catch (error) {
    if (currentRequestNumber !== reportRequestNumber) {
      return;
    }
    reportsGrid.replaceChildren();
    showStatus(reportsStatus, error.message, 'error');
  }
}

function createReportTile(report) {
  // The title link covers the report; action buttons remain above it in the CSS.
  const titleLink = createElement('a', {
    href: `/builder.html?report=${report.id}`,
    class: 'stretched-link',
  }, report.title);
  const title = createElement('h3', { class: 'saved-report-title' }, titleLink);
  const towns = createElement('p', { class: 'saved-report-towns' }, report.towns.join(', '));
  const updatedTime = createElement('time', { datetime: report.updatedAt }, formatDate(report.updatedAt));
  const metadata = createElement('dl', { class: 'saved-report-meta' });
  metadata.append(
    createElement('dt', {}, 'Dataset'),
    createElement('dd', {}, `${report.dataset.name}, ${report.dataset.vintage}`),
    createElement('dt', {}, 'Created by'),
    createElement('dd', {}, report.createdBy.name),
    createElement('dt', {}, 'Updated'),
    createElement('dd', {}, updatedTime),
  );

  const body = createElement('div', { class: 'saved-report-body' }, title, towns, metadata);
  const buttons = reportActionButtons(report, {
    user: currentUser,
    status: reportsStatus,
    reload: loadReports,
  });
  const actions = createElement('div', { class: 'saved-report-actions' }, ...buttons);
  return createElement('li', { class: 'saved-report' }, body, actions);
}

function handleSearchInput() {
  // Invalidate any active request while the next search waits for the debounce.
  reportRequestNumber += 1;
  renderDatasets();
  scheduleReportSearch();
}

function handleSearchSubmit(event) {
  event.preventDefault();
  renderDatasets();
  loadReports();
}

boot(initializeDashboard);
