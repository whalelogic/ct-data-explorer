import { api, loadSession } from './api.js';
import { h as createElement } from './dom.js';
import { boot, formatDate, renderHeader, showStatus } from './layout.js';
import { revealTab } from './tabs.js';

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

  getElement('ds-file').addEventListener('change', handleFileSelection);
  getElement('upload-form').addEventListener('submit', uploadDataset);
  try {
    renderDatasets(await api('/datasets'));
  } catch (error) {
    getElement('datasets-body').replaceChildren(createElement('tr', {},
      createElement('td', { colspan: 7, class: 'muted' }, 'Datasets unavailable.')));
    throw error;
  }
}

function renderDatasets(datasets) {
  const tableBody = getElement('datasets-body');
  tableBody.replaceChildren();
  for (const dataset of datasets) {
    tableBody.append(createDatasetRow(dataset));
  }

  if (!datasets.length) {
    const emptyCell = createElement('td', { colspan: 7, class: 'muted' },
      'No datasets yet.');
    tableBody.append(createElement('tr', {}, emptyCell));
  }
}

function createDatasetRow(dataset) {
  const detailsUrl = `/dataset?id=${dataset.id}`;
  const titleLink = createElement('a', { href: detailsUrl }, dataset.displayName || dataset.name);
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
  revealTab(uploadForm);
  if (!uploadForm.reportValidity()) {
    return;
  }

  const submitButton = uploadForm.querySelector('button[type="submit"]');
  const formData = new FormData(uploadForm);
  formData.set('activate', 'false');
  const controls = [...uploadForm.querySelectorAll('button, input')];
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
    revealTab(uploadForm);
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
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    submitButton.textContent = 'Upload and review';
    uploadForm.removeAttribute('aria-busy');
  }
}

boot(initializeAdminPage);
