/**
 * Report builder. One selection object is shared by the preview, PDF, summary and save APIs;
 * every control in the four tabs (Data, Fields, Content, Title & style) updates that object.
 */
import { fieldUnitLabel, groupFieldsByUnit } from '/shared/field-groups.js';
import { resolveReportStyle } from '/shared/report-style.js';
import { mountReportStyleEditor } from './report-style-editor.js';
import { api, loadSession } from './api.js';
import { clearReport, renderReport } from './report-view.js';
import { setAssistantApply, setAssistantContext, takePendingProposal } from './assistant.js';
import { h as createElement } from './dom.js';
import { boot, debounce, downloadBlob, renderHeader, showStatus } from './layout.js';

const BLOCK_NAMES = { text: 'Text', chart: 'Chart', table: 'Table' };
const CHART_TYPES = [
  { value: 'grouped_bar', label: 'Grouped bars' },
  { value: 'bar', label: 'One chart per field' },
  { value: 'line', label: 'Lines' },
];
/** Grouped fields whose largest values differ by more than this are hard to read together. */
const RANGE_WARNING_FACTOR = 20;
const TAB_NAMES = ['data', 'fields', 'content', 'style'];
const RATIO_UNITS = { ratio: 'ratio', percent: 'percent', per_1000: 'per_1000' };
const RATIO_SYMBOLS = { ratio: '', percent: ' × 100', per_1000: ' × 1,000' };

let styleEditor;
let currentUser = null;
let activeDatasets = [];
let datasetOptions = [];
/** What the report can compare (towns, counties, a column such as Program), with their values. */
let compareOptions = [];
let defaultCompare = null;
let hasStatewideRow = false;
let availableRows = [];
let rowNoun = 'Town';
/** Lists longer than this get a "Find in this list" box. */
const SEARCHABLE_ROW_COUNT = 12;
/** Mirrors MAX_NAMED_ROWS on the server; longer lists are sent as "all rows". */
const MAX_NAMED_ROWS = 2000;
/** Field lists longer than this get a "Find a field" box and unit headings. */
const SEARCHABLE_FIELD_COUNT = 8;
let availableIndicators = [];
let indicatorsByKey = new Map();
let savedReport = null;
let reportSelection = null;
let optionsRequestNumber = 0;
let previewRequestNumber = 0;
let isLoadingOptions = false;
let defaultChartType = 'grouped_bar';
let lastPreviewReport = null;
let savedSnapshot = '';
// Blocks whose editors are open. Holds block objects, so it survives reordering.
const expandedBlocks = new Set();
// Fields whose "rename for this report" panel is open.
const openOverrideKeys = new Set();

const schedulePreview = debounce(refreshPreview, 300);

function getElement(id) {
  return document.getElementById(id);
}

function isSameDataset(firstDataset, secondDataset) {
  return firstDataset.name === secondDataset.name && firstDataset.vintage === secondDataset.vintage;
}

async function initializeBuilder() {
  const session = await loadSession();
  currentUser = session.user;
  renderHeader(currentUser);

  const datasets = await api('/datasets');
  activeDatasets = datasets.filter((dataset) => dataset.isActive);
  await loadInitialSelection();
  // A report the assistant set up on another page, for this dataset.
  const pending = takePendingProposal();
  if (pending && !savedReport && activeDatasets.some((dataset) => dataset.id === pending.datasetId)) {
    reportSelection = assistantSelection(pending.selection);
  }

  renderDatasetOptions();
  fillFormControls();
  getElement('draft-summary').hidden = !session.features.aiSummary;
  updateHeading();

  await loadDatasetColumns();
  styleEditor = mountReportStyleEditor(getElement('report-style'), {
    prefix: 'report-style',
    overrides: true,
    onChange: handleStyleChange,
  });
  updateStyleEditor();
  // Blocks that start with no content open, so new reports show their settings.
  for (const block of reportSelection.layout) {
    if (!savedReport) {
      expandedBlocks.add(block);
    }
  }
  renderFields();
  renderLayout();
  registerEventHandlers();
  selectTab(chooseInitialTab(), { focus: false });
  updateTabCounts();
  savedSnapshot = createSnapshot();
  updateSaveState();
  setAssistantContext(() => ({
    page: 'builder',
    datasetId: findSelectedDataset()?.id,
    selection: {
      compareBy: reportSelection.compareBy,
      rows: reportSelection.rows.slice(0, 200),
      allRows: reportSelection.allRows,
      indicators: reportSelection.indicators.slice(0, 50),
    },
  }));
  setAssistantApply(applyAssistantProposal);
  await refreshPreview();
}

/** A selection from the assistant, with the builder's per-report settings filled in. */
function assistantSelection(selection) {
  return {
    ...selection,
    fieldOverrides: selection.fieldOverrides ?? {},
    styleOverrides: selection.styleOverrides ?? {},
    recordFilters: selection.recordFilters ?? {},
    customIndicators: selection.customIndicators ?? [],
    rows: selection.rows ?? [],
  };
}

/** Replace the report being built with the assistant's proposal; the report name and save state stay. */
async function applyAssistantProposal(proposal) {
  reportSelection = assistantSelection(proposal.selection);
  renderDatasetOptions();
  fillFormControls();
  getElement('report-name').value = savedReport?.title ?? '';
  await loadDatasetColumns();
  expandedBlocks.clear();
  updateStyleEditor();
  renderFields();
  renderLayout();
  selectTab('fields', { focus: false });
  selectionChanged();
}

async function loadInitialSelection() {
  const queryParameters = new URLSearchParams(location.search);
  const requestedDataset = activeDatasets.find((dataset) => String(dataset.id) === queryParameters.get('dataset'));
  const initialDataset = requestedDataset ?? activeDatasets[0];

  if (queryParameters.has('dataset') && !requestedDataset && !queryParameters.has('report')) {
    throw new Error('This dataset is no longer active. Choose another dataset from the dashboard.');
  }

  if (initialDataset) {
    defaultChartType = initialDataset.defaultChartType || 'grouped_bar';
  }
  reportSelection = {
    dataset: null,
    rows: [],
    allRows: false,
    // Statewide totals dwarf town values on count charts, so comparison is opt-in.
    benchmark: false,
    indicators: [],
    showTitle: true,
    title: '',
    subtitle: '',
    layout: [createBlock('chart'), createBlock('table')],
    recordFilters: {},
    fieldOverrides: {},
    styleOverrides: {},
  };

  if (initialDataset) {
    reportSelection.dataset = { name: initialDataset.name, vintage: initialDataset.vintage };
  }
  if (queryParameters.get('town')) {
    reportSelection.rows = [queryParameters.get('town')];
  }
  if (queryParameters.has('report')) {
    const reportId = encodeURIComponent(queryParameters.get('report'));
    const report = await api(`/reports/${reportId}`);
    savedReport = { id: report.id, ownerId: report.createdBy.id, title: report.title, viewUrl: report.viewUrl };
    reportSelection = { ...reportSelection, ...report.selection };
  }
  reportSelection.fieldOverrides ??= {};
  reportSelection.styleOverrides ??= {};
  reportSelection.customIndicators ??= [];
  reportSelection.rows ??= [];
  reportSelection.recordFilters ??= {};
}

function chooseInitialTab() {
  if (!reportSelection.allRows && reportSelection.rows.length === 0) {
    return 'data';
  }
  if (reportSelection.indicators.length === 0) {
    return 'fields';
  }
  return 'content';
}

function renderDatasetOptions() {
  datasetOptions = [];
  for (const dataset of activeDatasets) {
    datasetOptions.push({
      name: dataset.name,
      vintage: dataset.vintage,
      label: `${dataset.displayName || dataset.name}, ${dataset.vintage}`,
    });
  }

  const selectedDataset = reportSelection.dataset;
  const hasSelectedDataset = selectedDataset && datasetOptions.some((option) => isSameDataset(option, selectedDataset));
  if (selectedDataset && !hasSelectedDataset) {
    // Saved reports may refer to a dataset version that is no longer active.
    datasetOptions.push({
      ...selectedDataset,
      label: `${selectedDataset.name}, ${selectedDataset.vintage} (no active version)`,
    });
  }

  const datasetSelect = getElement('dataset');
  datasetSelect.replaceChildren();
  let selectedIndex = 0;
  for (const [index, option] of datasetOptions.entries()) {
    datasetSelect.append(createElement('option', { value: String(index) }, option.label));
    if (selectedDataset && isSameDataset(option, selectedDataset)) {
      selectedIndex = index;
    }
  }
  datasetSelect.value = String(selectedIndex);
  datasetSelect.disabled = datasetOptions.length === 0;
}

function fillFormControls() {
  getElement('benchmark').checked = reportSelection.benchmark;
  getElement('show-title').checked = reportSelection.showTitle;
  getElement('title').value = reportSelection.title;
  getElement('subtitle').value = reportSelection.subtitle;
  getElement('report-name').value = savedReport?.title ?? '';
}

function readFormControls() {
  const selectedOption = datasetOptions[Number(getElement('dataset').value)];
  reportSelection.dataset = null;
  if (selectedOption) {
    reportSelection.dataset = { name: selectedOption.name, vintage: selectedOption.vintage };
  }

  reportSelection.benchmark = getElement('benchmark').checked;
  reportSelection.showTitle = getElement('show-title').checked;
  reportSelection.title = getElement('title').value;
  reportSelection.subtitle = getElement('subtitle').value;
  const filterEntries = [];
  for (const input of getElement('record-filters').querySelectorAll('select')) {
    if (input.value !== '') {
      filterEntries.push([input.dataset.column, input.value]);
    }
  }
  reportSelection.recordFilters = Object.fromEntries(filterEntries);
  // Field, block and style editors update reportSelection directly.
}

