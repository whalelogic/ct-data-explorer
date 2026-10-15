/**
 * The report selection is shared by the preview, PDF, summary, and save APIs.
 * Form controls and the layout editor update this same object.
 */
import { api, loadSession } from './api.js';
import { clearReport, renderReport } from './report-view.js';
import { h as createElement } from './dom.js';
import { boot, debounce, downloadBlob, renderHeader, showStatus } from './layout.js';

const BLOCK_NAMES = { text: 'Text', chart: 'Chart', table: 'Table' };
const CHART_TYPES = [
  { value: 'grouped_bar', label: 'Compare selected fields' },
  { value: 'bar', label: 'Separate charts' },
  { value: 'line', label: 'Line' },
];

let currentUser = null;
let activeDatasets = [];
let datasetOptions = [];
let availableTowns = [];
let availableIndicators = [];
let indicatorsByKey = new Map();
let savedReport = null;
let reportSelection = null;
let optionsRequestNumber = 0;
let previewRequestNumber = 0;
let isLoadingOptions = false;
let defaultChartType = 'grouped_bar';

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

  const [datasets, towns] = await Promise.all([api('/datasets'), api('/towns')]);
  activeDatasets = datasets.filter((dataset) => dataset.isActive);
  await loadInitialSelection();

  renderDatasetOptions();
  fillFormControls(towns);
  getElement('ai-panel').hidden = !session.features.aiSummary;
  updateHeading();

  await loadDatasetColumns();
  renderIndicators();
  renderLayout();
  registerEventHandlers();
  await refreshPreview();
}

async function loadInitialSelection() {
  const queryParameters = new URLSearchParams(location.search);
  const requestedDataset = activeDatasets.find((dataset) => String(dataset.id) === queryParameters.get('dataset'));
  const initialDataset = requestedDataset ?? activeDatasets[0];

  if (queryParameters.has('dataset') && !requestedDataset && !queryParameters.has('report')) {
    throw new Error('This dataset is no longer active. Choose another dataset from the dashboard.');
  }

  reportSelection = {
    dataset: null,
    towns: [],
    benchmark: true,
    indicators: [],
    showTitle: true,
    title: '',
    subtitle: '',
    layout: [createBlock('chart'), createBlock('table')],
    recordFilters: {},
    fieldOverrides: {},
  };

  if (initialDataset) {
    defaultChartType = initialDataset.defaultChartType || 'grouped_bar';
    reportSelection.layout[0].chartType = defaultChartType;
    reportSelection.dataset = { name: initialDataset.name, vintage: initialDataset.vintage };
  }
  if (queryParameters.get('town')) {
    reportSelection.towns = [queryParameters.get('town')];
  }
  if (queryParameters.get('from') === 'explore') {
    loadExplorerDraft();
  }
  if (queryParameters.has('report')) {
    const reportId = encodeURIComponent(queryParameters.get('report'));
    const report = await api(`/reports/${reportId}`);
    savedReport = { id: report.id, ownerId: report.createdBy.id, title: report.title };
    reportSelection = { ...reportSelection, ...report.selection };
  }
}

function loadExplorerDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem('ctdata:explore-selection'));
    if (!draft) {
      return;
    }
    const hasActiveDataset = activeDatasets.some((dataset) => isSameDataset(dataset, draft.dataset ?? {}));
    if (hasActiveDataset) {
      reportSelection = { ...reportSelection, ...draft };
    }
  } catch {
    // If browser storage is unavailable or invalid, keep the new report defaults.
  }
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
}

function fillFormControls(towns) {
  availableTowns = towns.filter((town) => town.geoType === 'town');
  renderTownSelection();
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
  // The layout editor updates reportSelection.layout directly.
}

