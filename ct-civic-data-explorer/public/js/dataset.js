import { api, loadSession } from './api.js';
import { h as createElement } from './dom.js';
import { mountIndicatorEditor } from './indicator-editor.js';
import { boot, formatDate, renderHeader, showStatus } from './layout.js';

const PAGE_SIZE = 25;

let datasetId;
let isAdmin = false;
let currentOverview;
let previewOffset = 0;
let fieldCuration;
let approvedFieldKeys = new Set();

function getElement(id) {
  return document.getElementById(id);
}

async function initializeDatasetPage() {
  const { user } = await loadSession();
  renderHeader(user);

  datasetId = new URLSearchParams(location.search).get('id');
  if (!datasetId || !/^[1-9]\d*$/.test(datasetId)) {
    throw new Error('Choose a dataset from the dataset table.');
  }

  isAdmin = user.role === 'admin';
  getElement('back-link').href = isAdmin ? '/admin' : '/';
  getElement('previous').addEventListener('click', loadPreviousPage);
  getElement('next').addEventListener('click', loadNextPage);
  getElement('retry').addEventListener('click', reloadDataset);
  getElement('toggle-active').addEventListener('click', togglePublishedStatus);

  if (isAdmin) {
    initializeAdminControls();
  }

  await loadDataset();
  await loadFieldCuration();
}

function initializeAdminControls() {
  getElement('indicator-setup').hidden = false;
  mountIndicatorEditor(getElement('dataset-indicator-editor'), 'dataset-indicator', reloadDataset);
  getElement('curation-search').addEventListener('input', renderCurationFields);
  getElement('approve-visible').addEventListener('click', approveVisibleFields);
  getElement('clear-visible').addEventListener('click', clearVisibleFields);
  getElement('save-curation').addEventListener('click', saveFieldCuration);
}

function updateCurationSummary() {
  const approvalCount = `${approvedFieldKeys.size} of ${fieldCuration.fields.length} fields selected.`;
  const reviewMessage = fieldCuration.curationReviewed
    ? 'The saved approval controls user access.'
    : 'Review pending. Save to confirm the approved fields.';
  getElement('curation-summary').textContent = `${approvalCount} ${reviewMessage}`;

  const savedFieldKeys = fieldCuration.approvedFields;
  const hasUnsavedChanges = approvedFieldKeys.size !== savedFieldKeys.length
    || savedFieldKeys.some((fieldKey) => !approvedFieldKeys.has(fieldKey));

  if (currentOverview && !currentOverview.dataset.isActive) {
    getElement('toggle-active').disabled = hasUnsavedChanges
      || !fieldCuration.curationReviewed
      || approvedFieldKeys.size === 0;
  }
}

function renderCurationFields() {
  const searchText = getElement('curation-search').value.trim().toLowerCase();
  const fieldsContainer = getElement('curation-fields');
  fieldsContainer.replaceChildren();

  for (const field of fieldCuration.fields) {
    const searchableText = `${field.label} ${field.key} ${field.unit}`.toLowerCase();
    if (searchableText.includes(searchText)) {
      fieldsContainer.append(createCurationField(field));
    }
  }

  if (!fieldsContainer.children.length) {
    fieldsContainer.append(createElement('p', { class: 'muted' }, 'No matching fields.'));
  }
  updateCurationSummary();
}

function createCurationField(field) {
  const checkbox = createElement('input', {
    type: 'checkbox',
    value: field.key,
    checked: approvedFieldKeys.has(field.key),
    onChange: handleFieldApprovalChange,
  });
  const fieldType = field.type === 'text' ? 'Text' : field.unit || 'Number';
  const typeLabel = createElement('small', { class: 'muted' }, ` · ${fieldType}`);
  const fieldLabel = createElement('span', {}, field.displayLabel || field.label, typeLabel);
  return createElement('label', { class: 'check' }, checkbox, fieldLabel);
}

function handleFieldApprovalChange(event) {
  const checkbox = event.currentTarget;
  if (checkbox.checked) {
    approvedFieldKeys.add(checkbox.value);
  } else {
    approvedFieldKeys.delete(checkbox.value);
  }
  updateCurationSummary();
  showUnsavedApprovalMessage();
}

function showUnsavedApprovalMessage() {
  showStatus(getElement('curation-status'), 'Unsaved field approval. Save to apply these changes.');
}

function approveVisibleFields() {
  changeVisibleFieldApproval(true);
}

function clearVisibleFields() {
  changeVisibleFieldApproval(false);
}

