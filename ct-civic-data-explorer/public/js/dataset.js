/**
 * Dataset page: a compact summary, then tabs.
 *   Data      the rows themselves (default for everyone)
 *   Fields    what a report can use
 *   Settings  the setup steps in order: choose fields → default comparison →
 *             names and display (optional) → publish. Approval and publishing are admin-only.
 */
import { api, loadSession } from './api.js';
import { h as createElement } from './dom.js';
import { mountDatasetPresentation } from './dataset-presentation.js';
import { mountIndicatorEditor } from './indicator-editor.js';
import { boot, formatDate, renderHeader, showStatus } from './layout.js';
import { mountTabs } from './tabs.js';
import { renderShapePanel } from './data-shape.js';
import { fieldUnitLabel } from '/shared/field-groups.js';

const PAGE_SIZE = 25;
/** Field lists longer than this get a "Find a field" box. */
const SEARCHABLE_FIELD_COUNT = 8;

let datasetId;
let isAdmin = false;
let currentOverview;
let previewOffset = 0;
let fieldCuration;
let approvedFieldKeys = new Set();
let tabs;

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
  getElement('finish-setup').addEventListener('click', openSettings);
  getElement('row-label-approve-link').addEventListener('click', (event) => {
    event.preventDefault();
    getElement('step-approve').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  getElement('save-row-label').addEventListener('click', saveRowLabel);
  getElement('row-label-select').addEventListener('change', (event) => {
    getElement('save-row-label').disabled = event.target.value === event.target.dataset.saved;
  });

  // Everyone may rename fields and set the default comparison; approval and publishing are admin-only.
  getElement('tab-settings').hidden = false;
  getElement('step-approve').hidden = !isAdmin;
  getElement('step-publish').hidden = !isAdmin;
  if (isAdmin) {
    initializeAdminControls();
  }

  await loadDataset();
  tabs = mountTabs(document.querySelector('.page-tabs'), { fallback: 'data' });
  await loadFieldCuration();
  await loadRowLabel();
  await mountDatasetPresentation(getElement('dataset-presentation'), datasetId, async () => {
    await loadDataset();
    await loadRowLabel();
    await loadFieldCuration();
  });
}

function openSettings(event) {
  event.preventDefault();
  tabs.select('settings', { focus: true });
}

// ---- Summary and actions --------------------------------------------------------------------

/**
 * Fields a report may use. Administrators are sent every column, so count the saved
 * approval; datasets reviewed before approval existed (null) offer every column.
 */
function isUsableField(field) {
  const approved = currentOverview?.dataset.approvedFields;
  return approved == null || approved.includes(field.key);
}

function approvedFieldCount() {
  return currentOverview?.indicators.filter(isUsableField).length ?? 0;
}

function renderDatasetHeader(dataset) {
  const title = dataset.displayName || dataset.name;
  document.title = `${title} · CT Civic Data Explorer`;
  getElement('dataset-heading').textContent = title;

  const fieldCount = approvedFieldCount();
  const parts = [
    dataset.source,
    dataset.vintage,
    `${dataset.rowCount.toLocaleString('en-US')} ${dataset.rowCount === 1 ? 'row' : 'rows'}`,
    `${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}`,
  ];
  if (isAdmin) {
    parts.push(`version ${dataset.version}`);
  }
  const status = createElement('span', { class: dataset.isActive ? 'tag active' : 'tag' }, dataset.isActive ? 'Published' : 'Draft');
  getElement('dataset-summary').replaceChildren(parts.filter(Boolean).join(' · '), ' ', status);

  const description = getElement('dataset-description');
  description.textContent = dataset.description;
  description.hidden = !dataset.description;

  const canReport = dataset.isActive && fieldCount > 0;
  const reportLink = getElement('make-report');
  reportLink.hidden = !canReport;
  reportLink.href = `/builder?dataset=${dataset.id}`;
  getElement('finish-setup').hidden = !isAdmin || dataset.isActive;
  const badge = getElement('settings-badge');
  badge.hidden = !isAdmin || dataset.isActive;
  badge.textContent = 'Needs setup';
}

function renderUploadNotes(dataset) {
  const list = getElement('import-notes-list');
  const uploader = dataset.uploadedBy ? ` by ${dataset.uploadedBy}` : '';
  list.replaceChildren(createElement('li', {}, `Uploaded ${formatDate(dataset.uploadedAt)}${uploader}.`));
  for (const note of dataset.importNotes) {
    list.append(createElement('li', {}, note));
  }
  getElement('import-notes').hidden = false;
  getElement('import-notes').querySelector('summary').textContent = 'About this upload';
}

// ---- Fields tab -----------------------------------------------------------------------------

function renderFieldCards(indicators) {
  const container = getElement('field-cards');
  container.replaceChildren();
  // Usable fields first; administrators also see hidden columns, marked as such.
  const ordered = [...indicators].sort((first, second) => Number(isUsableField(second)) - Number(isUsableField(first)));
  for (const field of ordered) {
    const isUsable = isUsableField(field);
    const card = createElement('div', { class: isUsable ? 'field-card' : 'field-card is-hidden' });
    let kind = fieldUnitLabel(field);
    if (!isUsable) {
      kind = `${kind} · hidden from reports`;
    }
    if (field.derivation === 'ratio') {
      kind = `${kind} · calculated as ${field.numeratorKey} ÷ ${field.denominatorKey}`;
    }
    card.append(
      createElement('span', { class: 'field-choice-name' }, field.displayLabel || field.label),
      createElement('span', { class: 'field-choice-meta' }, kind),
    );
    if (field.description) {
      card.append(createElement('span', { class: 'field-card-description' }, field.description));
    }
    container.append(card);
  }
  const empty = getElement('fields-empty');
  empty.hidden = ordered.some(isUsableField);
  empty.textContent = isAdmin ? 'No fields are approved yet. Choose them in Settings.' : 'No fields are available yet.';
  renderUnapprovedNote();
}

function renderUnapprovedNote() {
  const note = getElement('unapproved-note');
  if (!isAdmin || !fieldCuration) {
    note.hidden = true;
    return;
  }
  const hiddenCount = fieldCuration.fields.length - fieldCuration.approvedFields.length;
  note.hidden = hiddenCount <= 0;
  note.textContent = `${hiddenCount} ${hiddenCount === 1 ? 'column is' : 'columns are'} hidden from reports. Change this in Settings.`;
}

// ---- Settings: default comparison -----------------------------------------------------------

/**
 * Source-row datasets can compare by any identifier column or approved text field.
 * With only one candidate there is nothing to choose, so the step just states it.
 */
async function loadRowLabel() {
  let settings;
  try {
    settings = await api(`/datasets/${datasetId}/row-label`);
  } catch {
    getElement('row-label-panel').hidden = true;
    return;
  }
  getElement('row-label-panel').hidden = !settings.canChange;
  const current = settings.candidates.find((candidate) => candidate.key === settings.rowLabelKey);
  const description = current?.isTown ? ' (Connecticut towns, counties and planning regions)' : '';
  getElement('row-label-current').replaceChildren(
    'Reports start by comparing ',
    createElement('strong', {}, current?.label ?? 'each spreadsheet row'),
    `${description}.`,
  );

  const canChoose = settings.candidates.length > 1;
  getElement('row-label-only').hidden = canChoose || !isAdmin;
  getElement('row-label-change').hidden = !canChoose;
  const select = getElement('row-label-select');
  select.replaceChildren();
  for (const candidate of settings.candidates) {
    const label = candidate.isTown ? `${candidate.label} (Connecticut places)` : candidate.label;
    select.append(createElement('option', { value: candidate.key }, label));
  }
  select.value = settings.rowLabelKey ?? '';
  select.dataset.saved = select.value;
  getElement('save-row-label').disabled = true;
}

async function saveRowLabel() {
  const status = getElement('row-label-status');
  const button = getElement('save-row-label');
  button.disabled = true;
  try {
    const settings = await api(`/datasets/${datasetId}/row-label`, {
      method: 'PUT',
      json: { rowLabelKey: getElement('row-label-select').value },
    });
    const chosen = settings.candidates.find((candidate) => candidate.key === settings.rowLabelKey);
    showStatus(status, `New reports will compare ${chosen?.label ?? 'the chosen column'}.`, 'ok');
    await loadDataset();
    await loadRowLabel();
  } catch (error) {
    showStatus(status, error.message, 'error');
    button.disabled = false;
  }
}

// ---- Settings: choose fields (admin) --------------------------------------------------------

function initializeAdminControls() {
  getElement('indicator-setup').hidden = false;
  mountIndicatorEditor(getElement('dataset-indicator-editor'), 'dataset-indicator', reloadDataset);
  getElement('curation-search').addEventListener('input', renderCurationFields);
  getElement('approve-visible').addEventListener('click', approveVisibleFields);
  getElement('clear-visible').addEventListener('click', clearVisibleFields);
  getElement('save-curation').addEventListener('click', saveFieldCuration);
}

function hasUnsavedApproval() {
  const saved = fieldCuration.approvedFields;
  return approvedFieldKeys.size !== saved.length || saved.some((key) => !approvedFieldKeys.has(key));
}

function updateCurationSummary() {
  getElement('curation-summary').textContent = `${approvedFieldKeys.size} of ${fieldCuration.fields.length} selected`;
  getElement('approve-visible').disabled = approvedFieldKeys.size === fieldCuration.fields.length;
  getElement('clear-visible').disabled = approvedFieldKeys.size === 0;
  getElement('save-curation').disabled = !hasUnsavedApproval() && fieldCuration.curationReviewed;
  const isDone = fieldCuration.curationReviewed && fieldCuration.approvedFields.length > 0 && !hasUnsavedApproval();
  getElement('step-approve').querySelector('.setup-done').hidden = !isDone;
  getElement('step-approve').classList.toggle('is-done', isDone);
  renderPublishStep();
}

function renderCurationFields() {
  const search = getElement('curation-search');
  search.hidden = fieldCuration.fields.length <= SEARCHABLE_FIELD_COUNT;
  if (search.hidden) {
    search.value = '';
  }
  const searchText = search.value.trim().toLowerCase();
  const fieldsContainer = getElement('curation-fields');
  fieldsContainer.replaceChildren();

  for (const field of fieldCuration.fields) {
    const searchableText = `${field.displayLabel || field.label} ${field.key} ${fieldUnitLabel(field)}`.toLowerCase();
    if (searchableText.includes(searchText)) {
      fieldsContainer.append(createCurationField(field));
    }
  }

  if (!fieldsContainer.children.length) {
    const message = fieldCuration.fields.length ? 'No matching fields.' : 'This dataset has no columns to approve.';
    fieldsContainer.append(createElement('p', { class: 'muted' }, message));
  }
  updateCurationSummary();
}

function createCurationField(field) {
  const inputId = `approve-${field.key}`;
  const checkbox = createElement('input', {
    type: 'checkbox',
    id: inputId,
    value: field.key,
    checked: approvedFieldKeys.has(field.key),
    onChange: handleFieldApprovalChange,
  });
  const copy = createElement('span', { class: 'field-copy' },
    createElement('span', { class: 'field-choice-name' }, field.displayLabel || field.label),
    createElement('span', { class: 'field-choice-meta' }, fieldUnitLabel(field)),
  );
  return createElement('label', { class: 'field-choice', for: inputId }, checkbox, copy);
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
  const message = hasUnsavedApproval() ? 'Not saved yet. Select Save field choices to apply them.' : '';
  showStatus(getElement('curation-status'), message);
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
  renderCurationFields();
  renderUnapprovedNote();
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
    await loadDataset();
    renderCurationFields();
    await loadRowLabel();

    let message = 'No fields chosen, so this dataset is not published.';
    if (approvedFieldKeys.size) {
      const nextStep = currentOverview.dataset.isActive
        ? 'Reports now use these fields.'
        : 'Next: publish it below.';
      message = `Saved ${approvedFieldKeys.size} ${approvedFieldKeys.size === 1 ? 'field' : 'fields'}. ${nextStep}`;
    }
    showStatus(getElement('curation-status'), message, 'ok');
  } catch (error) {
    showStatus(getElement('curation-status'), error.message, 'error');
    saveButton.disabled = false;
  }
}