function registerEventHandlers() {
  const form = getElement('builder-form');
  form.addEventListener('submit', preventFormSubmission);
  form.addEventListener('input', handleFormChange);
  form.addEventListener('change', handleFormChange);
  getElement('dataset').addEventListener('change', handleDatasetChange);
  getElement('compare-options').addEventListener('change', handleCompareChange);
  getElement('row-checklist').addEventListener('change', handleRowCheck);
  getElement('row-search').addEventListener('input', renderRowChecklist);
  getElement('select-all-rows').addEventListener('click', selectAllRows);
  getElement('clear-towns').addEventListener('click', clearRows);
  getElement('field-search').addEventListener('input', renderAvailableFields);
  getElement('clear-fields').addEventListener('click', clearFields);
  getElement('select-all-fields').addEventListener('click', selectAllFields);
  getElement('report-name').addEventListener('input', updateSaveState);
  getElement('report-name').addEventListener('keydown', handleReportNameKeydown);
  getElement('save').addEventListener('click', saveReport);
  getElement('reset-overrides').addEventListener('click', resetFieldOverrides);
  getElement('pdf').addEventListener('click', downloadPdf);
  getElement('step-back').addEventListener('click', () => goToStep(-1));
  getElement('step-next').addEventListener('click', handleStepNext);
  getElement('step-pdf').addEventListener('click', () => getElement('pdf').click());
  getElement('row-chips').addEventListener('click', handleChipRemove);
  getElement('draft-summary').addEventListener('click', draftSummary);
  getElement('draft-regenerate').addEventListener('click', draftSummary);
  getElement('draft-accept').addEventListener('click', acceptDraft);
  getElement('draft-discard').addEventListener('click', discardDraft);
  getElement('preview-empty-action').addEventListener('click', handleEmptyAction);
  getElement('add-ratio').addEventListener('click', handleAddRatio);
  getElement('save-ratio').addEventListener('click', saveRatio);
  getElement('cancel-ratio').addEventListener('click', closeRatioEditor);
  getElement('ratio-calculation').addEventListener('change', updateCalculationControls);
  getElement('ratio-numerator').addEventListener('change', updateCalculationControls);
  getElement('ratio-denominator').addEventListener('change', updateCalculationControls);
  getElement('ratio-decimals').addEventListener('change', (event) => {
    event.target.dataset.touched = 'true';
  });

  const tabList = document.querySelector('.builder-tabs');
  tabList.addEventListener('keydown', handleTabKeydown);
  for (const tab of tabList.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', handleTabClick);
  }
  for (const button of document.querySelectorAll('[data-go-tab]')) {
    button.addEventListener('click', handleGoTab);
  }
  for (const button of document.querySelectorAll('[data-add-block]')) {
    button.addEventListener('click', handleAddBlock);
  }
  document.addEventListener('keydown', handleSaveShortcut);
  window.addEventListener('beforeunload', warnAboutUnsavedChanges);
}

function preventFormSubmission(event) {
  event.preventDefault();
}

// ---- Tabs ----------------------------------------------------------------------------------

function selectTab(name, { focus = true } = {}) {
  for (const tabName of TAB_NAMES) {
    const isSelected = tabName === name;
    const tab = getElement(`tab-${tabName}`);
    tab.setAttribute('aria-selected', String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
    getElement(`panel-${tabName}`).hidden = !isSelected;
  }
  getElement(`panel-${name}`).scrollTop = 0;
  updateStepNav();
  if (focus) {
    getElement(`tab-${name}`).focus();
  }
}

function handleTabClick(event) {
  selectTab(event.currentTarget.dataset.tab);
}

function handleGoTab(event) {
  selectTab(event.currentTarget.dataset.goTab);
}

function handleTabKeydown(event) {
  const currentIndex = TAB_NAMES.indexOf(document.activeElement?.dataset.tab);
  if (currentIndex === -1) {
    return;
  }
  let nextIndex = null;
  if (event.key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % TAB_NAMES.length;
  } else if (event.key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + TAB_NAMES.length) % TAB_NAMES.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = TAB_NAMES.length - 1;
  }
  if (nextIndex !== null) {
    event.preventDefault();
    selectTab(TAB_NAMES[nextIndex]);
  }
}

/** Each tab shows how much of it is filled in, so nothing has to be scrolled to be checked. */
/** Each step's tab says what has been chosen in it, so no separate summary is needed. */
function updateTabCounts() {
  const rowCount = reportSelection.allRows ? availableRows.length : reportSelection.rows.length;
  const fieldCount = reportSelection.indicators.filter((key) => indicatorsByKey.has(key)).length;
  const hasRows = rowCount > 0;
  const hasFields = fieldCount > 0;

  setStepSummary('data', hasRows ? `${reportSelection.allRows ? 'All ' : ''}${rowCount.toLocaleString('en-US')} ${pluralize(rowNoun, rowCount).toLowerCase()}` : 'Not chosen', hasRows);
  setStepSummary('fields', hasFields ? `${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}` : 'Not chosen', hasFields);
  // The layout starts filled in, so it only counts as done once there is something to lay out.
  setStepSummary('content', describeLayout(), hasRows && hasFields && reportSelection.layout.length > 0);
  renderSaveSummary();
}

function setStepSummary(step, text, isComplete) {
  const summary = getElement(`tab-${step}-summary`);
  summary.textContent = text;
  summary.title = text;
  getElement(`tab-${step}`).dataset.complete = String(isComplete);
}

/** "1 chart, 1 table", "Empty". */
function describeLayout() {
  const counts = new Map();
  for (const block of reportSelection.layout) {
    counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
  }
  if (!counts.size) {
    return 'Empty';
  }
  return [...counts].map(([type, count]) => `${count} ${BLOCK_NAMES[type].toLowerCase()}${count === 1 ? '' : 's'}`).join(', ');
}

function renderSaveSummary() {
  let text = 'Not saved';
  if (savedReport) {
    text = hasUnsavedChanges() ? 'Unsaved changes' : 'Saved';
  }
  setStepSummary('style', text, Boolean(savedReport) && !hasUnsavedChanges());
}

// ---- Step footer --------------------------------------------------------------------------

const STEP_LABELS = { data: 'Compare', fields: 'Show', content: 'Layout', style: 'Finish' };

function currentStep() {
  return TAB_NAMES.find((name) => getElement(`tab-${name}`).getAttribute('aria-selected') === 'true') ?? TAB_NAMES[0];
}

function goToStep(offset) {
  const index = TAB_NAMES.indexOf(currentStep()) + offset;
  if (index >= 0 && index < TAB_NAMES.length) {
    selectTab(TAB_NAMES[index], { focus: false });
  }
}

function handleStepNext() {
  if (currentStep() === 'style') {
    getElement('save').click();
  } else {
    goToStep(1);
  }
}

/** Back, "Step 2 of 4", and Next (which becomes Save report on the last step). */
function updateStepNav() {
  const index = TAB_NAMES.indexOf(currentStep());
  const isLast = index === TAB_NAMES.length - 1;
  getElement('step-back').hidden = index === 0;
  getElement('step-pdf').hidden = !isLast;
  getElement('step-position').textContent = `Step ${index + 1} of ${TAB_NAMES.length}`;
  getElement('step-next').textContent = isLast ? 'Save report' : `Next: ${STEP_LABELS[TAB_NAMES[index + 1]]} →`;
}

function pluralize(noun, count = 2) {
  if (count === 1) {
    return noun;
  }
  if (/[^aeiou]y$/i.test(noun)) {
    return `${noun.slice(0, -1)}ies`;
  }
  return /s$/i.test(noun) ? noun : `${noun}s`;
}

// ---- Data tab -------------------------------------------------------------------------------

/** The compare choice currently shown, falling back to the dataset's default. */
function currentCompareOption() {
  return compareOptions.find((option) => option.id === reportSelection.compareBy)
    ?? compareOptions.find((option) => option.id === defaultCompare)
    ?? compareOptions[0]
    ?? null;
}

/**
 * Pick the compare choice for a report: the one it saved, else the one holding its saved
 * rows (reports saved before this choice existed), else the dataset default.
 */
function chooseCompareOption() {
  const saved = compareOptions.find((option) => option.id === reportSelection.compareBy);
  const holdingRows = reportSelection.rows.length
    ? compareOptions.find((option) => reportSelection.rows.every((row) => option.values.includes(row)))
    : null;
  const chosen = saved ?? holdingRows ?? currentCompareOption();
  applyCompareOption(chosen);
}

function applyCompareOption(option) {
  reportSelection.compareBy = option?.id;
  availableRows = option?.values ?? [];
  rowNoun = option ? option.noun.charAt(0).toUpperCase() + option.noun.slice(1) : 'Row';
  // The statewide figure compares places with Connecticut; it means nothing for programs.
  const canCompareState = option?.kind === 'place' && hasStatewideRow;
  getElement('benchmark-option').hidden = !canCompareState;
  if (!canCompareState) {
    reportSelection.benchmark = false;
    getElement('benchmark').checked = false;
  }
}

/** Two real example values; placeholders such as "-" or "N/A" explain nothing. */
function exampleValues(values) {
  return values.filter((value) => /[a-z0-9]/i.test(value) && !/^(n\/?a|none|null)$/i.test(value.trim())).slice(0, 2);
}

function renderCompareOptions() {
  const container = getElement('compare-options');
  container.replaceChildren();
  const current = currentCompareOption();
  // With one thing to compare there is no question to ask; the list heading says what it is.
  getElement('compare-section').hidden = compareOptions.length < 2;
  for (const option of compareOptions) {
    const id = `compare-${option.id}`;
    const card = createElement('label', { class: 'compare-option', for: id });
    card.append(
      createElement('input', { type: 'radio', name: 'compare-by', id, value: option.id, checked: option === current }),
      createElement('span', { class: 'compare-option-label' }, option.label),
      createElement('span', { class: 'compare-option-count' }, `${option.values.length.toLocaleString('en-US')} ${option.values.length === 1 ? 'option' : 'options'}`),
      createElement('span', { class: 'compare-option-examples' }, `e.g. ${exampleValues(option.values).join(', ')}`),
    );
    container.append(card);
  }
}

function renderRowSelection() {
  const plural = pluralize(rowNoun).toLowerCase();
  getElement('rows-heading').textContent = `Which ${plural}?`;
  const search = getElement('row-search');
  search.hidden = availableRows.length <= SEARCHABLE_ROW_COUNT;
  search.placeholder = `Find a ${rowNoun.toLowerCase()}`;
  if (search.hidden) {
    search.value = '';
  }
  renderRowChecklist();
}

function isRowChosen(name) {
  return reportSelection.allRows || reportSelection.rows.includes(name);
}

