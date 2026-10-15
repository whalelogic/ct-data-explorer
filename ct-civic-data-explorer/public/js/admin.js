import { api, loadSession } from './api.js';
import { h as createElement } from './dom.js';
import { mountIndicatorEditor } from './indicator-editor.js';
import { boot, formatDate, renderHeader, showStatus } from './layout.js';

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
  mountIndicatorEditor(getElement('upload-indicator-editor'), 'upload-indicator');

  const datasets = await api('/datasets');
  renderDatasets(datasets);
  getElement('ds-file').addEventListener('change', handleFileSelection);
  getElement('upload-form').addEventListener('submit', uploadDataset);
}

function renderDatasets(datasets) {
  const tableBody = getElement('datasets-body');
  tableBody.replaceChildren();
  for (const dataset of datasets) {
    tableBody.append(createDatasetRow(dataset));
  }

  if (!datasets.length) {
    const emptyCell = createElement('td', { colspan: 7, class: 'muted' },
      'No datasets yet. Upload a CSV or Excel file to get started.');
    tableBody.append(createElement('tr', {}, emptyCell));
  }
}

function createDatasetRow(dataset) {
  const detailsUrl = `/dataset.html?id=${dataset.id}`;
  const titleLink = createElement('a', { href: detailsUrl }, dataset.name);
  const rowHeading = createElement('th', { scope: 'row' }, titleLink);
  const statusTag = createElement('span', {
    class: dataset.isActive ? 'tag active' : 'tag',
  }, dataset.isActive ? 'Published' : 'Draft / archived');
  const approvalSummary = dataset.curationReviewed
    ? `${dataset.approvedFields.length} approved`
    : 'Needs review';

  const row = createElement('tr', { class: 'dataset-row', onClick: openDatasetRow }, rowHeading);
  row.append(
    createElement('td', {}, dataset.vintage),
    createElement('td', { class: 'num' }, dataset.version),
    createElement('td', { class: 'num' }, dataset.rowCount.toLocaleString('en-US')),
    createElement('td', {}, formatDate(dataset.uploadedAt)),
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
  getElement('column-setup').hidden = !selectedFile;

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
  if (!uploadForm.reportValidity()) {
    return;
  }

  const submitButton = uploadForm.querySelector('button[type="submit"]');
  const formData = new FormData(uploadForm);
  formData.set('activate', 'false');
  submitButton.disabled = true;
  getElement('upload-errors').hidden = true;
  showStatus(getElement('upload-status'), 'Uploading and validating…');

  try {
    const dataset = await api('/datasets', { method: 'POST', form: formData });
    location.assign(`/dataset.html?id=${dataset.id}`);
  } catch (error) {
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
  } finally {
    submitButton.disabled = false;
  }
}

boot(initializeAdminPage);