function registerEventHandlers() {
  const form = getElement('builder-form');
  form.addEventListener('submit', preventFormSubmission);
  form.addEventListener('input', handleFormChange);
  form.addEventListener('change', handleFormChange);
  getElement('dataset').addEventListener('change', handleDatasetChange);
  getElement('add-town').addEventListener('click', addTown);
  getElement('town-primary').addEventListener('keydown', handleTownKeydown);
  getElement('select-all-towns').addEventListener('click', selectAllTowns);
  getElement('clear-towns').addEventListener('click', clearTowns);
  getElement('save').addEventListener('click', saveReport);
  getElement('reset-overrides').addEventListener('click', resetFieldOverrides);
  getElement('pdf').addEventListener('click', downloadPdf);
  getElement('draft-summary').addEventListener('click', draftSummary);
  getElement('draft-regenerate').addEventListener('click', draftSummary);
  getElement('draft-accept').addEventListener('click', acceptDraft);
  getElement('draft-discard').addEventListener('click', discardDraft);

  for (const button of document.querySelectorAll('[data-add-block]')) {
    button.addEventListener('click', handleAddBlock);
  }
}

function preventFormSubmission(event) {
  event.preventDefault();
}

function renderTownSelection() {
  const townOptions = getElement('town-options');
  const selectedList = getElement('builder-towns');
  townOptions.replaceChildren();
  selectedList.replaceChildren();
  selectedList.tabIndex = 0;
  selectedList.setAttribute('role', 'region');

  for (const town of availableTowns) {
    if (!reportSelection.towns.includes(town.name)) {
      townOptions.append(createElement('option', { value: town.name }));
    }
  }
  for (const townName of reportSelection.towns) {
    const removeButton = createElement('button', {
      type: 'button',
      class: 'explorer-town secondary',
      'aria-label': `Remove ${townName}`,
      'data-town': townName,
      onClick: removeTown,
    }, townName);
    removeButton.append(createElement('span', { 'aria-hidden': 'true' }, ' ×'));
    selectedList.append(removeButton);
  }
  getElement('builder-town-count').textContent = `${reportSelection.towns.length} towns selected · ${availableTowns.length} available`;
  getElement('add-town').disabled = availableTowns.length === 0;
  getElement('select-all-towns').disabled = availableTowns.length === 0;
  getElement('clear-towns').disabled = reportSelection.towns.length === 0;
}

function handleTownKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    addTown();
  }
}

function addTown() {
  const typedName = getElement('town-primary').value.trim().toLowerCase();
  const town = availableTowns.find((candidate) => candidate.name.toLowerCase() === typedName);
  if (!town) {
    showStatus(getElement('builder-town-status'), 'Choose a town available in this dataset.');
    return;
  }
  if (reportSelection.towns.includes(town.name)) {
    showStatus(getElement('builder-town-status'), `${town.name} is already selected.`);
    return;
  }
  reportSelection.towns.push(town.name);
  getElement('town-primary').value = '';
  updateTowns();
  getElement('town-primary').focus();
}

function removeTown(event) {
  const townName = event.currentTarget.dataset.town;
  reportSelection.towns = reportSelection.towns.filter((selectedName) => selectedName !== townName);
  updateTowns();
  getElement('town-primary').focus();
}

function selectAllTowns() {
  reportSelection.towns = availableTowns.map((town) => town.name);
  updateTowns();
}

function clearTowns() {
  reportSelection.towns = [];
  updateTowns();
}

function updateTowns() {
  showStatus(getElement('builder-town-status'), '');
  renderTownSelection();
  invalidatePreview();
  schedulePreview();
}

function handleFormChange(event) {
  if (event.target.closest('[data-no-preview]')) {
    return;
  }
  invalidatePreview();
  readFormControls();
  if (event.target.id !== 'dataset') {
    schedulePreview();
  }
}

async function handleDatasetChange() {
  readFormControls();
  reportSelection.recordFilters = {};
  reportSelection.fieldOverrides = {};
  try {
    const loaded = await loadDatasetColumns();
    if (!loaded) {
      return;
    }
    const availableTownNames = new Set(availableTowns.map((town) => town.name));
    const previousTownCount = reportSelection.towns.length;
    reportSelection.towns = reportSelection.towns.filter((town) => availableTownNames.has(town));
    renderTownSelection();
    const removedTownCount = previousTownCount - reportSelection.towns.length;
    const removedTownLabel = removedTownCount === 1 ? 'town is' : 'towns are';
    const removedMessage = removedTownCount > 0
      ? `${removedTownCount} previously selected ${removedTownLabel} not available in this dataset. The selection has been updated.`
      : '';
    showStatus(getElement('builder-town-status'), removedMessage);
    renderIndicators();
    renderLayout();
    await refreshPreview();
  } catch (error) {
    showStatus(getElement('preview-status'), error.message, 'error');
  }
}