function renderRowChecklist() {
  const query = getElement('row-search').value.trim().toLowerCase();
  const list = getElement('row-checklist');
  list.replaceChildren();
  const shown = availableRows.filter((name) => !query || name.toLowerCase().includes(query));
  for (const [index, name] of shown.entries()) {
    const id = `row-choice-${index}`;
    const choice = createElement('label', { class: 'row-choice', for: id });
    choice.append(createElement('input', { type: 'checkbox', id, value: name, checked: isRowChosen(name) }), name);
    list.append(choice);
  }
  getElement('row-empty').hidden = shown.length > 0 || availableRows.length === 0;

  const chosenCount = reportSelection.allRows ? availableRows.length : reportSelection.rows.length;
  getElement('builder-town-count').textContent = `${chosenCount} of ${availableRows.length} selected`;
  renderRowChips();
  getElement('select-all-rows').disabled = availableRows.length === 0 || chosenCount === availableRows.length;
  getElement('clear-towns').disabled = chosenCount === 0;
}

/** MAX_ROW_CHIPS chosen rows stay visible above the list, each removable; the rest are counted. */
const MAX_ROW_CHIPS = 12;

function renderRowChips() {
  const chips = getElement('row-chips');
  chips.replaceChildren();
  if (reportSelection.allRows) {
    chips.append(createElement('span', { class: 'row-chip is-all' }, `All ${availableRows.length.toLocaleString('en-US')} ${pluralize(rowNoun).toLowerCase()}`));
    return;
  }
  for (const name of reportSelection.rows.slice(0, MAX_ROW_CHIPS)) {
    chips.append(createElement('button', {
      type: 'button', class: 'row-chip', 'data-row': name, 'aria-label': `Remove ${name}`,
    }, name, createElement('span', { 'aria-hidden': 'true' }, '×')));
  }
  const more = reportSelection.rows.length - MAX_ROW_CHIPS;
  if (more > 0) {
    chips.append(createElement('span', { class: 'row-chip is-more' }, `+${more} more`));
  }
}

function handleChipRemove(event) {
  const chip = event.target.closest('button.row-chip');
  if (!chip) {
    return;
  }
  reportSelection.rows = reportSelection.rows.filter((row) => row !== chip.dataset.row);
  updateRows();
}

function handleCompareChange(event) {
  const option = compareOptions.find((candidate) => candidate.id === event.target.value);
  if (!option) {
    return;
  }
  const hadRows = reportSelection.allRows || reportSelection.rows.length > 0;
  reportSelection.rows = [];
  reportSelection.allRows = false;
  applyCompareOption(option);
  getElement('row-search').value = '';
  renderRowSelection();
  showStatus(getElement('builder-status'), hadRows ? `Now comparing ${option.label.toLowerCase()}. Choose which ones below.` : '');
  selectionChanged();
}

function handleRowCheck(event) {
  const name = event.target.value;
  if (reportSelection.allRows) {
    // Unticking one of "all" keeps the rest as an explicit list.
    reportSelection.rows = [...availableRows];
    reportSelection.allRows = false;
  }
  if (event.target.checked) {
    // Keep the dataset's order, so charts follow the list people see.
    const chosen = new Set([...reportSelection.rows, name]);
    reportSelection.rows = availableRows.filter((row) => chosen.has(row));
  } else {
    reportSelection.rows = reportSelection.rows.filter((row) => row !== name);
  }
  updateRows();
}

function selectAllRows() {
  // Very long lists are sent as "all rows" so requests stay small.
  reportSelection.allRows = availableRows.length > MAX_NAMED_ROWS;
  reportSelection.rows = reportSelection.allRows ? [] : [...availableRows];
  updateRows();
}

function clearRows() {
  reportSelection.rows = [];
  reportSelection.allRows = false;
  updateRows();
}

function updateRows() {
  renderRowChecklist();
  selectionChanged();
}

function handleFormChange(event) {
  if (event.target.closest('[data-no-preview]') || event.target.id === 'dataset') {
    return;
  }
  selectionChanged();
}

/** Every edit ends here: read the simple controls, refresh counts, mark unsaved, preview. */
function selectionChanged() {
  readFormControls();
  updateTabCounts();
  updateSaveState();
  markPreviewStale();
  schedulePreview();
}

async function handleDatasetChange() {
  readFormControls();
  reportSelection.recordFilters = {};
  reportSelection.fieldOverrides = {};
  reportSelection.styleOverrides = {};
  const previousFieldCount = reportSelection.indicators.length;
  markPreviewStale();
  try {
    const loaded = await loadDatasetColumns();
    if (!loaded) {
      return;
    }
    const availableRowNames = new Set(availableRows);
    const previousRowCount = reportSelection.rows.length;
    reportSelection.rows = reportSelection.rows.filter((row) => availableRowNames.has(row));
    renderRowSelection();

    const messages = [];
    const removedRowCount = previousRowCount - reportSelection.rows.length;
    if (removedRowCount > 0) {
      messages.push(`${removedRowCount} selected ${removedRowCount === 1 ? 'row is' : 'rows are'} not in this dataset and ${removedRowCount === 1 ? 'was' : 'were'} removed.`);
    }
    const removedFieldCount = previousFieldCount - reportSelection.indicators.length;
    if (removedFieldCount > 0) {
      messages.push(`${removedFieldCount} selected ${removedFieldCount === 1 ? 'field is' : 'fields are'} not in this dataset and ${removedFieldCount === 1 ? 'was' : 'were'} removed.`);
    }
    showStatus(getElement('builder-status'), messages.join(' '));
    updateStyleEditor();
    renderFields();
    renderLayout();
    selectionChanged();
  } catch (error) {
    showStatus(getElement('builder-status'), error.message, 'error');
  }
}

async function loadDatasetColumns() {
  const requestNumber = ++optionsRequestNumber;
  isLoadingOptions = true;
  const selectedDataset = findSelectedDataset();
  let options = { columns: [], filters: [], compareOptions: [], defaultCompare: null, hasState: false };

  if (selectedDataset) {
    try {
      options = await api(`/datasets/${selectedDataset.id}/report-options`);
    } catch (error) {
      if (requestNumber !== optionsRequestNumber) {
        return false;
      }
      isLoadingOptions = false;
      throw error;
    }
    // Only the most recently selected dataset may update the form.
    if (requestNumber !== optionsRequestNumber) {
      return false;
    }
  }

  defaultChartType = options.defaultChartType || 'grouped_bar';
  availableIndicators = options.columns;
  compareOptions = options.compareOptions ?? [];
  defaultCompare = options.defaultCompare;
  hasStatewideRow = Boolean(options.hasState);
  chooseCompareOption();
  renderCompareOptions();
  renderRowSelection();
  // Calculated fields whose fields this dataset does not have cannot be kept. Summaries
  // (average, median…) use one field; ratios and filled-row averages need a second one.
  const fieldKeys = new Set(availableIndicators.map((field) => field.key));
  reportSelection.customIndicators = (reportSelection.customIndicators ?? []).filter((custom) => {
    const needsSecond = (custom.calculation ?? 'ratio') === 'ratio' || custom.calculation === 'average_filled';
    return fieldKeys.has(custom.numerator) && (!needsSecond || fieldKeys.has(custom.denominator));
  });
  rebuildFieldIndex();
  reportSelection.indicators = reportSelection.indicators.filter((key) => indicatorsByKey.has(key));
  removeUnselectedBlockIndicators();
  renderDatasetCaption(selectedDataset);
  if (selectedDataset && availableIndicators.length === 0) {
    showStatus(getElement('builder-status'), 'This dataset has no approved fields yet. Choose another dataset or ask a data administrator to review it.', 'error');
  }

  getElement('benchmark').checked = reportSelection.benchmark;
  renderRecordFilters(options.filters);
  isLoadingOptions = false;
  return true;
}

function findSelectedDataset() {
  return activeDatasets.find((dataset) => reportSelection.dataset && isSameDataset(dataset, reportSelection.dataset));
}

function renderDatasetCaption(dataset) {
  const caption = getElement('dataset-caption');
  if (!dataset) {
    caption.textContent = reportSelection.dataset
      ? 'This saved report uses a dataset version that is no longer published.'
      : 'No published datasets are available yet.';
    return;
  }
  caption.title = [dataset.source, dataset.vintage, `version ${dataset.version}`].filter(Boolean).join(' · ');
  caption.replaceChildren(
    createElement('span', { class: 'dataset-caption-source' }, dataset.source || 'Unknown source'),
    createElement('a', { href: `/dataset?id=${encodeURIComponent(dataset.id)}` }, 'About this data'),
  );
}

function renderRecordFilters(filters) {
  getElement('record-filter-panel').hidden = filters.length === 0;
  const filterContainer = getElement('record-filters');
  filterContainer.replaceChildren();

  for (const filter of filters) {
    const select = createElement('select', { id: `filter-${filter.key}`, 'data-column': filter.key });
    select.append(createElement('option', { value: '' }, 'All'));
    for (const value of filter.values) {
      select.append(createElement('option', { value }, value));
    }
    select.value = reportSelection.recordFilters?.[filter.key] ?? '';

    const filterRow = createElement('div');
    filterRow.append(createElement('label', { for: select.id }, filter.label), select);
    filterContainer.append(filterRow);
  }
}

// ---- Fields tab -----------------------------------------------------------------------------

function removeUnselectedBlockIndicators() {
  for (const key of Object.keys(reportSelection.fieldOverrides ?? {})) {
    if (!reportSelection.indicators.includes(key)) {
      delete reportSelection.fieldOverrides[key];
    }
  }
  for (const block of reportSelection.layout) {
    if (block.indicators) {
      block.indicators = block.indicators.filter((key) => reportSelection.indicators.includes(key));
    }
    for (const key of Object.keys(block.colors ?? {})) {
      if (!reportSelection.indicators.includes(key)) {
        delete block.colors[key];
      }
    }
  }
}

function renderFields(focusId) {
  renderSelectedFields();
  renderAvailableFields();
  renderRatioList();
  restoreFocus(focusId, 'button:not(:disabled), input');
}