function changeVisibleFieldApproval(isApproved) {
  const visibleCheckboxes = getElement('curation-fields').querySelectorAll('input');
  for (const checkbox of visibleCheckboxes) {
    if (isApproved) {
      approvedFieldKeys.add(checkbox.value);
    } else {
      approvedFieldKeys.delete(checkbox.value);
    }
  }
  renderCurationFields();
  showUnsavedApprovalMessage();
}

async function loadFieldCuration() {
  if (!isAdmin) {
    return;
  }
  fieldCuration = await api(`/datasets/${datasetId}/curation`);
  approvedFieldKeys = new Set(fieldCuration.approvedFields);
  getElement('curation-panel').hidden = false;
  renderCurationFields();
}

async function loadDataset(nextOffset = previewOffset) {
  getElement('dataset-content').setAttribute('aria-busy', 'true');
  getElement('previous').disabled = true;
  getElement('next').disabled = true;
  getElement('retry').hidden = true;

  try {
    currentOverview = await api(`/datasets/${datasetId}?offset=${nextOffset}&limit=${PAGE_SIZE}`);
    previewOffset = nextOffset;
    renderDataset(currentOverview);
    showStatus(getElement('page-status'), '');
    getElement('dataset-content').hidden = false;
  } catch (error) {
    showStatus(getElement('page-status'), error.message, 'error');
    getElement('retry').hidden = false;
  } finally {
    getElement('dataset-content').setAttribute('aria-busy', 'false');
  }
}

function renderDataset({ dataset, indicators, preview }) {
  document.title = `${dataset.name} · Dataset overview`;
  getElement('dataset-heading').textContent = dataset.name;
  renderDatasetMetadata(dataset);
  renderDatasetActions(dataset);
  renderIndicators(indicators);
  renderDataPreview(dataset, indicators, preview);
}

function renderDatasetMetadata(dataset) {
  const metadata = [
    ['Source', dataset.source],
    ['Year or period', dataset.vintage],
    ['Version', dataset.version],
    ['Uploaded rows', dataset.rowCount.toLocaleString('en-US')],
    ['Uploaded by', dataset.uploadedBy],
    ['Uploaded', formatDate(dataset.uploadedAt)],
    ['Status', dataset.isActive ? 'Published' : 'Draft / archived'],
  ];
  for (const note of dataset.importNotes) {
    metadata.push(['Import note', note]);
  }

  const metadataContainer = getElement('dataset-metadata');
  metadataContainer.replaceChildren();
  for (const [label, value] of metadata) {
    const term = createElement('dt', {}, label);
    const description = createElement('dd', {}, value);
    metadataContainer.append(term, description);
  }
}

function renderDatasetActions(dataset) {
  const reportLink = getElement('make-report');
  reportLink.hidden = !dataset.isActive;
  reportLink.href = `/builder?dataset=${dataset.id}`;

  const exploreLink = getElement('explore-dataset');
  exploreLink.hidden = !dataset.isActive;
  exploreLink.href = `/explore?dataset=${dataset.id}`;

  const publishButton = getElement('toggle-active');
  publishButton.hidden = !isAdmin;
  publishButton.textContent = dataset.isActive ? 'Unpublish version' : 'Publish for exploration';
  publishButton.disabled = !dataset.isActive
    && (!dataset.curationReviewed || !dataset.approvedFields?.length);
}

function renderIndicators(indicators) {
  const tableBody = getElement('indicators-body');
  tableBody.replaceChildren();
  for (const indicator of indicators) {
    tableBody.append(createIndicatorRow(indicator));
  }
  if (!indicators.length) {
    const emptyCell = createElement('td', { colspan: 5 }, 'No stored indicator values.');
    tableBody.append(createElement('tr', {}, emptyCell));
  }
}

function createIndicatorRow(indicator) {
  const indicatorKey = createElement('code', {}, indicator.key);
  const rowHeading = createElement('th', { scope: 'row' }, indicatorKey);
  const isText = indicator.type === 'text';
  let derivation = 'Uploaded column';
  if (indicator.derivation === 'ratio') {
    derivation = `${indicator.numeratorKey} ÷ ${indicator.denominatorKey}`;
  } else if (isText) {
    derivation = 'Category / text';
  }

  const row = createElement('tr', {}, rowHeading);
  row.append(
    createElement('td', {}, indicator.label),
    createElement('td', {}, isText ? 'Text' : indicator.unit),
    createElement('td', {}, isText ? '—' : indicator.decimals),
    createElement('td', {}, derivation),
  );
  return row;
}