async function loadDatasetColumns() {
  const requestNumber = ++optionsRequestNumber;
  isLoadingOptions = true;
  const selectedDataset = activeDatasets.find((dataset) => reportSelection.dataset && isSameDataset(dataset, reportSelection.dataset));
  let options = { columns: [], filters: [], places: [], hasState: false };

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
  availableTowns = options.places.filter((place) => place.geoType === 'town');
  renderTownSelection();
  indicatorsByKey = new Map();
  for (const indicator of availableIndicators) {
    indicatorsByKey.set(indicator.key, indicator);
  }
  reportSelection.indicators = reportSelection.indicators.filter((key) => indicatorsByKey.has(key));
  removeUnselectedBlockIndicators();
  if (availableIndicators.length === 0) {
    showStatus(getElement('builder-status'), 'This dataset has no approved fields. Choose another dataset or ask a data administrator to review it.');
  }

  getElement('benchmark').disabled = !options.hasState;
  if (!options.hasState) {
    reportSelection.benchmark = false;
    getElement('benchmark').checked = false;
  }
  renderRecordFilters(options.filters);
  isLoadingOptions = false;
  return true;
}

function renderRecordFilters(filters) {
  getElement('record-filter-panel').hidden = filters.length === 0;
  const filterContainer = getElement('record-filters');
  filterContainer.replaceChildren();

  for (const filter of filters) {
    const select = createElement('select', { id: `filter-${filter.key}`, 'data-column': filter.key });
    select.append(createElement('option', { value: '' }, 'All source rows'));
    for (const value of filter.values) {
      select.append(createElement('option', { value }, value));
    }
    select.value = reportSelection.recordFilters?.[filter.key] ?? '';

    const filterRow = createElement('div');
    filterRow.append(createElement('label', { for: select.id }, filter.label), select);
    filterContainer.append(filterRow);
  }
}

function removeUnselectedBlockIndicators() {
  for (const key of Object.keys(reportSelection.fieldOverrides ?? {})) {
    if (!reportSelection.indicators.includes(key)) delete reportSelection.fieldOverrides[key];
  }
  for (const block of reportSelection.layout) {
    if (block.indicators) {
      block.indicators = block.indicators.filter((key) => reportSelection.indicators.includes(key));
    }
  }
}

function renderIndicators(focusId) {
  const chosenKeys = reportSelection.indicators.filter((key) => indicatorsByKey.has(key));
  const orderedKeys = [...chosenKeys];
  for (const indicator of availableIndicators) {
    if (!chosenKeys.includes(indicator.key)) {
      orderedKeys.push(indicator.key);
    }
  }

  const indicatorList = getElement('indicator-list');
  indicatorList.replaceChildren();
  for (const key of orderedKeys) {
    const indicator = indicatorsByKey.get(key);
    const position = chosenKeys.indexOf(key);
    const inputId = `indicator-${key}`;
    const row = createElement('li');
    const checkbox = createElement('input', {
      type: 'checkbox',
      id: inputId,
      checked: position !== -1,
      'data-indicator': key,
      onChange: handleIndicatorChange,
    });
    row.append(checkbox, createElement('label', { for: inputId }, indicator.displayLabel));

    if (position !== -1) {
      const orderControls = createElement('span', { class: 'order' });
      const upButton = createElement('button', {
        type: 'button', class: 'icon', id: `${inputId}-up`,
        'aria-label': `Move ${indicator.label} up`, disabled: position === 0,
        'data-indicator': key, 'data-direction': -1, onClick: handleMoveIndicator,
      }, '↑');
      const downButton = createElement('button', {
        type: 'button', class: 'icon', id: `${inputId}-down`,
        'aria-label': `Move ${indicator.label} down`, disabled: position === chosenKeys.length - 1,
        'data-indicator': key, 'data-direction': 1, onClick: handleMoveIndicator,
      }, '↓');
      orderControls.append(upButton, downButton);
      row.append(orderControls);
    }
    indicatorList.append(row);
  }
  renderFieldOverrides();
  restoreFocus(focusId, 'button:not(:disabled), input');
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
  invalidatePreview();
  if (checkbox.checked) {
    reportSelection.indicators.push(indicatorKey);
  } else {
    reportSelection.indicators = reportSelection.indicators.filter((key) => key !== indicatorKey);
  }
  removeUnselectedBlockIndicators();
  renderIndicators(`indicator-${indicatorKey}`);
  renderLayout();
  schedulePreview();
}

