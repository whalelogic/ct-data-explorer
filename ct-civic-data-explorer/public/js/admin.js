import { api, loadSession } from './api.js';
import { h as createElement } from './dom.js';
import { boot, formatDate, renderHeader, showStatus } from './layout.js';
import { defaultDatasetQuery, datasetFilterChoices, filterAndSortDatasets } from './admin-datasets.js';

let datasets = [];
let datasetQuery = defaultDatasetQuery();

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

  getElement('add-dataset').addEventListener('click', () => showDatasetUpload());
  getElement('back-to-datasets').addEventListener('click', showDatasetList);
  getElement('ds-file').addEventListener('change', handleFileSelection);
  getElement('upload-form').addEventListener('submit', uploadDataset);
  initializeDatasetControls();
  try {
    datasets = await api('/datasets');
    populateDatasetFilters();
    for (const control of document.querySelectorAll('#dataset-filters input, #dataset-filters select, [data-sort]')) {
      control.disabled = false;
    }
    renderDatasets();
  } catch (error) {
    getElement('dataset-count').textContent = 'Datasets unavailable.';
    getElement('datasets-body').replaceChildren(createElement('tr', {},
      createElement('td', { colspan: 7, class: 'muted' }, 'Datasets unavailable.')));
    throw error;
  } finally {
    getElement('datasets-panel').removeAttribute('aria-busy');
  }
}

function showDatasetUpload(focus = true) {
  getElement('datasets-panel').hidden = true;
  getElement('upload-panel').hidden = false;
  getElement('add-dataset').setAttribute('aria-expanded', 'true');
  if (focus) getElement('ds-file').focus();
}

function showDatasetList() {
  if (getElement('upload-form').getAttribute('aria-busy') === 'true') return;
  getElement('upload-panel').hidden = true;
  getElement('datasets-panel').hidden = false;
  getElement('add-dataset').setAttribute('aria-expanded', 'false');
  getElement('add-dataset').focus();
}

function initializeDatasetControls() {
  const filters = [
    ['dataset-search', 'search', 'input'],
    ['dataset-period', 'vintage', 'change'],
    ['dataset-publication', 'publication', 'change'],
    ['dataset-review', 'review', 'change'],
  ];
  for (const [id, key, event] of filters) {
    getElement(id).addEventListener(event, (event) => {
      datasetQuery[key] = event.target.value;
      renderDatasets();
    });
  }
  getElement('dataset-filters').addEventListener('submit', (event) => event.preventDefault());
  getElement('reset-dataset-filters').addEventListener('click', resetDatasetFilters);
  for (const button of document.querySelectorAll('[data-sort]')) {
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      datasetQuery.sortDirection = datasetQuery.sortKey === key && datasetQuery.sortDirection === 'ascending'
        ? 'descending' : 'ascending';
      datasetQuery.sortKey = key;
      renderDatasets();
    });
  }
}

function populateDatasetFilters() {
  const choices = datasetFilterChoices(datasets);
  const groups = [
    ['dataset-period', 'All periods', choices.vintages, (value) => value],
    ['dataset-publication', 'All statuses', choices.publications, (value) => value === 'published' ? 'Published' : 'Unpublished'],
    ['dataset-review', 'All statuses', choices.reviews, (value) => value === 'reviewed' ? 'Reviewed' : 'Needs review'],
  ];
  for (const [id, label, values, describe] of groups) {
    const select = getElement(id);
    select.replaceChildren(createElement('option', { value: '' }, label));
    for (const value of values) select.append(createElement('option', { value }, describe(value)));
  }
}

function resetDatasetFilters() {
  datasetQuery = defaultDatasetQuery();
  getElement('dataset-filters').reset();
  renderDatasets();
  getElement('dataset-search').focus();
}

