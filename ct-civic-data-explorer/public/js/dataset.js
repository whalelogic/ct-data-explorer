import { api, loadSession } from './api.js';
import { h as createElement } from './dom.js';
import { mountDatasetPresentation } from './dataset-presentation.js';
import { mountIndicatorEditor } from './indicator-editor.js';
import { boot, formatDate, renderHeader, showStatus } from './layout.js';
import { unitLabel } from '/shared/format.js';

const PAGE_SIZE = 25;

let datasetId;
let isAdmin = false;
let currentOverview;
let previewOffset = 0;
let fieldCuration;
let approvedFieldKeys = new Set();
let indicatorEditorMounted = false;

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
  await mountDatasetPresentation(getElement('dataset-presentation'), datasetId, async () => {
    await loadDataset();
    await loadFieldCuration({ preserveDraft: true });
  });
}

function initializeAdminControls() {
  getElement('curation-search').addEventListener('input', renderCurationFields);
  getElement('approve-visible').addEventListener('click', approveVisibleFields);
  getElement('clear-visible').addEventListener('click', clearVisibleFields);
  getElement('save-curation').addEventListener('click', saveFieldCuration);
}

function updateCurationSummary() {
  const savedFieldKeys = fieldCuration.approvedFields;
  const hasUnsavedChanges = approvedFieldKeys.size !== savedFieldKeys.length
    || savedFieldKeys.some((fieldKey) => !approvedFieldKeys.has(fieldKey));
  const state = hasUnsavedChanges ? 'Unsaved' : fieldCuration.curationReviewed ? 'Approved' : 'Review pending';
  getElement('curation-summary').textContent = `${approvedFieldKeys.size} / ${fieldCuration.fields.length} selected · ${state}`;
  getElement('save-curation').disabled = fieldCuration.curationReviewed && !hasUnsavedChanges;

  if (currentOverview && !currentOverview.dataset.isActive) {
    getElement('toggle-active').disabled = hasUnsavedChanges
      || !fieldCuration.curationReviewed
      || approvedFieldKeys.size === 0;
    getElement('toggle-active').title = hasUnsavedChanges ? 'Save field approval first.'
      : !fieldCuration.curationReviewed || !approvedFieldKeys.size ? 'Approve fields in the Fields tab first.' : '';
  }
}