function handleMoveIndicator(event) {
  const button = event.currentTarget;
  const indicatorKey = button.dataset.indicator;
  const direction = Number(button.dataset.direction);
  invalidatePreview();

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
  renderIndicators(`indicator-${indicatorKey}-${focusDirection}`);
  schedulePreview();
}

function renderLayout(focusId) {
  const layoutList = getElement('layout-list');
  layoutList.replaceChildren();
  for (const [index, block] of reportSelection.layout.entries()) {
    const blockId = `block-${index}`;
    const blockName = `${BLOCK_NAMES[block.type]} block ${index + 1}`;
    const row = createElement('li', { class: 'layout-block', 'aria-labelledby': `${blockId}-name` });
    const heading = createElement('div', { class: 'layout-block-head' });
    const nameLabel = createElement('span', { id: `${blockId}-name`, class: 'layout-block-name' }, blockName);
    heading.append(nameLabel, createBlockOrderControls(index, blockId, blockName));
    row.append(heading, createBlockEditor(block, index, blockId, blockName));
    layoutList.append(row);
  }

  if (reportSelection.layout.length === 0) {
    layoutList.append(createElement('li', { class: 'muted small' }, 'Add a chart or a table so the report shows its figures.'));
  }
  restoreFocus(focusId, 'button:not(:disabled), textarea, select');
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
    type: 'button', class: 'icon', 'aria-label': `Remove ${blockName}`,
    'data-block-index': index, onClick: handleRemoveBlock,
  }, '✕');
  orderControls.append(upButton, downButton, removeButton);
  return orderControls;
}

function createBlockEditor(block, index, blockId, blockName) {
  if (block.type === 'text') {
    return createElement('textarea', {
      id: `${blockId}-text`, rows: 5, maxlength: 4000,
      'aria-label': blockName, value: block.text,
      placeholder: '## Heading\n\nA paragraph of text.\n\n- A list item',
      'data-block-index': index, onInput: handleBlockTextChange,
    });
  }

  const editor = createElement('div');
  if (block.type === 'table') {
    editor.append(createElement('p', { class: 'muted small' }, 'Indicators in this table. Leave all unchecked to show every indicator.'));
  } else {
    const chartTypeSelect = createElement('select', {
      id: `${blockId}-type`, 'data-block-index': index, onChange: handleChartTypeChange,
    });
    for (const chartType of CHART_TYPES) {
      chartTypeSelect.append(createElement('option', {
        value: chartType.value, selected: block.chartType === chartType.value,
      }, chartType.label));
    }
    const titleInput = createElement('input', {
      id: `${blockId}-title`, maxlength: 120, value: block.title || '', placeholder: 'Use field names',
      'data-block-index': index, onInput: handleChartTitleChange,
    });
    editor.append(createElement('label', { for: titleInput.id }, 'Chart title'), titleInput);
    editor.append(createElement('label', { for: chartTypeSelect.id }, 'Chart type'), chartTypeSelect);
    editor.append(createElement('p', { class: 'muted small' }, 'Leave all fields unchecked to chart every selected numeric field. Fields with different units appear in separate charts.'));
  }
  editor.append(createBlockIndicatorOptions(block, index));
  return editor;
}

function createBlockIndicatorOptions(block, index) {
  const choices = createElement('div');
  for (const key of reportSelection.indicators) {
    const indicator = indicatorsByKey.get(key);
    if (!indicator || (block.type === 'chart' && indicator.type === 'text')) {
      continue;
    }
    const checkbox = createElement('input', {
      type: 'checkbox', checked: block.indicators.includes(key),
      'data-block-index': index, 'data-indicator': key, onChange: handleBlockIndicatorChange,
    });
    const label = createElement('label', { class: 'check' });
    label.append(checkbox, indicator.displayLabel);
    choices.append(label);
  }
  if (choices.childElementCount === 0) {
    return createElement('p', { class: 'muted small' }, 'Select indicators first.');
  }
  return choices;
}