/** The ordered list of chosen fields, with per-report renaming tucked into each row. */
function renderSelectedFields() {
  const list = getElement('selected-fields');
  list.replaceChildren();
  const chosenKeys = reportSelection.indicators.filter((key) => indicatorsByKey.has(key));

  for (const [position, key] of chosenKeys.entries()) {
    const field = indicatorsByKey.get(key);
    const override = reportSelection.fieldOverrides?.[key] ?? {};
    const itemId = `selected-${key}`;
    const row = createElement('li', { class: 'selected-field' });

    const head = createElement('div', { class: 'selected-field-head' });
    const positionBadge = createElement('span', { class: 'selected-field-position', 'aria-hidden': 'true' }, String(position + 1));
    const name = createElement('span', { class: 'selected-field-name', id: `${itemId}-name` }, override.label || field.label);
    const unit = createElement('span', { class: 'field-label-unit' }, fieldUnitLabel(field));
    if (field.custom) {
      unit.textContent = `Calculated · ${field.formula}`;
    } else if (override.label) {
      unit.textContent = `${fieldUnitLabel(field)} · renamed from ${field.label}`;
    }
    const nameColumn = createElement('span', { class: 'selected-field-copy' }, name, unit);

    const controls = createElement('span', { class: 'order' });
    if (!field.custom) {
      const isOpen = openOverrideKeys.has(key);
      controls.append(createElement('button', {
        type: 'button', class: 'icon', id: `${itemId}-rename`,
        'aria-label': `Rename ${field.label} for this report`, 'aria-expanded': String(isOpen),
        'aria-controls': `${itemId}-override`, title: 'Rename for this report',
        'data-field-key': key, onClick: handleOverrideToggle,
      }, '✎'));
    }
    controls.append(
      createElement('button', {
        type: 'button', class: 'icon', id: `${itemId}-up`,
        'aria-label': `Move ${field.label} up`, disabled: position === 0,
        'data-indicator': key, 'data-direction': -1, onClick: handleMoveIndicator,
      }, '↑'),
      createElement('button', {
        type: 'button', class: 'icon', id: `${itemId}-down`,
        'aria-label': `Move ${field.label} down`, disabled: position === chosenKeys.length - 1,
        'data-indicator': key, 'data-direction': 1, onClick: handleMoveIndicator,
      }, '↓'),
      createElement('button', {
        type: 'button', class: 'icon', id: `${itemId}-remove`,
        'aria-label': `Remove ${field.label}`, 'data-indicator': key, onClick: handleRemoveIndicator,
      }, '✕'),
    );
    head.append(positionBadge, nameColumn, controls);
    row.append(head);
    if (!field.custom) {
      row.append(createOverrideEditor(field, override));
    }
    list.append(row);
  }

  getElement('selected-section').hidden = chosenKeys.length === 0;
  getElement('clear-fields').disabled = chosenKeys.length === 0;
  getElement('select-all-fields').disabled = availableIndicators.every((field) => chosenKeys.includes(field.key));
  getElement('reset-overrides').hidden = Object.keys(reportSelection.fieldOverrides ?? {}).length === 0;
}

function createOverrideEditor(field, override) {
  const key = field.key;
  const grid = createElement('div', {
    class: 'override-grid',
    id: `selected-${key}-override`,
    hidden: !openOverrideKeys.has(key),
  });

  const labelInput = createElement('input', {
    id: `override-${key}-label`, maxlength: 120, value: override.label ?? '',
    placeholder: field.label, 'data-field-key': key, 'data-setting': 'label', onInput: handleFieldOverride,
  });
  grid.append(createElement('div', {}, createElement('label', { for: labelInput.id }, 'Display name in this report'), labelInput));

  if (field.type !== 'text') {
    const decimals = createElement('select', {
      id: `override-${key}-decimals`, 'data-field-key': key, 'data-setting': 'decimals', onChange: handleFieldOverride,
    });
    // Uploaded columns keep their own precision (stored as up to 9 places).
    const defaultLabel = field.decimals > 4 ? 'As uploaded' : `Default (${field.decimals})`;
    decimals.append(createElement('option', { value: '' }, defaultLabel));
    for (let digits = 0; digits <= 4; digits++) {
      decimals.append(createElement('option', { value: String(digits) }, String(digits)));
    }
    decimals.value = override.decimals === undefined ? '' : String(override.decimals);
    grid.append(createElement('div', {}, createElement('label', { for: decimals.id }, 'Decimals'), decimals));
  }

  const descriptionInput = createElement('input', {
    id: `override-${key}-description`, maxlength: 500, value: override.description ?? '',
    placeholder: field.description || 'Optional note shown with the report',
    'data-field-key': key, 'data-setting': 'description', onInput: handleFieldOverride,
  });
  grid.append(createElement('div', { class: 'override-wide' }, createElement('label', { for: descriptionInput.id }, 'Explanation'), descriptionInput));
  return grid;
}

function handleOverrideToggle(event) {
  const button = event.currentTarget;
  const key = button.dataset.fieldKey;
  const panel = getElement(`selected-${key}-override`);
  const willOpen = panel.hidden;
  panel.hidden = !willOpen;
  button.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) {
    openOverrideKeys.add(key);
    getElement(`override-${key}-label`).focus();
  } else {
    openOverrideKeys.delete(key);
  }
}

/**
 * Every approved field as a large tick card. Fields keep a fixed order, so ticking one never
 * moves the list under the pointer. Short lists show no search and no unit headings.
 */
function renderAvailableFields() {
  const isLongList = availableIndicators.length > SEARCHABLE_FIELD_COUNT;
  const search = getElement('field-search');
  search.hidden = !isLongList;
  if (!isLongList) {
    search.value = '';
  }
  const searchText = search.value.trim().toLowerCase();
  const visibleFields = availableIndicators.filter((field) => {
    const searchable = `${field.displayLabel ?? ''} ${field.label} ${field.description || ''} ${fieldUnitLabel(field)}`.toLowerCase();
    return searchable.includes(searchText);
  });

  const indicatorList = getElement('indicator-list');
  indicatorList.replaceChildren();
  const groups = isLongList ? groupFieldsByUnit(visibleFields) : [{ label: null, fields: visibleFields }];
  for (const group of groups) {
    const section = createElement('div', { class: 'unit-field-group' });
    if (group.label && groups.length > 1) {
      section.append(createElement('h3', { class: 'unit-field-heading' }, group.label));
    }
    const choices = createElement('div', { class: 'field-choice-grid' });
    for (const field of group.fields) {
      choices.append(createFieldChoice(field));
    }
    section.append(choices);
    indicatorList.append(section);
  }
  if (visibleFields.length === 0) {
    const message = availableIndicators.length ? 'No fields match your search.' : 'This dataset has no approved fields yet.';
    indicatorList.append(createElement('p', { class: 'muted small' }, message));
  }
  renderAvailableFieldCount();
}

function createFieldChoice(field) {
  const inputId = `indicator-${field.key}`;
  const isChosen = reportSelection.indicators.includes(field.key);
  const label = createElement('label', { for: inputId, class: 'field-choice', 'data-selected': String(isChosen) });
  const checkbox = createElement('input', {
    type: 'checkbox',
    id: inputId,
    checked: isChosen,
    'data-indicator': field.key,
    onChange: handleIndicatorChange,
  });
  const copy = createElement('span', { class: 'field-copy' });
  copy.append(
    createElement('span', { class: 'field-choice-name' }, field.label),
    createElement('span', { class: 'field-choice-meta' }, fieldUnitLabel(field)),
  );
  if (field.description) {
    copy.append(createElement('span', { class: 'field-label-unit' }, field.description));
    label.title = field.description;
  }
  label.append(checkbox, copy);
  return label;
}

function selectAllFields() {
  const chosen = new Set(reportSelection.indicators);
  for (const field of availableIndicators) {
    if (!chosen.has(field.key)) {
      reportSelection.indicators.push(field.key);
    }
  }
  renderFields('clear-fields');
  renderLayout();
  selectionChanged();
}

function restoreFocus(focusId, fallbackSelector) {
  if (!focusId) {
    return;
  }
  const target = getElement(focusId);
  if (target && !target.disabled) {
    target.focus();
    return;
  }
  // A moved row's up/down button may now be disabled at the end of the list.
  const fallback = target?.closest('li')?.querySelector(fallbackSelector);
  fallback?.focus();
}

function handleIndicatorChange(event) {
  const checkbox = event.currentTarget;
  const indicatorKey = checkbox.dataset.indicator;
  if (checkbox.checked) {
    reportSelection.indicators.push(indicatorKey);
  } else {
    reportSelection.indicators = reportSelection.indicators.filter((key) => key !== indicatorKey);
  }
  checkbox.closest('.field-choice').dataset.selected = String(checkbox.checked);
  removeUnselectedBlockIndicators();
  // Re-render only the selected list; the checkbox the user just used stays in place.
  renderSelectedFields();
  renderAvailableFieldCount();
  renderLayout();
}

function renderAvailableFieldCount() {
  const chosenCount = reportSelection.indicators.filter((key) => availableIndicators.some((field) => field.key === key)).length;
  getElement('field-count').textContent = `${chosenCount} of ${availableIndicators.length} selected`;
  getElement('clear-fields').disabled = chosenCount === 0;
  getElement('select-all-fields').disabled = availableIndicators.length === 0 || chosenCount === availableIndicators.length;
}

function handleRemoveIndicator(event) {
  const indicatorKey = event.currentTarget.dataset.indicator;
  const position = reportSelection.indicators.indexOf(indicatorKey);
  reportSelection.indicators = reportSelection.indicators.filter((key) => key !== indicatorKey);
  openOverrideKeys.delete(indicatorKey);
  removeUnselectedBlockIndicators();
  const nextKey = reportSelection.indicators[Math.min(position, reportSelection.indicators.length - 1)];
  renderFields(nextKey ? `selected-${nextKey}-remove` : 'select-all-fields');
  renderLayout();
  selectionChanged();
}

function clearFields() {
  reportSelection.indicators = [];
  openOverrideKeys.clear();
  removeUnselectedBlockIndicators();
  renderFields('select-all-fields');
  renderLayout();
  selectionChanged();
}

function handleMoveIndicator(event) {
  const button = event.currentTarget;
  const indicatorKey = button.dataset.indicator;
  const direction = Number(button.dataset.direction);
  const indicatorKeys = [...reportSelection.indicators];
  const currentIndex = indicatorKeys.indexOf(indicatorKey);
  const nextIndex = currentIndex + direction;
  if (currentIndex === -1 || nextIndex < 0 || nextIndex >= indicatorKeys.length) {
    return;
  }
  indicatorKeys[currentIndex] = indicatorKeys[nextIndex];
  indicatorKeys[nextIndex] = indicatorKey;
  reportSelection.indicators = indicatorKeys;

  const focusDirection = direction < 0 ? 'up' : 'down';
  renderSelectedFields();
  restoreFocus(`selected-${indicatorKey}-${focusDirection}`, 'button:not(:disabled)');
  renderLayout();
  selectionChanged();
}