// ---- Settings: publish (admin) --------------------------------------------------------------

/** Publish stays disabled until fields are chosen and saved, and says why. */
function renderPublishStep() {
  if (!isAdmin || !currentOverview) {
    return;
  }
  const { dataset } = currentOverview;
  const button = getElement('toggle-active');
  const explainer = getElement('publish-explainer');
  const step = getElement('step-publish');
  const isReady = fieldCuration?.curationReviewed && fieldCuration.approvedFields.length > 0 && !hasUnsavedApproval();

  step.querySelector('.setup-done').hidden = !dataset.isActive;
  step.classList.toggle('is-done', dataset.isActive);
  if (dataset.isActive) {
    explainer.textContent = 'This version is published. Everyone can use it in reports.';
    button.textContent = 'Unpublish';
    button.className = 'secondary';
    button.disabled = false;
  } else if (isReady) {
    explainer.textContent = 'Everything is ready. Publishing makes this dataset available to everyone for reports.';
    button.textContent = 'Publish';
    button.className = '';
    button.disabled = false;
  } else {
    explainer.textContent = fieldCuration && hasUnsavedApproval()
      ? 'Save your field choices first, then publish.'
      : 'Choose at least one field and save, then publish.';
    button.textContent = 'Publish';
    button.className = '';
    button.disabled = true;
  }
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
      ? 'Published. People can now create reports with this data.'
      : 'Unpublished. This version is no longer available for new reports.';
    showStatus(getElement('dataset-status'), message, 'ok');
  } catch (error) {
    showStatus(getElement('dataset-status'), error.message, 'error');
  } finally {
    renderPublishStep();
  }
}