function renderDataPreview(dataset, indicators, preview) {
  const isRecordDataset = dataset.dataFormat === 'records';
  getElement('indicators-heading').textContent = isRecordDataset ? 'Dataset columns' : 'Dataset indicators';

  const table = createElement('table', { class: 'data' });
  const captionText = `${dataset.name}, ${dataset.vintage}, version ${dataset.version}`;
  table.append(createElement('caption', { class: 'sr-only' }, captionText));
  table.append(createPreviewHeader(isRecordDataset, indicators, preview.columns));
  table.append(createPreviewBody(isRecordDataset, preview));
  getElement('data-preview').replaceChildren(table);

  let summary = 'This dataset has no stored values to preview.';
  if (preview.total) {
    const firstRow = preview.rows.length ? previewOffset + 1 : 0;
    const lastRow = previewOffset + preview.rows.length;
    const rowType = isRecordDataset ? 'source records' : 'places with stored values';
    summary = `Rows ${firstRow}–${lastRow} of ${preview.total} ${rowType}. Unavailable values are shown as N/A.`;
  }
  getElement('preview-summary').textContent = summary;
  getElement('previous').disabled = previewOffset === 0;
  getElement('next').disabled = previewOffset + preview.rows.length >= preview.total;
}

function createPreviewHeader(isRecordDataset, indicators, columns) {
  const headingRow = createElement('tr');
  headingRow.append(createElement('th', { scope: 'col' }, isRecordDataset ? 'Source row' : 'Town'));

  if (isRecordDataset) {
    for (const column of columns) {
      headingRow.append(createElement('th', { scope: 'col' }, column.label));
    }
  } else {
    for (const indicator of indicators) {
      const suffix = indicator.derivation === 'ratio' ? ' (computed)' : '';
      headingRow.append(createElement('th', { scope: 'col', class: 'num' }, `${indicator.displayLabel}${suffix}`));
    }
  }
  return createElement('thead', {}, headingRow);
}

function createPreviewBody(isRecordDataset, preview) {
  const tableBody = createElement('tbody');
  for (const previewRow of preview.rows) {
    const rowLabel = isRecordDataset ? previewRow.sourceRow : previewRow.place.label;
    const rowHeading = createElement('th', { scope: 'row' }, rowLabel);
    const tableRow = createElement('tr', {}, rowHeading);

    for (const [columnIndex, cell] of previewRow.cells.entries()) {
      const isNumeric = !isRecordDataset || preview.columns[columnIndex].type === 'number';
      tableRow.append(createElement('td', { class: isNumeric ? 'num' : null }, cell.display));
    }
    tableBody.append(tableRow);
  }
  return tableBody;
}

function loadPreviousPage() {
  return loadDataset(Math.max(0, previewOffset - PAGE_SIZE));
}

function loadNextPage() {
  return loadDataset(previewOffset + PAGE_SIZE);
}

function reloadDataset() {
  return loadDataset();
}

async function togglePublishedStatus() {
  const publishButton = getElement('toggle-active');
  publishButton.disabled = true;
  try {
    const dataset = await api(`/datasets/${datasetId}`, {
      method: 'PATCH',
      json: { isActive: !currentOverview.dataset.isActive },
    });
    await loadDataset();
    const message = dataset.isActive
      ? 'This version is now available in Explore data.'
      : 'This version has been unpublished.';
    showStatus(getElement('dataset-status'), message, 'ok');
  } catch (error) {
    showStatus(getElement('dataset-status'), error.message, 'error');
  } finally {
    publishButton.disabled = false;
  }
}

async function saveFieldCuration() {
  const saveButton = getElement('save-curation');
  saveButton.disabled = true;
  try {
    fieldCuration = await api(`/datasets/${datasetId}/curation`, {
      method: 'PUT',
      json: { approvedFields: [...approvedFieldKeys] },
    });
    approvedFieldKeys = new Set(fieldCuration.approvedFields);
    renderCurationFields();
    await loadDataset();

    let message = 'No fields approved. This dataset is unpublished.';
    if (approvedFieldKeys.size) {
      const nextStep = currentOverview.dataset.isActive
        ? 'Exploration now uses this selection.'
        : 'Publish this version when your review is complete.';
      message = `Saved ${approvedFieldKeys.size} approved fields. ${nextStep}`;
    }
    showStatus(getElement('curation-status'), message, 'ok');
  } catch (error) {
    showStatus(getElement('curation-status'), error.message, 'error');
  } finally {
    saveButton.disabled = false;
  }
}

boot(initializeDatasetPage);