function handleFieldOverride(event) {
  const input = event.currentTarget;
  const key = input.dataset.fieldKey;
  const setting = input.dataset.setting;
  reportSelection.fieldOverrides ??= {};
  const overrides = reportSelection.fieldOverrides[key] ?? {};
  if (input.value === '') {
    delete overrides[setting];
  } else if (setting === 'decimals') {
    overrides[setting] = Number(input.value);
  } else {
    overrides[setting] = input.value;
  }
  if (Object.keys(overrides).length) {
    reportSelection.fieldOverrides[key] = overrides;
  } else {
    delete reportSelection.fieldOverrides[key];
  }
  if (setting === 'label') {
    const field = indicatorsByKey.get(key);
    const nameElement = getElement(`selected-${key}-name`);
    nameElement.textContent = input.value || field.label;
    const unitElement = nameElement.nextElementSibling;
    unitElement.textContent = input.value
      ? `${fieldUnitLabel(field)} · renamed from ${field.label}`
      : fieldUnitLabel(field);
  }
  getElement('reset-overrides').hidden = Object.keys(reportSelection.fieldOverrides).length === 0;
}

function resetFieldOverrides() {
  reportSelection.fieldOverrides = {};
  renderSelectedFields();
  renderLayout();
  selectionChanged();
}

// ---- Custom ratios --------------------------------------------------------------------------

let editingRatioKey = null;

/** What each calculation is called in the editor and in the field list. */
const CALCULATION_WORDS = {
  median: 'Median', highest: 'Highest', lowest: 'Lowest', total: 'Total',
};

/**
 * How a calculated field is worked out, in words: "Total Population ÷ number of towns",
 * "Median Population", "Population ÷ Households". null when a field it needs is gone.
 */
function describeCalculation(custom) {
  const calculation = custom.calculation ?? 'ratio';
  const numerator = availableIndicators.find((field) => field.key === custom.numerator);
  const denominator = availableIndicators.find((field) => field.key === custom.denominator);
  if (!numerator || ((calculation === 'ratio' || calculation === 'average_filled') && !denominator)) {
    return null;
  }
  const scale = RATIO_SYMBOLS[custom.format] ?? '';
  switch (calculation) {
    case 'ratio':
      return `${numerator.label} ÷ ${denominator.label}${scale}`;
    case 'average':
      return `Total ${numerator.label} ÷ number of ${pluralize(rowNoun).toLowerCase()}${scale}`;
    case 'average_filled':
      return `Total ${numerator.label} ÷ rows with a ${denominator.label} value${scale}`;
    default:
      return `${CALCULATION_WORDS[calculation]} ${numerator.label} across the ${pluralize(rowNoun).toLowerCase()}`;
  }
}

/**
 * A report-defined calculated field, shaped like an approved field so every picker can use it.
 * Summaries are one value for the report, so they are never charted.
 */
function customFieldFor(custom) {
  const description = describeCalculation(custom);
  if (!description) {
    return null;
  }
  const isSummary = (custom.calculation ?? 'ratio') !== 'ratio';
  const formula = isSummary ? `${description} · one value, shown under the title` : description;
  return {
    summary: isSummary,
    key: custom.key,
    label: custom.label,
    displayLabel: custom.label,
    type: 'number',
    unit: RATIO_UNITS[custom.format] ?? 'ratio',
    decimals: custom.decimals,
    description: formula,
    formula,
    custom: true,
  };
}

function rebuildFieldIndex() {
  indicatorsByKey = new Map();
  for (const indicator of availableIndicators) {
    indicatorsByKey.set(indicator.key, indicator);
  }
  for (const custom of reportSelection.customIndicators) {
    const field = customFieldFor(custom);
    if (field) {
      indicatorsByKey.set(field.key, field);
    }
  }
}

function numericFields() {
  return availableIndicators.filter((field) => field.type !== 'text');
}

function renderRatioList() {
  const section = getElement('ratio-section');
  section.hidden = numericFields().length === 0;
  // Calculated fields are optional; keep them folded away until a report has one.
  if (reportSelection.customIndicators.length) {
    section.open = true;
  }
  const list = getElement('ratio-list');
  list.replaceChildren();
  for (const custom of reportSelection.customIndicators) {
    const field = indicatorsByKey.get(custom.key);
    if (!field) {
      continue;
    }
    const isChosen = reportSelection.indicators.includes(custom.key);
    const checkbox = createElement('input', {
      type: 'checkbox', id: `indicator-${custom.key}`, checked: isChosen,
      'data-indicator': custom.key, onChange: handleIndicatorChange,
    });
    const label = createElement('label', { for: checkbox.id, class: 'field-choice', 'data-selected': String(isChosen) });
    label.append(checkbox, createElement('span', { class: 'field-copy' },
      createElement('span', {}, custom.label),
      createElement('span', { class: 'field-label-unit' }, field.formula),
    ));
    const actions = createElement('span', { class: 'ratio-actions' },
      createElement('button', { type: 'button', class: 'link', 'data-ratio': custom.key, onClick: handleEditRatio }, 'Edit'),
      createElement('button', { type: 'button', class: 'link danger-link', 'data-ratio': custom.key, onClick: handleDeleteRatio }, 'Delete'),
    );
    list.append(createElement('li', { class: 'ratio-item' }, label, actions));
  }
}

function fillRatioSelect(select, selectedKey) {
  select.replaceChildren();
  for (const field of numericFields()) {
    select.append(createElement('option', { value: field.key }, `${field.label} (${fieldUnitLabel(field)})`));
  }
  if (selectedKey) {
    select.value = selectedKey;
  }
}

/** Calculations that need a second field, and what that field is for. */
const SECOND_FIELD = { ratio: 'By', average_filled: 'Count rows with a value in' };
/** Only divisions can be scaled to a percentage or per 1,000. */
const SCALABLE = new Set(['ratio', 'average', 'average_filled']);

/** Show only the inputs the chosen calculation needs, with words that match it. */
function updateCalculationControls() {
  const calculation = getElement('ratio-calculation').value;
  const secondLabel = SECOND_FIELD[calculation];
  getElement('ratio-denominator-field').hidden = !secondLabel;
  getElement('ratio-operator').hidden = calculation !== 'ratio';
  getElement('ratio-format-field').hidden = !SCALABLE.has(calculation);
  // Summaries can sit beside the same figure for every town (or every row) in the dataset.
  getElement('ratio-benchmark-field').hidden = calculation === 'ratio';
  getElement('ratio-benchmark-label').textContent = currentCompareOption()?.kind === 'place'
    ? `Also show the figure for all Connecticut ${pluralize(rowNoun).toLowerCase()}, for comparison`
    : 'Also show the figure for the whole dataset, for comparison';
  getElement('ratio-numerator-label').textContent = calculation === 'ratio' ? 'Divide' : 'Of';
  if (secondLabel) {
    getElement('ratio-denominator-label').textContent = secondLabel;
    const fields = calculation === 'ratio' ? numericFields() : availableIndicators;
    const select = getElement('ratio-denominator');
    const previous = select.value;
    select.replaceChildren(...fields.map((field) => createElement('option', { value: field.key }, `${field.label} (${fieldUnitLabel(field)})`)));
    select.value = fields.some((field) => field.key === previous) ? previous : (fields[1] ?? fields[0])?.key ?? '';
  }
  // Averages, medians and totals of counts read best as whole numbers; ratios need decimals.
  if (!getElement('ratio-decimals').dataset.touched) {
    getElement('ratio-decimals').value = calculation === 'ratio' ? '2' : '0';
  }
  const plural = pluralize(rowNoun).toLowerCase();
  const help = {
    ratio: 'Worked out for each row from its own values, and charted like any other field.',
    average: `Adds the field up across the ${plural} in the report, then divides by how many there are.`,
    average_filled: 'Adds the field up, then divides by the number of rows that have a value in the second column.',
    median: `The middle value across the ${plural} in the report: half are higher, half lower.`,
    highest: `The largest value in the report, with the ${rowNoun.toLowerCase()} it belongs to.`,
    lowest: `The smallest value in the report, with the ${rowNoun.toLowerCase()} it belongs to.`,
    total: `The field added up across the ${plural} in the report.`,
  }[calculation];
  getElement('ratio-kind-help').textContent = calculation === 'ratio' ? help : `${help} Shown as one number under the report title.`;
  getElement('ratio-name').placeholder = defaultRatioName();
}

function openRatioEditor(custom = null) {
  editingRatioKey = custom?.key ?? null;
  getElement('calc-average').textContent = `Average per ${rowNoun.toLowerCase()}`;
  getElement('ratio-calculation').value = custom?.calculation ?? (custom ? 'ratio' : 'average');
  fillRatioSelect(getElement('ratio-numerator'), custom?.numerator ?? numericFields()[0]?.key);
  getElement('ratio-denominator').replaceChildren();
  if (custom?.denominator) {
    getElement('ratio-denominator').append(createElement('option', { value: custom.denominator }));
    getElement('ratio-denominator').value = custom.denominator;
  }
  getElement('ratio-name').value = custom?.label ?? '';
  getElement('ratio-format').value = custom?.format ?? 'ratio';
  getElement('ratio-benchmark').checked = custom?.benchmark ?? true;
  const decimals = getElement('ratio-decimals');
  delete decimals.dataset.touched;
  updateCalculationControls();
  if (custom) {
    decimals.value = String(custom.decimals);
    decimals.dataset.touched = 'true';
  }
  getElement('save-ratio').textContent = custom ? 'Save changes' : 'Add calculated field';
  showStatus(getElement('ratio-status'), '');
  getElement('ratio-editor').hidden = false;
  getElement('add-ratio').hidden = true;
  getElement('ratio-calculation').focus();
}

function closeRatioEditor() {
  editingRatioKey = null;
  getElement('ratio-editor').hidden = true;
  getElement('add-ratio').hidden = false;
}

function handleAddRatio() {
  openRatioEditor();
}

