/**
 * Admin dataset list: find a dataset by search, filters and sortable columns, then open it.
 * Adding a dataset has its own page (/admin/datasets/new, see upload.js).
 */
import { api, loadSession } from './api.js';
import { h as createElement } from './dom.js';
import { boot, formatDate, renderAdminNav, renderHeader } from './layout.js';

const FILTER_IDS = ['filter-period', 'filter-status', 'filter-review'];

let allDatasets = [];
let sortKey = 'uploadedAt';
let sortDirection = -1; // newest first

function getElement(id) {
  return document.getElementById(id);
}

async function initializeAdminPage() {
  const { user } = await loadSession();
  if (user.role !== 'admin') {
    location.assign('/');
    return;
  }
  renderHeader(user);
  renderAdminNav(getElement('admin-nav'));

  allDatasets = await api('/datasets');
  renderPeriodFilter();
  for (const id of ['dataset-search', ...FILTER_IDS]) {
    getElement(id).addEventListener('input', renderDatasets);
  }
  getElement('clear-filters').addEventListener('click', clearFilters);
  for (const button of document.querySelectorAll('.sort-button')) {
    button.addEventListener('click', handleSort);
  }
  renderDatasets();
}

function renderPeriodFilter() {
  const periods = [...new Set(allDatasets.map((dataset) => dataset.vintage))]
    .sort((first, second) => second.localeCompare(first, 'en', { numeric: true }));
  const select = getElement('filter-period');
  for (const period of periods) {
    select.append(createElement('option', { value: period }, period));
  }
}

/** Fields are chosen once an administrator has saved at least one. */
function hasChosenFields(dataset) {
  return dataset.curationReviewed && (dataset.approvedFields?.length ?? 0) > 0;
}

function matchesFilters(dataset) {
  const query = getElement('dataset-search').value.trim().toLowerCase();
  const period = getElement('filter-period').value;
  const status = getElement('filter-status').value;
  const review = getElement('filter-review').value;
  const searchable = `${dataset.displayName} ${dataset.name} ${dataset.source}`.toLowerCase();
  if (query && !searchable.includes(query)) return false;
  if (period && dataset.vintage !== period) return false;
  if (status === 'published' && !dataset.isActive) return false;
  if (status === 'draft' && dataset.isActive) return false;
  if (review === 'approved' && !hasChosenFields(dataset)) return false;
  if (review === 'needs-review' && hasChosenFields(dataset)) return false;
  return true;
}

function sortValue(dataset) {
  if (sortKey === 'name') return dataset.displayName || dataset.name;
  if (sortKey === 'uploadedAt') return new Date(dataset.uploadedAt).getTime();
  return dataset[sortKey];
}

function compareDatasets(first, second) {
  const a = sortValue(first);
  const b = sortValue(second);
  const order = typeof a === 'string' ? a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) : a - b;
  return order * sortDirection;
}

function handleSort(event) {
  const key = event.currentTarget.dataset.sort;
  if (key === sortKey) {
    sortDirection = -sortDirection;
  } else {
    sortKey = key;
    sortDirection = key === 'uploadedAt' ? -1 : 1;
  }
  for (const button of document.querySelectorAll('.sort-button')) {
    const isSorted = button.dataset.sort === sortKey;
    const direction = sortDirection === 1 ? 'ascending' : 'descending';
    button.closest('th').setAttribute('aria-sort', isSorted ? direction : 'none');
  }
  renderDatasets();
}

function clearFilters() {
  getElement('dataset-search').value = '';
  for (const id of FILTER_IDS) {
    getElement(id).value = '';
  }
  renderDatasets();
  getElement('dataset-search').focus();
}

function renderDatasets() {
  const shown = allDatasets.filter(matchesFilters).sort(compareDatasets);
  const tableBody = getElement('datasets-body');
  tableBody.replaceChildren();
  for (const dataset of shown) {
    tableBody.append(createDatasetRow(dataset));
  }

  if (!allDatasets.length) {
    tableBody.append(emptyRow('No datasets yet. Select Add dataset to upload a spreadsheet.'));
  } else if (!shown.length) {
    tableBody.append(emptyRow('No datasets match. Try clearing the search or filters.'));
  }
  getElement('dataset-count').textContent = shown.length === allDatasets.length
    ? `${allDatasets.length} ${allDatasets.length === 1 ? 'dataset' : 'datasets'}`
    : `${shown.length} of ${allDatasets.length} datasets`;
  const hasFilters = Boolean(getElement('dataset-search').value.trim()) || FILTER_IDS.some((id) => getElement(id).value);
  getElement('clear-filters').hidden = !hasFilters;
}

function emptyRow(message) {
  return createElement('tr', {}, createElement('td', { colspan: 7, class: 'muted' }, message));
}

function createDatasetRow(dataset) {
  // Drafts open on Settings, where the next step is.
  const detailsUrl = `/dataset?id=${dataset.id}${dataset.isActive ? '' : '#settings'}`;
  const titleLink = createElement('a', { href: detailsUrl }, dataset.displayName || dataset.name);
  const rowHeading = createElement('th', { scope: 'row' }, titleLink);
  if (dataset.source) {
    rowHeading.append(createElement('span', { class: 'field-choice-meta' }, dataset.source));
  }
  const statusTag = createElement('span', { class: dataset.isActive ? 'tag active' : 'tag' }, dataset.isActive ? 'Published' : 'Draft');
  let fields = createElement('span', { class: 'tag warn' }, 'Need choosing');
  if (hasChosenFields(dataset)) {
    fields = `${dataset.approvedFields.length} chosen`;
  } else if (dataset.approvedFields == null) {
    // Uploaded before field approval existed: every column is available until reviewed.
    fields = createElement('span', { class: 'tag' }, 'All · not reviewed');
  }

  const row = createElement('tr', { class: 'dataset-row', onClick: openDatasetRow }, rowHeading);
  row.append(
    createElement('td', {}, dataset.vintage),
    createElement('td', { class: 'num' }, dataset.version),
    createElement('td', { class: 'num' }, dataset.rowCount.toLocaleString('en-US')),
    createElement('td', {}, formatDate(dataset.uploadedAt)),
    createElement('td', {}, statusTag),
    createElement('td', {}, fields),
  );
  return row;
}

function openDatasetRow(event) {
  if (!event.target.closest('a')) {
    location.assign(event.currentTarget.querySelector('a').href);
  }
}

boot(initializeAdminPage);