function renderCurationFields() {
  const searchText = getElement('curation-search').value.trim().toLowerCase();
  const fieldsContainer = getElement('curation-fields');
  fieldsContainer.replaceChildren();

  for (const field of fieldCuration.fields) {
    const searchableText = `${field.displayLabel || ''} ${field.label} ${field.key} ${field.unit}`.toLowerCase();
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
  const fieldType = field.type === 'text' ? 'Text' : `Number${field.unit && field.unit !== 'number' ? ` · ${unitLabel(field.unit)}` : ''}`;
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
  showStatus(getElement('curation-status'), 'Unsaved approval.');
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

async function loadFieldCuration({ preserveDraft = false } = {}) {
  if (!isAdmin) {
    return;
  }
  const hasDraft = preserveDraft && fieldCuration
    && (approvedFieldKeys.size !== fieldCuration.approvedFields.length
      || fieldCuration.approvedFields.some((key) => !approvedFieldKeys.has(key)));
  fieldCuration = await api(`/datasets/${datasetId}/curation`);
  const available = new Set(fieldCuration.fields.map((field) => field.key));
  approvedFieldKeys = hasDraft
    ? new Set([...approvedFieldKeys].filter((key) => available.has(key)))
    : new Set(fieldCuration.approvedFields);
  getElement('curation-panel').hidden = false;
  getElement('field-metadata').hidden = true;
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
  document.title = `${dataset.displayName || dataset.name} · Dataset`;
  getElement('dataset-heading').textContent = dataset.displayName || dataset.name;
  renderDatasetSummary(dataset, indicators, preview);
  renderDatasetMetadata(dataset);
  renderDatasetActions(dataset);
  renderIndicators(indicators);
  renderDataPreview(dataset, indicators, preview);
  const canDefineIndicators = isAdmin && dataset.dataFormat !== 'records';
  getElement('indicator-setup').hidden = !canDefineIndicators;
  if (canDefineIndicators && !indicatorEditorMounted) {
    mountIndicatorEditor(getElement('dataset-indicator-editor'), 'dataset-indicator', reloadDataset);
    indicatorEditorMounted = true;
  }
}

function renderDatasetSummary(dataset, indicators, preview) {
  const fieldCount = dataset.dataFormat === 'records' ? preview.columns.length : indicators.length + 1;
  const summary = [
    ['Source', dataset.source],
    ['Period', dataset.vintage],
    ['Rows', `${preview.total.toLocaleString('en-US')} ${preview.total === 1 ? 'row' : 'rows'}`],
    ['Fields', `${fieldCount.toLocaleString('en-US')} ${fieldCount === 1 ? 'field' : 'fields'}`],
  ];
  const container = getElement('dataset-summary');
  container.replaceChildren(...summary.map(([label, value]) => createElement('div', {},
    createElement('dt', { class: ['Rows', 'Fields'].includes(label) ? 'sr-only' : null }, label), createElement('dd', {}, value))));
  container.hidden = false;
}

function renderDatasetMetadata(dataset) {
  const metadata = [
    ['Source dataset', dataset.name],
    ...(dataset.description ? [['Description', dataset.description]] : []),
    ['Version', dataset.version],
    ['Uploaded by', dataset.uploadedBy],
    ['Uploaded', formatDate(dataset.uploadedAt)],
  ];
  getElement('dataset-notes').hidden = dataset.importNotes.length === 0;
  getElement('dataset-note-list').replaceChildren(...dataset.importNotes.map((note) => createElement('li', {}, note)));

  const metadataContainer = getElement('dataset-metadata');
  metadataContainer.replaceChildren();
  for (const [label, value] of metadata) {
    const term = createElement('dt', {}, label);
    const description = createElement('dd', {}, value);
    metadataContainer.append(term, description);
  }
  getElement('dataset-details').hidden = false;
}

function renderDatasetActions(dataset) {
  getElement('dataset-actions').hidden = false;
  getElement('publish-state').textContent = dataset.isActive ? 'Published'
    : !dataset.curationReviewed || !dataset.approvedFields?.length ? 'Unpublished · Review fields' : 'Unpublished';
  const reportLink = getElement('make-report');
  reportLink.hidden = !dataset.isActive;
  reportLink.href = `/builder?dataset=${dataset.id}`;

  const exploreLink = getElement('explore-dataset');
  exploreLink.hidden = !dataset.isActive;
  exploreLink.href = `/explore?dataset=${dataset.id}`;

  const publishButton = getElement('toggle-active');
  publishButton.hidden = !isAdmin;
  publishButton.textContent = dataset.isActive ? 'Unpublish' : 'Publish';
  publishButton.disabled = !dataset.isActive
    && (!dataset.curationReviewed || !dataset.approvedFields?.length);
  publishButton.title = publishButton.disabled ? 'Approve fields in the Fields tab first.' : '';
}

function renderIndicators(indicators) {
  const tableBody = getElement('indicators-body');
  tableBody.replaceChildren();
  for (const indicator of indicators) {
    tableBody.append(createIndicatorRow(indicator));
  }
  if (!indicators.length) {
    const emptyCell = createElement('td', { colspan: 4 }, 'No fields.');
    tableBody.append(createElement('tr', {}, emptyCell));
  }
}

function createIndicatorRow(indicator) {
  const rowHeading = createElement('th', { scope: 'row' }, indicator.displayLabel || indicator.label);
  const isText = indicator.type === 'text';
  const row = createElement('tr', {}, rowHeading);
  row.append(
    createElement('td', {}, isText ? 'Text' : 'Number'),
    createElement('td', {}, isText || !indicator.unit || indicator.unit === 'number' ? '—' : unitLabel(indicator.unit)),
    createElement('td', {}, isText ? '—' : indicator.decimals),
  );
  return row;
}

function renderDataPreview(dataset, indicators, preview) {
  const isRecordDataset = dataset.dataFormat === 'records';
  const table = createElement('table', { class: 'data' });
  const captionText = `${dataset.name}, ${dataset.vintage}, version ${dataset.version}`;
  table.append(createElement('caption', { class: 'sr-only' }, captionText));
  table.append(createPreviewHeader(isRecordDataset, indicators, preview.columns));
  table.append(createPreviewBody(isRecordDataset, preview));
  getElement('data-preview').replaceChildren(table);

  let summary = 'No rows.';
  if (preview.total) {
    const firstRow = preview.rows.length ? previewOffset + 1 : 0;
    const lastRow = previewOffset + preview.rows.length;
    summary = `Rows ${firstRow}–${lastRow} of ${preview.total}`;
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
      const label = column.displayLabel || column.label;
      const unit = column.type === 'number' && column.unit && column.unit !== 'number' ? ` (${unitLabel(column.unit)})` : '';
      headingRow.append(createElement('th', { scope: 'col' }, `${label}${unit}`));
    }
  } else {
    for (const indicator of indicators) {
      const unit = indicator.unit && indicator.unit !== 'number' ? ` (${unitLabel(indicator.unit)})` : '';
      headingRow.append(createElement('th', { scope: 'col', class: 'num' }, `${indicator.displayLabel || indicator.label}${unit}`));
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
    const message = dataset.isActive ? 'Published.' : 'Unpublished.';
    showStatus(getElement('dataset-status'), message, 'ok');
  } catch (error) {
    showStatus(getElement('dataset-status'), error.message, 'error');
  } finally {
    renderDatasetActions(currentOverview.dataset);
    if (fieldCuration) updateCurationSummary();
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

    let message = 'No approved fields · Unpublished.';
    if (approvedFieldKeys.size) {
      message = `${approvedFieldKeys.size} fields approved.`;
    }
    showStatus(getElement('curation-status'), message, 'ok');
  } catch (error) {
    showStatus(getElement('curation-status'), error.message, 'error');
  } finally {
    updateCurationSummary();
  }
}

boot(initializeDatasetPage);