function renderDatasets() {
  const matching = filterAndSortDatasets(datasets, datasetQuery);
  const tableBody = getElement('datasets-body');
  tableBody.replaceChildren();
  for (const dataset of matching) {
    tableBody.append(createDatasetRow(dataset));
  }

  if (!matching.length) {
    const emptyCell = createElement('td', { colspan: 7, class: 'muted' }, datasets.length ? 'No matching datasets.' : 'No datasets yet.');
    if (datasets.length) {
      emptyCell.append(' ', createElement('button', { type: 'button', class: 'link', onClick: resetDatasetFilters }, 'Reset filters'));
    }
    tableBody.append(createElement('tr', {}, emptyCell));
  }
  getElement('dataset-count').textContent = `${matching.length} of ${datasets.length} dataset${datasets.length === 1 ? '' : 's'}`;
  const defaults = defaultDatasetQuery();
  getElement('reset-dataset-filters').disabled = Object.keys(defaults).every((key) => datasetQuery[key] === defaults[key]);
  for (const button of document.querySelectorAll('[data-sort]')) {
    const selected = button.dataset.sort === datasetQuery.sortKey;
    const direction = selected ? datasetQuery.sortDirection : 'none';
    button.closest('th').setAttribute('aria-sort', direction);
    button.querySelector('.sort-indicator').textContent = !selected ? '↕' : direction === 'ascending' ? '↑' : '↓';
    button.title = selected && direction === 'ascending' ? 'Sort descending' : 'Sort ascending';
  }
}

function createDatasetRow(dataset) {
  const detailsUrl = `/dataset?id=${dataset.id}`;
  const titleLink = createElement('a', { href: detailsUrl }, dataset.displayName || dataset.name);
  const rowHeading = createElement('th', { scope: 'row' }, titleLink,
    createElement('div', { class: 'muted small' }, dataset.source));
  const statusTag = createElement('span', {
    class: dataset.isActive ? 'tag active' : 'tag',
  }, dataset.isActive ? 'Published' : 'Unpublished');
  const approvalSummary = dataset.curationReviewed
    ? `${dataset.approvedFields?.length ?? 0} approved`
    : 'Needs review';

  const row = createElement('tr', { class: 'dataset-row', onClick: openDatasetRow }, rowHeading);
  row.append(
    createElement('td', {}, dataset.vintage),
    createElement('td', { class: 'num' }, dataset.version),
    createElement('td', { class: 'num' }, dataset.rowCount.toLocaleString('en-US')),
    createElement('td', {}, dataset.uploadedAt && Number.isFinite(Date.parse(dataset.uploadedAt)) ? formatDate(dataset.uploadedAt) : '—'),
    createElement('td', {}, statusTag),
    createElement('td', {}, approvalSummary),
  );
  return row;
}

function openDatasetRow(event) {
  if (!event.target.closest('a')) {
    const titleLink = event.currentTarget.querySelector('a');
    location.assign(titleLink.href);
  }
}

function handleFileSelection() {
  const selectedFile = getElement('ds-file').files[0];
  getElement('upload-details').hidden = !selectedFile;

  const isExcelFile = selectedFile && /\.xlsx$/i.test(selectedFile.name);
  getElement('worksheet-field').hidden = !isExcelFile;
  getElement('ds-worksheet').disabled = !isExcelFile;
  getElement('ds-worksheet').value = '';
  showStatus(getElement('upload-status'), '');
  getElement('upload-errors').hidden = true;

  const datasetNameInput = getElement('ds-name');
  if (selectedFile && !datasetNameInput.value) {
    datasetNameInput.value = selectedFile.name.replace(/\.(csv|xlsx)$/i, '').replaceAll('_', ' ');
  }
}

async function uploadDataset(event) {
  event.preventDefault();
  const uploadForm = event.currentTarget;
  if (uploadForm.getAttribute('aria-busy') === 'true') return;
  showDatasetUpload(false);
  if (!uploadForm.reportValidity()) {
    return;
  }

  const submitButton = uploadForm.querySelector('button[type="submit"]');
  const formData = new FormData(uploadForm);
  formData.set('activate', 'false');
  const controls = [...uploadForm.querySelectorAll('button, input'), getElement('back-to-datasets')];
  const disabled = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  submitButton.textContent = 'Uploading…';
  uploadForm.setAttribute('aria-busy', 'true');
  getElement('upload-errors').hidden = true;
  showStatus(getElement('upload-status'), 'Uploading and validating…');

  try {
    const dataset = await api('/datasets', { method: 'POST', form: formData });
    location.assign(`/dataset?id=${dataset.id}`);
  } catch (error) {
    showDatasetUpload(false);
    showStatus(getElement('upload-status'), error.message, 'error');
    if (Array.isArray(error.details)) {
      const errorList = getElement('upload-errors');
      errorList.replaceChildren();
      for (const detail of error.details) {
        const message = typeof detail === 'string' ? detail : detail.message;
        errorList.append(createElement('li', {}, message));
      }
      errorList.hidden = false;
    }
    getElement('upload-status').focus();
  } finally {
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    submitButton.textContent = 'Upload and review';
    uploadForm.removeAttribute('aria-busy');
  }
}

boot(initializeAdminPage);