// ---- Data tab -------------------------------------------------------------------------------

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

function renderDataset({ dataset, shape, indicators, preview }) {
  renderDatasetHeader(dataset);
  renderShapePanel(getElement('data-shape'), {
    shape,
    fields: indicators.filter(isUsableField),
    emptyFieldsText: isAdmin ? 'Choose which columns reports may use in Settings.' : 'No columns are available yet.',
  });
  renderFieldCards(indicators);
  renderDataPreview(dataset, shape, indicators, preview);
  renderUploadNotes(dataset);
  renderPublishStep();
}

/**
 * The preview leads with the column that names each row, highlighted as "Rows", then one
 * column per field with its type underneath. Admins also see hidden columns, marked.
 */
function renderDataPreview(dataset, shape, indicators, preview) {
  const isRecordDataset = dataset.dataFormat === 'records';
  const columns = previewColumns(isRecordDataset, shape, indicators, preview);
  const table = createElement('table', { class: 'data shape-table' });
  const captionText = `${dataset.name}, ${dataset.vintage}, version ${dataset.version}`;
  table.append(createElement('caption', { class: 'sr-only' }, captionText));
  const headingRow = createElement('tr');
  for (const column of columns) {
    headingRow.append(createPreviewHeading(column));
  }
  table.append(createElement('thead', {}, headingRow));

  const tableBody = createElement('tbody');
  for (const previewRow of preview.rows) {
    const tableRow = createElement('tr');
    for (const column of columns) {
      const content = column.cell(previewRow);
      const attributes = { class: [column.isNumeric ? 'num' : '', column.isHidden ? 'is-hidden-column' : ''].join(' ').trim() || null };
      tableRow.append(column.isRowLabel ? createElement('th', { scope: 'row', ...attributes }, content) : createElement('td', attributes, content));
    }
    tableBody.append(tableRow);
  }
  table.append(tableBody);
  getElement('data-preview').replaceChildren(table);

  let summary = 'This dataset has no rows to show.';
  if (preview.total) {
    const firstRow = preview.rows.length ? previewOffset + 1 : 0;
    const lastRow = previewOffset + preview.rows.length;
    summary = `Showing rows ${firstRow}–${lastRow} of ${preview.total.toLocaleString('en-US')}. Blank values are shown as N/A.`;
  }
  getElement('preview-summary').textContent = summary;
  getElement('previous').disabled = previewOffset === 0;
  getElement('next').disabled = previewOffset + preview.rows.length >= preview.total;
}