function handleEditRatio(event) {
  const custom = reportSelection.customIndicators.find((item) => item.key === event.currentTarget.dataset.ratio);
  openRatioEditor(custom);
}

function nextRatioKey() {
  const used = new Set(reportSelection.customIndicators.map((custom) => custom.key));
  let number = 1;
  while (used.has(`ratio_${number}`)) {
    number++;
  }
  return `ratio_${number}`;
}

/** A name from the current editor choices, e.g. "Average population per town". */
function defaultRatioName() {
  const calculation = getElement('ratio-calculation').value;
  const numerator = indicatorsByKey.get(getElement('ratio-numerator').value);
  const denominator = indicatorsByKey.get(getElement('ratio-denominator').value);
  if (!numerator) {
    return 'Calculated field';
  }
  const name = numerator.label.toLowerCase();
  switch (calculation) {
    case 'ratio':
      return `${numerator.label} per ${denominator?.label.toLowerCase() ?? 'field'}`;
    case 'average':
      return `Average ${name} per ${rowNoun.toLowerCase()}`;
    case 'average_filled':
      return `Average ${name} per row with ${denominator?.label.toLowerCase() ?? 'a value'}`;
    default:
      return `${CALCULATION_WORDS[calculation]} ${name}`;
  }
}

function saveRatio() {
  const calculation = getElement('ratio-calculation').value;
  const numerator = getElement('ratio-numerator').value;
  const needsSecond = Boolean(SECOND_FIELD[calculation]);
  const denominator = needsSecond ? getElement('ratio-denominator').value : undefined;
  if (!numerator || !indicatorsByKey.get(numerator)) {
    showStatus(getElement('ratio-status'), 'Choose a number field.', 'error');
    return;
  }
  if (needsSecond && !denominator) {
    showStatus(getElement('ratio-status'), 'Choose the second field.', 'error');
    return;
  }
  if (calculation === 'ratio' && numerator === denominator) {
    showStatus(getElement('ratio-status'), 'Choose two different fields.', 'error');
    return;
  }
  const definition = {
    label: (getElement('ratio-name').value.trim() || defaultRatioName()).slice(0, 120),
    numerator,
    calculation,
    denominator,
    format: SCALABLE.has(calculation) ? getElement('ratio-format').value : 'ratio',
    decimals: Number(getElement('ratio-decimals').value),
    benchmark: calculation === 'ratio' ? undefined : getElement('ratio-benchmark').checked,
  };
  if (editingRatioKey) {
    const custom = reportSelection.customIndicators.find((item) => item.key === editingRatioKey);
    delete custom.divideBy;
    Object.assign(custom, definition);
  } else {
    const key = nextRatioKey();
    reportSelection.customIndicators.push({ key, ...definition });
    reportSelection.indicators.push(key);
  }
  closeRatioEditor();
  rebuildFieldIndex();
  renderFields();
  renderLayout();
  selectionChanged();
}

function handleDeleteRatio(event) {
  const key = event.currentTarget.dataset.ratio;
  reportSelection.customIndicators = reportSelection.customIndicators.filter((custom) => custom.key !== key);
  reportSelection.indicators = reportSelection.indicators.filter((indicatorKey) => indicatorKey !== key);
  for (const block of reportSelection.layout) {
    if (block.colors) {
      delete block.colors[key];
    }
  }
  rebuildFieldIndex();
  removeUnselectedBlockIndicators();
  renderFields();
  renderLayout();
  selectionChanged();
}

// ---- Content tab ----------------------------------------------------------------------------

function getEligibleFields(block) {
  const fields = [];
  for (const key of reportSelection.indicators) {
    const field = indicatorsByKey.get(key);
    // Summaries are one value for the whole report, shown under the title instead.
    if (field && !field.summary && (block.type !== 'chart' || field.type !== 'text')) {
      fields.push(field);
    }
  }
  return fields;
}

function getFieldLabel(field) {
  return reportSelection.fieldOverrides?.[field.key]?.label || field.label;
}

