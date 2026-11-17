/**
 * Add a dataset: choose a file → describe it → choose its primary field → upload.
 * Steps after the first appear once a file is chosen; the server reads the file's columns
 * so the row question offers real choices.
 */
import { api, loadSession } from './api.js';
import { h as createElement } from './dom.js';
import { mountIndicatorEditor } from './indicator-editor.js';
import { boot, renderAdminNav, renderHeader, showStatus } from './layout.js';

const privateUpload = location.pathname === '/datasets/new';
const uploadPath = privateUpload ? '/datasets/private' : '/datasets';

let inspectedColumns = [];
let previewRows = [];
let inspectRequestNumber = 0;

function getElement(id) {
  return document.getElementById(id);
}

async function initializeUploadPage() {
  const { user } = await loadSession();
  if (!privateUpload && user.role !== 'admin') {
    location.assign('/');
    return;
  }
  renderHeader(user);
  if (privateUpload) {
    getElement('admin-nav').hidden = true;
    getElement('upload-heading').textContent = 'Upload a private dataset';
    getElement('upload-intro').textContent = 'Only your account can open this dataset and reports that use it.';
    getElement('ds-source').value = 'My upload';
    getElement('cancel-upload').href = '/datasets/mine';
    getElement('upload-form').querySelector('button[type="submit"]').textContent = 'Upload dataset';
    document.title = 'Upload a private dataset · CT Civic Data Explorer';
  } else {
    renderAdminNav(getElement('admin-nav'));
    mountIndicatorEditor(getElement('upload-indicator-editor'), 'upload-indicator');
  }

  getElement('ds-file').addEventListener('change', handleFileSelection);
  getElement('upload-form').addEventListener('submit', uploadDataset);
  getElement('ds-label-column').addEventListener('change', handleLabelColumnChange);
  // A different worksheet has different columns.
  getElement('ds-worksheet').addEventListener('change', inspectSelectedFile);
}

function handleFileSelection() {
  const selectedFile = getElement('ds-file').files[0];
  for (const id of ['details-step', 'upload-actions']) {
    getElement(id).hidden = !selectedFile;
  }
  getElement('column-setup').hidden = privateUpload || !selectedFile;

  const isExcelFile = selectedFile && /\.xlsx$/i.test(selectedFile.name);
  getElement('worksheet-field').hidden = !isExcelFile;
  getElement('ds-worksheet').disabled = !isExcelFile;
  getElement('ds-worksheet').value = '';
  showStatus(getElement('upload-status'), '');
  getElement('upload-errors').hidden = true;

  const datasetNameInput = getElement('ds-name');
  if (selectedFile && !datasetNameInput.value) {
    datasetNameInput.value = selectedFile.name.replace(/\.(csv|xlsx)$/i, '').replaceAll(/[_-]+/g, ' ');
  }
  inspectSelectedFile();
}

/** Read the file's columns on the server so staff can say which one names each row. */
async function inspectSelectedFile() {
  const selectedFile = getElement('ds-file').files[0];
  const requestNumber = ++inspectRequestNumber;
  getElement('row-label-field').hidden = true;
  if (!selectedFile) {
    return;
  }
  const formData = new FormData();
  formData.set('file', selectedFile);
  const worksheet = getElement('ds-worksheet').value.trim();
  if (worksheet) {
    formData.set('worksheet', worksheet);
  }
  showStatus(getElement('inspect-status'), 'Reading the file…');
  try {
    const inspection = await api(`${uploadPath}/inspect`, { method: 'POST', form: formData });
    if (requestNumber !== inspectRequestNumber) {
      return;
    }
    inspectedColumns = inspection.columns;
    previewRows = inspection.previewRows ?? [];
    const select = getElement('ds-label-column');
    select.replaceChildren();
    // Number columns rarely name rows, so they go last.
    const ordered = [...inspectedColumns].sort((first, second) => Number(first.isNumeric) - Number(second.isNumeric));
    for (const column of ordered) {
      const kind = column.isNumeric ? 'numbers' : `${column.distinctCount.toLocaleString()} different values`;
      select.append(createElement('option', { value: column.label }, `${column.label} (${kind})`));
    }
    if (inspection.suggested) {
      select.value = inspection.suggested.label;
    }
    handleLabelColumnChange();
    getElement('row-label-field').hidden = false;
    const rows = inspection.rowCount.toLocaleString();
    showStatus(getElement('inspect-status'), `Found ${rows} rows and ${inspectedColumns.length} columns.`, 'ok');
  } catch (error) {
    if (requestNumber === inspectRequestNumber) {
      showStatus(getElement('inspect-status'), error.message, 'error');
    }
  }
}

/** The file's first rows, with the chosen row column first and highlighted. */
function renderUploadPreview() {
  const chosen = getElement('ds-label-column').value;
  const order = inspectedColumns.map((column, index) => ({ column, index }));
  order.sort((first, second) => Number(second.column.label === chosen) - Number(first.column.label === chosen));
  const table = createElement('table', { class: 'data shape-table' });
  const headingRow = createElement('tr');
  for (const { column } of order) {
    const isRowLabel = column.label === chosen;
    const kind = isRowLabel ? 'Primary field' : column.isNumeric ? 'Number' : 'Text';
    headingRow.append(createElement('th', { scope: 'col', class: isRowLabel ? 'is-row-label' : (column.isNumeric ? 'num' : null) },
      createElement('span', { class: 'column-name' }, column.label),
      createElement('span', { class: 'column-type' }, kind)));
  }
  const body = createElement('tbody');
  for (const cells of previewRows) {
    const row = createElement('tr');
    for (const { column, index } of order) {
      const isRowLabel = column.label === chosen;
      const value = cells[index] === '' || cells[index] == null ? '—' : cells[index];
      row.append(isRowLabel
        ? createElement('th', { scope: 'row', class: 'is-row-label' }, value)
        : createElement('td', { class: column.isNumeric ? 'num' : null }, value));
    }
    body.append(row);
  }
  table.append(createElement('thead', {}, headingRow), body);
  getElement('upload-preview').replaceChildren(table);
}

function handleLabelColumnChange() {
  const column = inspectedColumns.find((candidate) => candidate.label === getElement('ds-label-column').value);
  // Geographic uploads require a recognized place on every row, including rows with blanks.
  const matchesPlaces = column?.townShare === 1 && column.blankCount === 0;
  getElement('ds-label-is-town').checked = matchesPlaces;
  getElement('geography-option').hidden = !matchesPlaces;

  const details = column?.samples.length ? [`Sample values · ${column.samples.join(' · ')}`] : [];
  if (column?.townShare > 0 && !matchesPlaces) {
    details.push('Every row must match a Connecticut place to enable place comparisons.');
  }
  getElement('label-samples').textContent = details.join(' · ');
  renderUploadPreview();
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
  if (getElement('row-label-field').hidden) {
    formData.delete('labelColumn');
  } else {
    formData.set('labelIsTown', String(getElement('ds-label-is-town').checked));
  }
  submitButton.disabled = true;
  getElement('upload-errors').hidden = true;
  showStatus(getElement('upload-status'), 'Uploading and checking the file…');

  try {
    const dataset = await api(uploadPath, { method: 'POST', form: formData });
    location.assign(`/dataset?id=${dataset.id}${privateUpload ? '' : '#settings'}`);
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
    submitButton.disabled = false;
  }
}

boot(initializeUploadPage);