function handleBlockTextChange(event) {
  const input = event.currentTarget;
  reportSelection.layout[Number(input.dataset.blockIndex)].text = input.value;
}

function handleChartTitleChange(event) {
  const input = event.currentTarget;
  reportSelection.layout[Number(input.dataset.blockIndex)].title = input.value;
}

function handleChartTypeChange(event) {
  const input = event.currentTarget;
  reportSelection.layout[Number(input.dataset.blockIndex)].chartType = input.value;
}

function handleBlockIndicatorChange(event) {
  const checkbox = event.currentTarget;
  const block = reportSelection.layout[Number(checkbox.dataset.blockIndex)];
  const indicatorKey = checkbox.dataset.indicator;
  if (checkbox.checked) {
    block.indicators.push(indicatorKey);
  } else {
    block.indicators = block.indicators.filter((key) => key !== indicatorKey);
  }
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
  invalidatePreview();
  reportSelection.layout.push({ ...createBlock(type), ...fields });
  const index = reportSelection.layout.length - 1;
  let focusId = `block-${index}-up`;
  if (type === 'text') {
    focusId = `block-${index}-text`;
  } else if (type === 'chart') {
    focusId = `block-${index}-type`;
  }
  renderLayout(focusId);
  schedulePreview();
}

function handleMoveBlock(event) {
  const button = event.currentTarget;
  const currentIndex = Number(button.dataset.blockIndex);
  const direction = Number(button.dataset.direction);
  const nextIndex = currentIndex + direction;
  invalidatePreview();
  if (nextIndex < 0 || nextIndex >= reportSelection.layout.length) {
    return;
  }

  const movedBlock = reportSelection.layout[currentIndex];
  reportSelection.layout[currentIndex] = reportSelection.layout[nextIndex];
  reportSelection.layout[nextIndex] = movedBlock;
  const focusDirection = direction < 0 ? 'up' : 'down';
  renderLayout(`block-${nextIndex}-${focusDirection}`);
  schedulePreview();
}

function handleRemoveBlock(event) {
  const index = Number(event.currentTarget.dataset.blockIndex);
  invalidatePreview();
  reportSelection.layout.splice(index, 1);
  const nextIndex = Math.min(index, reportSelection.layout.length - 1);
  if (nextIndex >= 0) {
    renderLayout(`block-${nextIndex}-up`);
  } else {
    renderLayout();
    document.querySelector('[data-add-block="chart"]').focus();
  }
  schedulePreview();
}

function invalidatePreview() {
  previewRequestNumber++;
  clearReport(getElement('preview'));
  showStatus(getElement('preview-status'), 'Updating preview…');
}

function getPreviewProblem() {
  if (!reportSelection.dataset) {
    return 'No active dataset is available. An administrator needs to upload and activate one.';
  }
  if (reportSelection.towns.length === 0) {
    return 'Choose a town to start the report.';
  }
  if (reportSelection.indicators.length === 0) {
    return 'Select at least one indicator for the report.';
  }
  return null;
}

async function refreshPreview() {
  if (isLoadingOptions) {
    return;
  }
  const requestNumber = ++previewRequestNumber;
  const problem = getPreviewProblem();
  if (problem) {
    clearReport(getElement('preview'));
    showStatus(getElement('preview-status'), problem);
    return;
  }

  try {
    const report = await api('/reports/preview', { method: 'POST', json: reportSelection });
    // An older response must not overwrite changes made while it was loading.
    if (requestNumber !== previewRequestNumber) {
      return;
    }
    showStatus(getElement('preview-status'), '');
    renderReport(getElement('preview'), report);
  } catch (error) {
    if (requestNumber === previewRequestNumber) {
      clearReport(getElement('preview'));
      showStatus(getElement('preview-status'), error.message, 'error');
    }
  }
}