function describeBlock(block) {
  if (block.type === 'text') {
    const firstLine = (block.text ?? '').split('\n').find((line) => line.trim()) ?? '';
    return firstLine ? firstLine.replace(/^#+\s*/, '').slice(0, 60) : 'Empty: write some text';
  }
  const eligibleCount = getEligibleFields(block).length;
  if (eligibleCount === 0) {
    return block.type === 'chart' ? 'Needs a numeric field' : 'Needs a field';
  }
  const scope = block.indicators.length
    ? `${block.indicators.length} of ${eligibleCount} fields`
    : `All ${eligibleCount} ${block.type === 'chart' ? 'numeric ' : ''}fields`;
  if (block.type === 'chart') {
    const chartType = CHART_TYPES.find((type) => type.value === block.chartType) ?? CHART_TYPES[0];
    return `${chartType.label} · ${scope}`;
  }
  return scope;
}

function renderLayout(focusId) {
  const layoutList = getElement('layout-list');
  layoutList.replaceChildren();
  for (const [index, block] of reportSelection.layout.entries()) {
    layoutList.append(createBlockCard(block, index));
  }

  if (reportSelection.layout.length === 0) {
    layoutList.append(createElement('li', { class: 'muted small layout-empty' }, 'The report is empty. Add a chart or a table so it shows its figures.'));
  }
  for (const block of expandedBlocks) {
    if (!reportSelection.layout.includes(block)) {
      expandedBlocks.delete(block);
    }
  }
  updateRangeHints();
  restoreFocus(focusId, 'button:not(:disabled), textarea, select');
}

/** What a block shows, so cards read "Population and Households" rather than "Chart 1". */
function blockContentName(block, index) {
  if (block.type === 'chart' && block.title) {
    return block.title;
  }
  if (block.type === 'text') {
    return `Text ${index + 1}`;
  }
  const keys = block.indicators.length ? block.indicators : getEligibleFields(block).map((field) => field.key);
  const names = keys.map((key) => indicatorsByKey.get(key)).filter(Boolean)
    .map((field) => reportSelection.fieldOverrides?.[field.key]?.label || field.label);
  if (!names.length) {
    return `${BLOCK_NAMES[block.type]} ${index + 1}`;
  }
  return names.length > 2 ? `${names[0]}, ${names[1]} and ${names.length - 2} more` : names.join(' and ');
}

function createBlockCard(block, index) {
  const blockId = `block-${index}`;
  const isExpanded = expandedBlocks.has(block);
  const blockName = blockContentName(block, index);
  const row = createElement('li', { class: 'layout-block', 'data-type': block.type, 'data-expanded': String(isExpanded) });

  const toggle = createElement('button', {
    type: 'button',
    class: 'layout-block-toggle',
    id: `${blockId}-toggle`,
    'aria-expanded': String(isExpanded),
    'aria-controls': `${blockId}-body`,
    'data-block-index': index,
    onClick: handleToggleBlock,
  });
  toggle.append(
    createElement('span', { class: 'layout-block-type' }, BLOCK_NAMES[block.type]),
    createElement('span', { class: 'layout-block-copy' },
      createElement('span', { class: 'layout-block-name', id: `${blockId}-name` }, blockName),
      createElement('span', { class: 'layout-block-summary', id: `${blockId}-summary` }, describeBlock(block)),
    ),
    createElement('span', { class: 'layout-block-chevron', 'aria-hidden': 'true' }, isExpanded ? '▴' : '▾'),
  );

  const heading = createElement('div', { class: 'layout-block-head' });
  heading.append(toggle, createBlockOrderControls(index, blockId, `${BLOCK_NAMES[block.type]} ${index + 1}`));
  row.append(heading);
  const body = createElement('div', { class: 'layout-block-body', id: `${blockId}-body`, hidden: !isExpanded });
  body.append(createBlockEditor(block, index, blockId));
  row.append(body);
  return row;
}

function handleToggleBlock(event) {
  const index = Number(event.currentTarget.dataset.blockIndex);
  const block = reportSelection.layout[index];
  if (expandedBlocks.has(block)) {
    expandedBlocks.delete(block);
  } else {
    expandedBlocks.add(block);
  }
  renderLayout(`block-${index}-toggle`);
}

function createBlockOrderControls(index, blockId, blockName) {
  const orderControls = createElement('span', { class: 'order' });
  const upButton = createElement('button', {
    type: 'button', class: 'icon', id: `${blockId}-up`,
    'aria-label': `Move ${blockName} up`, disabled: index === 0,
    'data-block-index': index, 'data-direction': -1, onClick: handleMoveBlock,
  }, '↑');
  const downButton = createElement('button', {
    type: 'button', class: 'icon', id: `${blockId}-down`,
    'aria-label': `Move ${blockName} down`, disabled: index === reportSelection.layout.length - 1,
    'data-block-index': index, 'data-direction': 1, onClick: handleMoveBlock,
  }, '↓');
  const removeButton = createElement('button', {
    type: 'button', class: 'icon', id: `${blockId}-remove`, 'aria-label': `Remove ${blockName}`,
    'data-block-index': index, onClick: handleRemoveBlock,
  }, '✕');
  orderControls.append(upButton, downButton, removeButton);
  return orderControls;
}

function createBlockEditor(block, index, blockId) {
  if (block.type === 'text') {
    return createElement('textarea', {
      id: `${blockId}-text`, rows: 6, maxlength: 4000,
      'aria-label': `Text ${index + 1}`, value: block.text,
      placeholder: '## Heading\n\nA paragraph of text.\n\n- A list item',
      'data-block-index': index, onInput: handleBlockTextChange,
    });
  }

  const editor = createElement('div', { class: 'block-editor' });
  if (block.type === 'chart') {
    const titleInput = createElement('input', {
      id: `${blockId}-title`, maxlength: 120, value: block.title || '',
      placeholder: 'Uses the field names',
      'data-block-index': index, onInput: handleChartTitleChange,
    });
    const chartTypeSelect = createElement('select', {
      id: `${blockId}-type`, 'data-block-index': index, onChange: handleChartTypeChange,
    });
    for (const chartType of CHART_TYPES) {
      chartTypeSelect.append(createElement('option', {
        value: chartType.value, selected: block.chartType === chartType.value,
      }, chartType.label));
    }
    const settings = createElement('div', { class: 'block-editor-row' });
    settings.append(
      createElement('div', {}, createElement('label', { for: titleInput.id }, 'Chart title'), titleInput),
      createElement('div', {}, createElement('label', { for: chartTypeSelect.id }, 'Chart type'), chartTypeSelect),
    );
    editor.append(settings);
  }
  editor.append(createBlockFieldScope(block, index, blockId));
  if (block.type === 'chart') {
    const hint = createElement('div', { class: 'block-hint', id: `${blockId}-hint-box`, hidden: true });
    hint.append(
      createElement('p', { id: `${blockId}-hint`, role: 'status' }),
      createElement('button', {
        type: 'button', class: 'link', 'data-block-index': index, onClick: handleUseSeparateCharts,
      }, 'Use one chart per field'),
    );
    editor.append(hint);
    editor.append(createSeriesColorEditor(block, index, blockId));
  }
  return editor;
}

/**
 * Fields without a known unit share an axis, so a count of clients and a budget in dollars
 * can end up on one scale. After each preview, flag grouped charts whose fields differ widely.
 */
function updateRangeHints() {
  const largestByKey = new Map();
  for (const indicator of lastPreviewReport?.indicators ?? []) {
    const values = indicator.cells.map((cell) => Math.abs(cell.value ?? 0));
    largestByKey.set(indicator.key, Math.max(0, ...values));
  }
  for (const [index, block] of reportSelection.layout.entries()) {
    const hint = getElement(`block-${index}-hint`);
    if (!hint) {
      continue;
    }
    const message = block.type === 'chart' && block.chartType !== 'bar' ? findRangeProblem(block, largestByKey) : '';
    hint.textContent = message;
    getElement(`block-${index}-hint-box`).hidden = !message;
  }
}

function handleUseSeparateCharts(event) {
  const index = Number(event.currentTarget.dataset.blockIndex);
  reportSelection.layout[index].chartType = 'bar';
  renderLayout(`block-${index}-type`);
  selectionChanged();
}

function findRangeProblem(block, largestByKey) {
  const fieldsByUnit = new Map();
  for (const field of getChartedFields(block)) {
    if (!fieldsByUnit.has(field.unit)) {
      fieldsByUnit.set(field.unit, []);
    }
    fieldsByUnit.get(field.unit).push(field);
  }
  for (const fields of fieldsByUnit.values()) {
    const measured = fields.filter((field) => largestByKey.get(field.key) > 0);
    if (measured.length < 2) {
      continue;
    }
    measured.sort((first, second) => largestByKey.get(second.key) - largestByKey.get(first.key));
    const biggest = measured[0];
    const smallest = measured.at(-1);
    if (largestByKey.get(biggest.key) / largestByKey.get(smallest.key) > RANGE_WARNING_FACTOR) {
      return `${getFieldLabel(smallest)} is much smaller than ${getFieldLabel(biggest)} and will be hard to see on a shared scale.`;
    }
  }
  return '';
}

function currentPalette() {
  return resolveReportStyle(findSelectedDataset()?.reportStyle, reportSelection.styleOverrides).palette;
}

/** The fields this chart block draws, in report order. */
function getChartedFields(block) {
  const eligible = getEligibleFields(block);
  if (block.indicators.length === 0) {
    return eligible;
  }
  return eligible.filter((field) => block.indicators.includes(field.key));
}

/**
 * The palette color each field gets when no color is chosen. Mirrors the server: fields are
 * grouped by unit (or one per chart for "one chart per field") and colored in order.
 */
function defaultSeriesColors(block, fields) {
  const palette = currentPalette();
  const colors = new Map();
  const positionsByUnit = new Map();
  for (const field of fields) {
    if (block.chartType === 'bar') {
      colors.set(field.key, palette[0]);
      continue;
    }
    const position = positionsByUnit.get(field.unit) ?? 0;
    colors.set(field.key, palette[position % palette.length]);
    positionsByUnit.set(field.unit, position + 1);
  }
  return colors;
}

/** A color box for every charted field. Only colors that differ from the default are saved. */
function createSeriesColorEditor(block, index, blockId) {
  const fields = getChartedFields(block);
  const container = createElement('fieldset', { class: 'block-colors' });
  container.append(createElement('legend', {}, 'Colors'));
  if (fields.length === 0) {
    container.hidden = true;
    return container;
  }
  const defaults = defaultSeriesColors(block, fields);
  const swatches = createElement('div', { class: 'color-chips' });
  for (const field of fields) {
    const inputId = `${blockId}-color-${field.key}`;
    const input = createElement('input', {
      type: 'color',
      id: inputId,
      value: block.colors?.[field.key] ?? defaults.get(field.key),
      'data-block-index': index,
      'data-indicator': field.key,
      onInput: handleSeriesColorInput,
    });
    const label = createElement('label', { for: inputId, class: 'color-chip' }, input, getFieldLabel(field));
    swatches.append(label);
  }
  container.append(swatches);
  if (Object.keys(block.colors ?? {}).length > 0) {
    container.append(createElement('button', {
      type: 'button', class: 'link', id: `${blockId}-reset-colors`,
      'data-block-index': index, onClick: handleResetSeriesColors,
    }, 'Use report colors'));
  }
  return container;
}

function handleSeriesColorInput(event) {
  const input = event.currentTarget;
  const block = reportSelection.layout[Number(input.dataset.blockIndex)];
  block.colors = { ...(block.colors ?? {}), [input.dataset.indicator]: input.value };
}

function handleResetSeriesColors(event) {
  const index = Number(event.currentTarget.dataset.blockIndex);
  delete reportSelection.layout[index].colors;
  renderLayout(`block-${index}-toggle`);
  selectionChanged();
}

/** "All report fields" is explicit, so a block never silently leaves out a newly added field. */
function createBlockFieldScope(block, index, blockId) {
  const eligibleFields = getEligibleFields(block);
  const container = createElement('fieldset', { class: 'block-scope' });
  container.append(createElement('legend', {}, block.type === 'chart' ? 'Fields in this chart' : 'Fields in this table'));
  if (eligibleFields.length === 0) {
    const message = block.type === 'chart' && reportSelection.indicators.length
      ? 'Charts need a number field. Tick one in step 2, Show.'
      : 'Tick what to show in step 2 first.';
    container.append(createElement('p', { class: 'muted small' }, message));
    return container;
  }

  const usesAllFields = block.indicators.length === 0;
  const allLabel = block.type === 'chart' ? 'All numeric report fields' : 'All report fields';
  const scopeRow = createElement('div', { class: 'block-scope-options' });
  for (const [value, text] of [['all', allLabel], ['some', 'Choose fields']]) {
    const radio = createElement('input', {
      type: 'radio',
      name: `${blockId}-scope`,
      value,
      checked: (value === 'all') === usesAllFields,
      'data-block-index': index,
      onChange: handleBlockScopeChange,
    });
    scopeRow.append(createElement('label', { class: 'check' }, radio, text));
  }
  container.append(scopeRow);
  if (block.type === 'chart' && usesAllFields) {
    container.append(createElement('p', { class: 'muted small' }, 'Fields with different units are drawn as separate charts.'));
  }

  if (!usesAllFields) {
    const chips = createElement('div', { class: 'block-field-chips' });
    for (const field of eligibleFields) {
      const checkbox = createElement('input', {
        type: 'checkbox',
        checked: block.indicators.includes(field.key),
        'data-block-index': index,
        'data-indicator': field.key,
        onChange: handleBlockIndicatorChange,
      });
      const label = createElement('label', { class: 'chip-check' }, checkbox, getFieldLabel(field));
      label.title = fieldUnitLabel(field);
      chips.append(label);
    }
    container.append(chips);
  }
  return container;
}

function handleBlockScopeChange(event) {
  const radio = event.currentTarget;
  const index = Number(radio.dataset.blockIndex);
  const block = reportSelection.layout[index];
  if (radio.value === 'all') {
    block.indicators = [];
  } else {
    // Start from every field so the user narrows the list instead of rebuilding it.
    block.indicators = getEligibleFields(block).map((field) => field.key);
  }
  renderLayout(`block-${index}-toggle`);
}

function handleBlockTextChange(event) {
  const input = event.currentTarget;
  const index = Number(input.dataset.blockIndex);
  reportSelection.layout[index].text = input.value;
  getElement(`block-${index}-summary`).textContent = describeBlock(reportSelection.layout[index]);
}

function handleChartTitleChange(event) {
  const input = event.currentTarget;
  const index = Number(input.dataset.blockIndex);
  reportSelection.layout[index].title = input.value;
  getElement(`block-${index}-name`).textContent = input.value || `Chart ${index + 1}`;
}

function handleChartTypeChange(event) {
  const input = event.currentTarget;
  const index = Number(input.dataset.blockIndex);
  reportSelection.layout[index].chartType = input.value;
  renderLayout(`block-${index}-type`);
}

function handleBlockIndicatorChange(event) {
  const checkbox = event.currentTarget;
  const index = Number(checkbox.dataset.blockIndex);
  const block = reportSelection.layout[index];
  const indicatorKey = checkbox.dataset.indicator;
  if (checkbox.checked) {
    // Keep the report's field order inside the block.
    const chosen = new Set([...block.indicators, indicatorKey]);
    block.indicators = reportSelection.indicators.filter((key) => chosen.has(key));
  } else if (block.indicators.length === 1) {
    // An empty list means "every field", so the last field cannot be unticked here.
    checkbox.checked = true;
    showStatus(getElement('builder-status'), 'A block needs at least one field. Choose "All report fields" to include every field.');
    return;
  } else {
    block.indicators = block.indicators.filter((key) => key !== indicatorKey);
  }
  renderLayout(`block-${index}-toggle`);
}

function createBlock(type) {
  if (type === 'text') {
    return { type, text: '' };
  }
  if (type === 'chart') {
    return { type, chartType: defaultChartType, indicators: [] };
  }
  return { type, indicators: [] };
}

function handleAddBlock(event) {
  addBlock(event.currentTarget.dataset.addBlock);
}

function addBlock(type, fields = {}) {
  const block = { ...createBlock(type), ...fields };
  reportSelection.layout.push(block);
  expandedBlocks.add(block);
  const index = reportSelection.layout.length - 1;
  let focusId = `block-${index}-toggle`;
  if (type === 'text') {
    focusId = `block-${index}-text`;
  } else if (type === 'chart') {
    focusId = `block-${index}-title`;
  }
  renderLayout(focusId);
  getElement(focusId)?.scrollIntoView({ block: 'nearest' });
  selectionChanged();
}

function handleMoveBlock(event) {
  const button = event.currentTarget;
  const currentIndex = Number(button.dataset.blockIndex);
  const direction = Number(button.dataset.direction);
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= reportSelection.layout.length) {
    return;
  }

  const movedBlock = reportSelection.layout[currentIndex];
  reportSelection.layout[currentIndex] = reportSelection.layout[nextIndex];
  reportSelection.layout[nextIndex] = movedBlock;
  const focusDirection = direction < 0 ? 'up' : 'down';
  renderLayout(`block-${nextIndex}-${focusDirection}`);
  selectionChanged();
}