/** Column descriptors: heading text, a type caption, and how to read each row's cell. */
function previewColumns(isRecordDataset, shape, indicators, preview) {
  if (!isRecordDataset) {
    const rowLabel = { label: 'Place', caption: 'Rows', isRowLabel: true, cell: (row) => row.place.label };
    return [rowLabel, ...indicators.map((indicator, index) => ({
      label: indicator.derivation === 'ratio' ? `${indicator.displayLabel} (calculated)` : indicator.displayLabel,
      caption: fieldUnitLabel(indicator),
      isNumeric: true,
      isHidden: !isUsableField(indicator),
      cell: (row) => row.cells[index].display,
    }))];
  }
  const descriptors = preview.columns.map((column, index) => ({
    key: column.key,
    label: column.displayLabel || column.label,
    caption: fieldUnitLabel(column),
    isNumeric: column.type === 'number',
    isHidden: column.key !== shape.rowColumn?.key && !isUsableField(column),
    cell: (row) => row.cells[index].display,
  }));
  const labelIndex = descriptors.findIndex((column) => column.key === shape.rowColumn?.key);
  if (labelIndex === -1) {
    // Without a label column, rows are known by their spreadsheet row number.
    return [{ label: 'Row', caption: 'Rows', isRowLabel: true, cell: (row) => `Row ${row.sourceRow}` }, ...descriptors];
  }
  const [labelColumn] = descriptors.splice(labelIndex, 1);
  return [{ ...labelColumn, caption: 'Rows', isNumeric: false, isHidden: false, isRowLabel: true }, ...descriptors];
}

function createPreviewHeading(column) {
  const classes = [column.isNumeric ? 'num' : '', column.isRowLabel ? 'is-row-label' : '', column.isHidden ? 'is-hidden-column' : ''];
  const caption = column.isHidden ? `${column.caption} · hidden` : column.caption;
  return createElement('th', { scope: 'col', class: classes.join(' ').trim() || null },
    createElement('span', { class: 'column-name' }, column.label),
    createElement('span', { class: 'column-type' }, caption));
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

boot(initializeDatasetPage);