function updateHeading() {
  getElement('builder-heading').textContent = 'Report builder';
  getElement('save').textContent = 'Save report';
  if (savedReport) {
    getElement('builder-heading').textContent = `Report: ${savedReport.title}`;
    if (savedReport.ownerId !== currentUser.id) {
      getElement('save').textContent = 'Save as my copy';
    }
  }
}

async function saveReport() {
  readFormControls();
  const title = getElement('report-name').value.trim();
  if (!title) {
    showStatus(getElement('builder-status'), 'Give the report a name before saving.', 'error');
    getElement('report-name').focus();
    return;
  }

  try {
    const requestBody = { title, selection: reportSelection };
    let report;
    if (savedReport && savedReport.ownerId === currentUser.id) {
      report = await api(`/reports/${savedReport.id}`, { method: 'PUT', json: requestBody });
    } else {
      report = await api('/reports', { method: 'POST', json: requestBody });
    }
    savedReport = { id: report.id, ownerId: report.createdBy.id, title: report.title };
    history.replaceState(null, '', `/builder?report=${report.id}`);
    updateHeading();
    showStatus(getElement('builder-status'), `Saved "${report.title}".`, 'ok');
  } catch (error) {
    showStatus(getElement('builder-status'), error.message, 'error');
  }
}

async function downloadPdf(event) {
  readFormControls();
  const button = event.currentTarget;
  button.disabled = true;
  showStatus(getElement('builder-status'), 'Generating PDF…');
  try {
    const { blob, filename } = await api('/reports/pdf', { method: 'POST', json: reportSelection, expect: 'blob' });
    downloadBlob(blob, filename);
    showStatus(getElement('builder-status'), `Downloaded ${filename}.`, 'ok');
  } catch (error) {
    showStatus(getElement('builder-status'), `No PDF was created: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
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
      showStatus(getElement('builder-status'), 'Draft ready for review.', 'ok');
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

boot(initializeBuilder);


function renderFieldOverrides() {
  const container = getElement('field-overrides');
  container.replaceChildren();
  for (const [index, key] of reportSelection.indicators.entries()) {
    const field = indicatorsByKey.get(key);
    if (!field) continue;
    const overrides = reportSelection.fieldOverrides?.[key] ?? {};
    const row = createElement('div', { class: 'report-field-override' });
    row.append(createElement('strong', {}, field.label));
    for (const [setting, label] of [['label', 'Display name'], ['description', 'Description']]) {
      const input = createElement('input', {
        id: `override-${index}-${setting}`, maxlength: setting === 'label' ? 120 : 500,
        value: overrides[setting] ?? '', placeholder: field[setting] || 'Use shared default',
        'data-field-key': key, 'data-setting': setting, onInput: handleFieldOverride,
      });
      row.append(createElement('label', { for: input.id }, `${label} for ${field.label}`), input);
    }
    if (field.type !== 'text') {
      const decimals = createElement('select', {
        id: `override-${index}-decimals`, 'data-field-key': key, 'data-setting': 'decimals', onChange: handleFieldOverride,
      });
      decimals.append(createElement('option', { value: '' }, `Shared default (${field.decimals})`));
      for (let digits = 0; digits <= 4; digits++) decimals.append(createElement('option', { value: String(digits) }, String(digits)));
      decimals.value = overrides.decimals === undefined ? '' : String(overrides.decimals);
      row.append(createElement('label', { for: decimals.id }, `Decimals for ${field.label}`), decimals);
    }
    container.append(row);
  }
  if (!container.children.length) container.append(createElement('p', { class: 'muted small' }, 'Select a field to customize its display.'));
}

function handleFieldOverride(event) {
  const input = event.currentTarget;
  reportSelection.fieldOverrides ??= {};
  const overrides = reportSelection.fieldOverrides[input.dataset.fieldKey] ?? {};
  if (input.value === '') delete overrides[input.dataset.setting];
  else overrides[input.dataset.setting] = input.dataset.setting === 'decimals' ? Number(input.value) : input.value;
  if (Object.keys(overrides).length) reportSelection.fieldOverrides[input.dataset.fieldKey] = overrides;
  else delete reportSelection.fieldOverrides[input.dataset.fieldKey];
}

function resetFieldOverrides() {
  reportSelection.fieldOverrides = {};
  renderFieldOverrides();
  invalidatePreview();
  schedulePreview();
}