function handleRemoveBlock(event) {
  const index = Number(event.currentTarget.dataset.blockIndex);
  const [removedBlock] = reportSelection.layout.splice(index, 1);
  expandedBlocks.delete(removedBlock);
  const nextIndex = Math.min(index, reportSelection.layout.length - 1);
  if (nextIndex >= 0) {
    renderLayout(`block-${nextIndex}-remove`);
  } else {
    renderLayout();
    document.querySelector('[data-add-block="chart"]').focus();
  }
  selectionChanged();
}

// ---- Preview --------------------------------------------------------------------------------

/** Keep the last preview on screen while a new one loads, so the pane does not jump. */
function markPreviewStale() {
  previewRequestNumber++;
  getElement('preview').classList.add('is-stale');
  showStatus(getElement('preview-status'), 'Updating…');
}

function getPreviewProblem() {
  if (!reportSelection.dataset) {
    return {
      title: 'No published dataset',
      text: 'A data administrator needs to upload and publish a dataset before reports can be built.',
    };
  }
  if (!findSelectedDataset()) {
    return {
      title: 'This dataset is no longer published',
      text: 'Choose a current dataset in step 1 to keep working on this report.',
      tab: 'data',
      action: 'Choose a dataset',
    };
  }
  if (availableIndicators.length === 0) {
    return {
      title: 'No approved fields yet',
      text: 'Staff must approve this dataset’s fields before it can be used in a report.',
      tab: 'data',
      action: 'Choose another dataset',
    };
  }
  if (!reportSelection.allRows && reportSelection.rows.length === 0) {
    const plural = pluralize(rowNoun).toLowerCase();
    return {
      title: `Choose ${plural}`,
      text: `Tick one or more ${plural} in the list, or use Select all, to start the report.`,
      tab: 'data',
      action: 'Choose what to compare',
    };
  }
  if (reportSelection.indicators.length === 0) {
    return {
      title: 'Choose what to show',
      text: 'Tick at least one piece of information to put in the chart and table.',
      tab: 'fields',
      action: 'Choose what to show',
    };
  }
  if (reportSelection.layout.length === 0) {
    return {
      title: 'Add content',
      text: 'The report has no charts, tables or text yet.',
      tab: 'content',
      action: 'Go to Content',
    };
  }
  return null;
}

function showPreviewEmpty(problem) {
  const empty = getElement('preview-empty');
  if (!problem) {
    empty.hidden = true;
    return;
  }
  getElement('preview-empty-title').textContent = problem.title;
  getElement('preview-empty-text').textContent = problem.text;
  const action = getElement('preview-empty-action');
  action.hidden = !problem.tab;
  action.textContent = problem.action ?? '';
  action.dataset.tab = problem.tab ?? '';
  empty.hidden = false;
}

function handleEmptyAction(event) {
  const tabName = event.currentTarget.dataset.tab;
  if (tabName) {
    selectTab(tabName);
  }
}

async function refreshPreview() {
  if (isLoadingOptions) {
    return;
  }
  const requestNumber = ++previewRequestNumber;
  const preview = getElement('preview');
  const problem = getPreviewProblem();
  if (problem) {
    lastPreviewReport = null;
    clearReport(preview);
    preview.classList.remove('is-stale');
    showStatus(getElement('preview-status'), '');
    showPreviewEmpty(problem);
    return;
  }

  try {
    const report = await api('/reports/preview', { method: 'POST', json: reportSelection });
    // An older response must not overwrite changes made while it was loading.
    if (requestNumber !== previewRequestNumber) {
      return;
    }
    const scrollContainer = preview.closest('.builder-preview');
    const scrollTop = scrollContainer.scrollTop;
    showPreviewEmpty(null);
    renderReport(preview, report);
    scrollContainer.scrollTop = scrollTop;
    preview.classList.remove('is-stale');
    lastPreviewReport = report;
    updateRangeHints();
    getElement('title').placeholder = `Default: ${report.title}`;
    getElement('subtitle').placeholder = `Default: ${report.subtitle}`;
    showStatus(getElement('preview-status'), '');
  } catch (error) {
    if (requestNumber === previewRequestNumber) {
      lastPreviewReport = null;
      clearReport(preview);
      preview.classList.remove('is-stale');
      showStatus(getElement('preview-status'), '');
      showPreviewEmpty({ title: 'The preview could not be built', text: error.message });
    }
  }
}

// ---- Save, export, AI -----------------------------------------------------------------------

function createSnapshot() {
  return JSON.stringify({ name: getElement('report-name').value.trim(), selection: reportSelection });
}

function hasUnsavedChanges() {
  return createSnapshot() !== savedSnapshot;
}

function updateSaveState() {
  renderSaveSummary();
  const saveState = getElement('save-state');
  if (hasUnsavedChanges()) {
    saveState.textContent = 'Unsaved changes';
    saveState.dataset.kind = 'dirty';
  } else if (savedReport) {
    saveState.textContent = 'All changes saved';
    saveState.dataset.kind = 'saved';
  } else {
    saveState.textContent = '';
    saveState.dataset.kind = '';
  }
}

function warnAboutUnsavedChanges(event) {
  if (hasUnsavedChanges() && (savedReport || reportSelection.indicators.length > 0)) {
    event.preventDefault();
  }
}

function handleSaveShortcut(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveReport();
  }
}

function handleReportNameKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveReport();
  }
}

function updateHeading() {
  const viewLink = getElement('view-report');
  viewLink.hidden = !savedReport?.viewUrl;
  if (savedReport?.viewUrl) {
    viewLink.href = savedReport.viewUrl;
  }
  const heading = getElement('builder-heading');
  heading.textContent = savedReport ? savedReport.title : 'New report';
  getElement('save').textContent = 'Save report';
  if (savedReport && savedReport.ownerId !== currentUser.id) {
    getElement('save').textContent = 'Save as my copy';
  }
  document.title = `${heading.textContent} · Report builder · CT Civic Data Explorer`;
}

async function saveReport() {
  readFormControls();
  const nameInput = getElement('report-name');
  // An unnamed report takes its displayed title, which the preview always has.
  if (!nameInput.value.trim() && lastPreviewReport?.title) {
    nameInput.value = lastPreviewReport.title.slice(0, 200);
  }
  const title = nameInput.value.trim();
  if (!title) {
    showStatus(getElement('builder-status'), 'Give the report a name before saving.', 'error');
    nameInput.focus();
    return;
  }

  const saveButton = getElement('save');
  saveButton.disabled = true;
  try {
    const requestBody = { title, selection: reportSelection };
    let report;
    if (savedReport && savedReport.ownerId === currentUser.id) {
      report = await api(`/reports/${savedReport.id}`, { method: 'PUT', json: requestBody });
    } else {
      report = await api('/reports', { method: 'POST', json: requestBody });
    }
    savedReport = { id: report.id, ownerId: report.createdBy.id, title: report.title, viewUrl: report.viewUrl };
    history.replaceState(null, '', `/builder?report=${report.id}`);
    updateHeading();
    savedSnapshot = createSnapshot();
    updateSaveState();
    showStatus(getElement('builder-status'), '');
  } catch (error) {
    showStatus(getElement('builder-status'), error.message, 'error');
  } finally {
    saveButton.disabled = false;
  }
}

async function downloadPdf(event) {
  readFormControls();
  const button = event.currentTarget;
  const problem = getPreviewProblem();
  if (problem) {
    showStatus(getElement('builder-status'), `Nothing to export yet. ${problem.text}`, 'error');
    return;
  }
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = 'Exporting…';
  try {
    const { blob, filename } = await api('/reports/pdf', { method: 'POST', json: reportSelection, expect: 'blob' });
    downloadBlob(blob, filename);
    showStatus(getElement('builder-status'), `Downloaded ${filename}.`, 'ok');
  } catch (error) {
    showStatus(getElement('builder-status'), `No PDF was created: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function draftSummary() {
  readFormControls();
  const buttons = [getElement('draft-summary'), getElement('draft-regenerate')];
  for (const button of buttons) {
    button.disabled = true;
  }
  showStatus(getElement('builder-status'), 'Drafting a summary…');

  try {
    const { text, mismatches } = await api('/reports/summary', { method: 'POST', json: reportSelection });
    getElement('draft-text').value = text;
    const warningList = getElement('draft-warnings');
    warningList.replaceChildren();
    for (const mismatch of mismatches) {
      warningList.append(createElement('li', {}, mismatch.message));
    }
    getElement('draft').hidden = false;
    if (mismatches.length > 0) {
      showStatus(getElement('builder-status'), 'Draft ready. Some figures could not be verified against the report; check them first.', 'error');
    } else {
      showStatus(getElement('builder-status'), '');
    }
    getElement('draft-text').focus();
  } catch (error) {
    showStatus(getElement('builder-status'), error.message, 'error');
  } finally {
    for (const button of buttons) {
      button.disabled = false;
    }
  }
}

function acceptDraft() {
  // The generated summary is only added to the report after the user accepts it.
  getElement('draft').hidden = true;
  addBlock('text', { text: getElement('draft-text').value.trim() });
}

function discardDraft() {
  getElement('draft').hidden = true;
  getElement('draft-text').value = '';
  getElement('draft-summary').focus();
}

// ---- Appearance -----------------------------------------------------------------------------

function updateStyleEditor() {
  if (!styleEditor) {
    return;
  }
  styleEditor.set(reportSelection.styleOverrides, findSelectedDataset()?.reportStyle);
}

function handleStyleChange(overrides) {
  reportSelection.styleOverrides = overrides;
  renderLayout();
  selectionChanged();
}

boot(initializeBuilder);
