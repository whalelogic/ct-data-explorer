/**
 * The report selection is shared by the preview, PDF, summary, and save APIs.
 * Form controls and the layout editor update this same object.
 */
import { fieldUnitLabel, fieldValueLabel, groupFieldsByUnit } from '/shared/field-groups.js';
import { mountReportStyleEditor } from './report-style-editor.js';
import { api, loadSession } from './api.js';
import { clearReport, renderReport } from './report-view.js';
import { h as createElement } from './dom.js';
import { boot, debounce, downloadBlob, renderHeader, showStatus } from './layout.js';
import { initializeTabs, revealTab } from './tabs.js';

const BLOCK_NAMES = { text: 'Text', chart: 'Chart', table: 'Table' };
const CHART_TYPES = [
  { value: 'grouped_bar', label: 'Grouped bar' },
  { value: 'bar', label: 'Separate bars' },
  { value: 'line', label: 'Line' },
];

let styleEditor;
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
let currentDatasetOptions = { columns: [], places: [], dataFormat: 'records', hasState: false };
let defaultReportTitle = '';
let activeBlockIndex = 0;
let activeOverrideKey = '';

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

  renderDatasetOptions();
  fillFormControls();
  getElement('ai-panel').hidden = !session.features.aiSummary;
  updateHeading();

  await loadDatasetColumns();
  renderIndicators();
  renderLayout();
  styleEditor = mountReportStyleEditor(getElement('report-style'), {
    prefix: 'report-style', overrides: true,
    onChange: handleStyleChange,
  });
  initializeTabs(getElement('report-style'));
  updateStyleEditor();
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

function fillFormControls() {
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
  for (const input of getElement('record-filters').querySelectorAll('[data-column]')) {
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
  getElement('field-search').addEventListener('input', () => renderIndicators());
  getElement('select-all-fields').addEventListener('click', selectAllFields);
  getElement('clear-fields').addEventListener('click', clearFields);
  getElement('block-picker').addEventListener('change', handleBlockSelection);
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
  getElement('builder-town-count').textContent = reportSelection.towns.length
    ? `${reportSelection.towns.length} of ${availableTowns.length} towns`
    : 'All towns';
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
  if (event.target.id === 'dataset' || event.target.closest('[data-no-preview]')) {
    return;
  }
  invalidatePreview();
  readFormControls();
  updateTitleDefaults();
  if (event.target.id !== 'dataset') {
    schedulePreview();
  }
}

async function handleDatasetChange() {
  invalidatePreview();
  readFormControls();
  reportSelection.recordFilters = {};
  reportSelection.fieldOverrides = {};
  reportSelection.styleOverrides = {};
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
    const removedMessage = removedTownCount > 0
      ? `${removedTownCount} unavailable ${removedTownCount === 1 ? 'town removed' : 'towns removed'}.`
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
  getElement('save').disabled = true;
  getElement('pdf').disabled = true;
  getElement('record-filter-panel').disabled = true;
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
  currentDatasetOptions = options;
  updateStyleEditor();
  availableIndicators = options.columns;
  availableTowns = options.places.filter((place) => place.geoType === 'town');
  getElement('location-selection').hidden = availableTowns.length === 0;
  getElement('benchmark-control').hidden = !options.hasState;
  renderTownSelection();
  indicatorsByKey = new Map();
  for (const indicator of availableIndicators) {
    indicatorsByKey.set(indicator.key, indicator);
  }
  reportSelection.indicators = reportSelection.indicators.filter((key) => indicatorsByKey.has(key));
  removeUnselectedBlockIndicators();
  if (availableIndicators.length === 0) {
    showStatus(getElement('builder-status'), 'No approved fields. Choose another dataset.');
  }

  getElement('benchmark').disabled = !options.hasState;
  if (!options.hasState) {
    reportSelection.benchmark = false;
    getElement('benchmark').checked = false;
  }
  renderRecordFilters(options.filters);
  isLoadingOptions = false;
  getElement('save').disabled = false;
  getElement('pdf').disabled = false;
  getElement('record-filter-panel').disabled = false;
  updateTitleDefaults();
  return true;
}

function renderRecordFilters(filters) {
  getElement('record-filter-panel').hidden = filters.length === 0;
  const filterContainer = getElement('record-filters');
  filterContainer.replaceChildren();

  for (const filter of filters) {
    const select = createElement(filter.freeText ? 'input' : 'select', {
      id: `filter-${filter.key}`, 'data-column': filter.key,
      placeholder: 'Exact source value',
    });
    if (!filter.freeText) {
      select.append(createElement('option', { value: '' }, 'All values'));
      for (const value of filter.values) {
        select.append(createElement('option', { value }, fieldValueLabel(indicatorsByKey.get(filter.key) ?? filter, value)));
      }
    }
    select.value = reportSelection.recordFilters?.[filter.key] ?? '';

    const filterRow = createElement('div');
    filterRow.append(createElement('label', { for: select.id }, `${filter.displayLabel || filter.label} · ${fieldMetadata(filter)}`), select);
    filterContainer.append(filterRow);
  }
}

function removeUnselectedBlockIndicators() {
  for (const key of Object.keys(reportSelection.fieldOverrides ?? {})) {
    if (!reportSelection.indicators.includes(key)) delete reportSelection.fieldOverrides[key];
  }
  for (const block of reportSelection.layout) {
    if (block.indicators) {
      block.indicators = block.indicators.filter((key) => reportSelection.indicators.includes(key)
        && (block.type !== 'chart' || indicatorsByKey.get(key)?.type !== 'text'));
    }
    for (const setting of ['axisField', 'seriesField']) {
      if (block[setting] && !indicatorsByKey.has(block[setting]) && block[setting] !== '@row'
        && !(block[setting] === '@location' && currentDatasetOptions.places.length > 0)) {
        block[setting] = '';
      }
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
  const search = getElement('field-search').value.trim().toLowerCase();
  const orderedFields = orderedKeys.map((key) => indicatorsByKey.get(key))
    .filter((field) => `${fieldDisplayLabel(field)} ${fieldTypeLabel(field)} ${fieldUnitLabel(field)} ${field.unit || ''}`.toLowerCase().includes(search));
  for (const group of groupFieldsByUnit(orderedFields)) {
    const section = createElement('fieldset', { class: 'unit-field-group' });
    section.append(createElement('legend', {}, group.label));
    const choices = createElement('ul', { class: 'indicator-list' });
    for (const field of group.fields) choices.append(createIndicatorChoice(field, chosenKeys));
    section.append(choices);
    indicatorList.append(section);
  }
  if (!orderedFields.length) indicatorList.append(createElement('p', { class: 'muted small' }, search ? 'No matching fields.' : 'No approved fields.'));
  getElement('field-count').textContent = `${chosenKeys.length} selected`;
  getElement('clear-fields').disabled = chosenKeys.length === 0;
  getElement('select-all-fields').disabled = chosenKeys.length === availableIndicators.length;
  renderFieldOverrides();
  restoreFocus(focusId, 'button:not(:disabled), input');
}

function createIndicatorChoice(indicator, chosenKeys) {
  const key = indicator.key;
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
  const label = createElement('label', { for: inputId });
  label.append(
    createElement('span', {}, fieldDisplayLabel(indicator)),
    createElement('span', { class: 'field-label-unit' }, fieldMetadata(indicator)),
  );
  row.append(checkbox, label);

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
    orderControls.append(createElement('span', { class: 'field-order-position', title: `Report position ${position + 1}` }, `#${position + 1}`), upButton, downButton);
    row.append(orderControls);
  }  return row;
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
  updateTitleDefaults();
  schedulePreview();
}

function selectAllFields() {
  updateSelectedFields(availableIndicators.map((field) => field.key));
}

function clearFields() {
  updateSelectedFields([]);
}

function updateSelectedFields(keys) {
  invalidatePreview();
  reportSelection.indicators = keys;
  removeUnselectedBlockIndicators();
  renderIndicators();
  renderLayout();
  updateTitleDefaults();
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
  activeBlockIndex = Math.max(0, Math.min(activeBlockIndex, reportSelection.layout.length - 1));
  const picker = getElement('block-picker');
  picker.replaceChildren();
  for (const [index, block] of reportSelection.layout.entries()) {
    picker.append(createElement('option', { value: String(index) }, blockPickerLabel(block, index)));
  }
  picker.value = String(activeBlockIndex);
  picker.disabled = reportSelection.layout.length === 0;
  if (reportSelection.layout.length) {
    const index = activeBlockIndex;
    const block = reportSelection.layout[index];
    const blockId = `block-${index}`;
    const blockName = `${BLOCK_NAMES[block.type]} block ${index + 1}`;
    const row = createElement('li', { class: 'layout-block', value: index + 1, 'aria-labelledby': `${blockId}-name` });
    const heading = createElement('div', { class: 'layout-block-head' });
    const nameLabel = createElement('span', { id: `${blockId}-name`, class: 'layout-block-name' }, `${BLOCK_NAMES[block.type]} ${index + 1} of ${reportSelection.layout.length}`);
    heading.append(nameLabel, createBlockOrderControls(index, blockId, blockName));
    row.append(heading, createBlockEditor(block, index, blockId, blockName));
    layoutList.append(row);
  }

  if (reportSelection.layout.length === 0) {
    layoutList.append(createElement('li', { class: 'muted small' }, 'No blocks.'));
  }
  restoreFocus(focusId, 'button:not(:disabled), textarea, select');
}

function blockPickerLabel(block, index) {
  const title = block.type === 'chart' ? (block.title || chartTitleDefault(block))
    : block.type === 'text' ? block.text.trim().split('\n')[0].replace(/^#+\s*/, '') : '';
  return `${index + 1}. ${BLOCK_NAMES[block.type]}${title ? ` · ${title.slice(0, 70)}` : ''}`;
}

function updateBlockPickerLabel(index) {
  const option = getElement('block-picker').children[index];
  if (option) option.textContent = blockPickerLabel(reportSelection.layout[index], index);
}

function handleBlockSelection(event) {
  activeBlockIndex = Number(event.currentTarget.value);
  renderLayout();
}

function createBlockOrderControls(index, blockId, blockName) {
  const orderControls = createElement('span', { class: 'order' });
  const upButton = createElement('button', {
    type: 'button', class: 'icon', id: `${blockId}-up`,
    'aria-label': `Move ${blockName} up`, title: 'Move up', disabled: index === 0,
    'data-block-index': index, 'data-direction': -1, onClick: handleMoveBlock,
  }, '↑');
  const downButton = createElement('button', {
    type: 'button', class: 'icon', id: `${blockId}-down`,
    'aria-label': `Move ${blockName} down`, title: 'Move down', disabled: index === reportSelection.layout.length - 1,
    'data-block-index': index, 'data-direction': 1, onClick: handleMoveBlock,
  }, '↓');
  const removeButton = createElement('button', {
    type: 'button', class: 'link', 'aria-label': `Remove ${blockName}`,
    'data-block-index': index, onClick: handleRemoveBlock,
  }, 'Remove');
  orderControls.append(upButton, downButton, removeButton);
  return orderControls;
}

function createBlockEditor(block, index, blockId, blockName) {
  if (block.type === 'text') {
    return createElement('textarea', {
      id: `${blockId}-text`, rows: 5, maxlength: 4000,
      'aria-label': blockName, value: block.text,
      placeholder: '## Heading\n\nWrite your text…\n\n- List item',
      'data-block-index': index, onInput: handleBlockTextChange,
    });
  }

  const editor = createElement('div');
  if (block.type === 'chart') {
    const chartTypeSelect = createElement('select', {
      id: `${blockId}-type`, 'data-block-index': index, onChange: handleChartTypeChange,
    });
    for (const chartType of CHART_TYPES) {
      chartTypeSelect.append(createElement('option', {
        value: chartType.value, selected: block.chartType === chartType.value,
      }, chartType.label));
    }
    const titleInput = createElement('input', {
      id: `${blockId}-title`, maxlength: 120, value: block.title || '', placeholder: chartTitleDefault(block),
      'data-block-index': index, onInput: handleChartTitleChange,
    });
    editor.append(createElement('label', { for: titleInput.id }, 'Chart title'), titleInput);
    const controls = createElement('div', { class: 'builder-chart-controls' });
    controls.append(createElement('div', {}, createElement('label', { for: chartTypeSelect.id }, 'Chart type'), chartTypeSelect));
    const hasNumericFields = reportSelection.indicators.some((key) => indicatorsByKey.get(key)?.type !== 'text');
    chartTypeSelect.disabled = !hasNumericFields;
    controls.append(createChartFieldSelect(block, index, blockId, 'axisField', 'Category / axis'));
    controls.append(createChartFieldSelect(block, index, blockId, 'seriesField', 'Series'));
    const aggregationSelect = createElement('select', {
      id: `${blockId}-aggregation`, 'data-block-index': index, 'data-setting': 'aggregation', onChange: handleChartSettingChange,
    });
    for (const [value, label] of [['none', 'None · individual rows'], ['sum', 'Sum'], ['average', 'Average'], ['min', 'Minimum'], ['max', 'Maximum']]) {
      aggregationSelect.append(createElement('option', { value }, label));
    }
    aggregationSelect.value = block.aggregation || 'none';
    aggregationSelect.disabled = !hasNumericFields;
    controls.append(createElement('div', {}, createElement('label', { for: aggregationSelect.id }, 'Aggregation'), aggregationSelect));
    editor.append(controls);
  }
  editor.append(createBlockIndicatorOptions(block, index));
  return editor;
}

function createBlockIndicatorOptions(block, index) {
  const container = createElement('div');
  const fields = reportSelection.indicators.map((key) => indicatorsByKey.get(key))
    .filter((field) => field && (block.type !== 'chart' || field.type !== 'text'));
  const label = block.type === 'chart' ? 'Measures' : 'Table fields';
  if (fields.length === 0) {
    container.append(createElement('button', { type: 'button', class: 'secondary', onClick: focusFields }, block.type === 'chart' ? 'Choose numeric fields' : 'Choose fields'));
    return container;
  }
  const mode = createElement('select', {
    id: `block-${index}-fields-mode`, 'data-block-index': index, onChange: handleBlockFieldsModeChange,
  });
  mode.append(
    createElement('option', { value: 'all' }, `All selected ${block.type === 'chart' ? 'measures' : 'fields'} (${fields.length})`),
    createElement('option', { value: 'custom' }, block.type === 'chart' ? 'Choose measures' : 'Choose fields'),
  );
  mode.value = block.indicators.length ? 'custom' : 'all';
  container.append(createElement('label', { for: mode.id }, label), mode);
  const chartFields = block.indicators.length ? fields.filter((field) => block.indicators.includes(field.key)) : fields;
  if (block.type === 'chart') container.append(createElement('p', {
    id: `block-${index}-units-note`, class: 'muted small', hidden: groupFieldsByUnit(chartFields).length < 2,
  }, 'Different units use separate charts.'));
  if (!block.indicators.length) return container;
  const choices = createElement('div', { class: 'unit-field-groups' });
  for (const group of groupFieldsByUnit(fields)) {
    const section = createElement('fieldset', { class: 'unit-field-group' });
    section.append(createElement('legend', {}, group.label));
    for (const indicator of group.fields) {
      const checkbox = createElement('input', {
        id: `block-${index}-field-${indicator.key}`,
        type: 'checkbox', checked: block.indicators.includes(indicator.key),
        'data-block-index': index, 'data-indicator': indicator.key, onChange: handleBlockIndicatorChange,
      });
      const label = createElement('label', { class: 'check' });
      const text = createElement('span', {}, indicator.label);
      text.append(createElement('span', { class: 'field-label-unit' }, fieldUnitLabel(indicator)));
      label.append(checkbox, text);
      section.append(label);
    }
    choices.append(section);
  }
  container.append(choices);
  return container;
}

function focusFields() {
  revealTab(getElement('builder-fields-panel'));
  getElement('field-search').focus();
}

function handleBlockFieldsModeChange(event) {
  const input = event.currentTarget;
  const index = Number(input.dataset.blockIndex);
  const block = reportSelection.layout[index];
  block.indicators = input.value === 'all' ? [] : reportSelection.indicators
    .filter((key) => block.type !== 'chart' || indicatorsByKey.get(key)?.type !== 'text');
  renderLayout(input.id);
}

function fieldTypeLabel(field) {
  return field.type === 'text' ? 'Text' : 'Number';
}

function fieldMetadata(field) {
  return field.type === 'text' || !field.unit || field.unit === 'number'
    ? fieldTypeLabel(field) : `${fieldTypeLabel(field)} · ${fieldUnitLabel(field)}`;
}

function fieldDisplayLabel(field) {
  return reportSelection.fieldOverrides?.[field.key]?.label || field.displayLabel || field.label;
}

function createChartFieldSelect(block, index, blockId, setting, label) {
  const container = createElement('div');
  const select = createElement('select', {
    id: `${blockId}-${setting}`, 'data-block-index': index, 'data-setting': setting, onChange: handleChartSettingChange,
  });
  select.append(createElement('option', { value: '' }, setting === 'axisField' ? 'Automatic' : 'By measure'));
  if (setting === 'axisField') {
    select.append(createElement('option', { value: '@row' }, 'Source row number'));
  }
  if (currentDatasetOptions.places.length > 0) {
    select.append(createElement('option', { value: '@location' }, 'Location'));
  }
  for (const field of availableIndicators) {
    select.append(createElement('option', { value: field.key }, `${fieldDisplayLabel(field)} · ${fieldMetadata(field)}`));
  }
  select.value = block[setting] || '';
  container.append(createElement('label', { for: select.id }, label), select);
  return container;
}

function handleChartSettingChange(event) {
  const input = event.currentTarget;
  const block = reportSelection.layout[Number(input.dataset.blockIndex)];
  block[input.dataset.setting] = input.value;
  getElement(`block-${input.dataset.blockIndex}-title`).placeholder = chartTitleDefault(block);
  updateBlockPickerLabel(Number(input.dataset.blockIndex));
}

function chartTitleDefault(block) {
  const chosen = block.indicators.length ? block.indicators : reportSelection.indicators;
  const labels = chosen.map((key) => indicatorsByKey.get(key)).filter((field) => field && field.type !== 'text').map(fieldDisplayLabel);
  const axis = indicatorsByKey.get(block.axisField);
  const title = labels.slice(0, 3).join(', ') || 'Selected numeric fields';
  return `${title}${axis ? ` by ${fieldDisplayLabel(axis)}` : ''}`;
}

function updateTitleDefaults() {
  const dataset = activeDatasets.find((item) => reportSelection.dataset && isSameDataset(item, reportSelection.dataset));
  const labels = reportSelection.indicators.map((key) => indicatorsByKey.get(key)).filter(Boolean).map(fieldDisplayLabel);
  defaultReportTitle = `${dataset?.displayName || dataset?.name || 'Report'}${labels.length ? ` — ${labels.slice(0, 3).join(', ')}` : ''}`.slice(0, 200);
  getElement('title').placeholder = defaultReportTitle;
  getElement('report-name').placeholder = defaultReportTitle;
}

function handleBlockTextChange(event) {
  const input = event.currentTarget;
  reportSelection.layout[Number(input.dataset.blockIndex)].text = input.value;
  updateBlockPickerLabel(Number(input.dataset.blockIndex));
}

function handleChartTitleChange(event) {
  const input = event.currentTarget;
  reportSelection.layout[Number(input.dataset.blockIndex)].title = input.value;
  updateBlockPickerLabel(Number(input.dataset.blockIndex));
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
    if (block.indicators.length === 1) {
      checkbox.checked = true;
      showStatus(getElement('builder-status'), 'Choose at least one field.', 'error');
      return;
    }
    block.indicators = block.indicators.filter((key) => key !== indicatorKey);
  }
  if (block.type === 'chart') getElement(`block-${checkbox.dataset.blockIndex}-title`).placeholder = chartTitleDefault(block);
  const unitNotice = getElement(`block-${checkbox.dataset.blockIndex}-units-note`);
  if (unitNotice) unitNotice.hidden = groupFieldsByUnit(block.indicators.map((key) => indicatorsByKey.get(key)).filter(Boolean)).length < 2;
  updateBlockPickerLabel(Number(checkbox.dataset.blockIndex));
}

function createBlock(type) {
  if (type === 'text') {
    return { type, text: '' };
  }
  if (type === 'chart') {
    return { type, chartType: defaultChartType, indicators: [], axisField: '', seriesField: '', aggregation: 'none' };
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
  activeBlockIndex = index;
  let focusId = `block-${index}-up`;
  if (type === 'text') {
    focusId = `block-${index}-text`;
  } else if (type === 'chart') {
    focusId = `block-${index}-type`;
  }
  revealTab(getElement('builder-content-panel'));
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
  activeBlockIndex = nextIndex;
  const focusDirection = direction < 0 ? 'up' : 'down';
  renderLayout(`block-${nextIndex}-${focusDirection}`);
  schedulePreview();
}

function handleRemoveBlock(event) {
  const index = Number(event.currentTarget.dataset.blockIndex);
  invalidatePreview();
  reportSelection.layout.splice(index, 1);
  const nextIndex = Math.min(index, reportSelection.layout.length - 1);
  activeBlockIndex = Math.max(0, nextIndex);
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
    return 'No active datasets.';
  }
  if (reportSelection.indicators.length === 0) {
    return 'Choose report fields.';
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
    defaultReportTitle = report.title;
    getElement('title').placeholder = report.title;
    getElement('report-name').placeholder = report.title;
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
  if (savedReport && savedReport.ownerId !== currentUser.id) getElement('save').textContent = 'Save a copy';
}

function validateReport() {
  const problem = isLoadingOptions ? 'Loading fields…' : getPreviewProblem();
  if (!problem) return true;
  showStatus(getElement('builder-status'), problem, 'error');
  const target = !reportSelection.dataset || availableIndicators.length === 0 ? getElement('dataset') : getElement('field-search');
  revealTab(target);
  target.focus();
  return false;
}

async function saveReport() {
  readFormControls();
  updateTitleDefaults();
  if (!validateReport()) return;
  const title = getElement('report-name').value.trim() || reportSelection.title.trim() || defaultReportTitle || reportSelection.dataset.name;
  getElement('report-name').value = title;

  const button = getElement('save');
  button.disabled = true;
  button.textContent = 'Saving…';
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
    showStatus(getElement('builder-status'), 'Saved.', 'ok');
  } catch (error) {
    showStatus(getElement('builder-status'), error.message, 'error');
  } finally {
    button.disabled = isLoadingOptions;
    updateHeading();
  }
}

async function downloadPdf(event) {
  readFormControls();
  if (!validateReport()) return;
  const button = event.currentTarget;
  button.disabled = true;
  showStatus(getElement('builder-status'), 'Generating PDF…');
  try {
    const { blob, filename } = await api('/reports/pdf', { method: 'POST', json: reportSelection, expect: 'blob' });
    downloadBlob(blob, filename);
    showStatus(getElement('builder-status'), 'PDF downloaded.', 'ok');
  } catch (error) {
    showStatus(getElement('builder-status'), error.message, 'error');
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
  if (!validateReport()) {
    for (const button of buttons) button.disabled = false;
    return;
  }
  showStatus(getElement('builder-status'), 'Drafting…');

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
      showStatus(getElement('builder-status'), 'Review unverified figures before adding.', 'error');
    } else {
      showStatus(getElement('builder-status'), 'Review draft.', 'ok');
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
  const fields = reportSelection.indicators.map((key) => indicatorsByKey.get(key)).filter(Boolean);
  if (!fields.length) {
    container.append(createElement('p', { class: 'muted small' }, 'Choose report fields.'));
    return;
  }
  if (!fields.some((field) => field.key === activeOverrideKey)) activeOverrideKey = fields[0].key;
  const picker = createElement('select', {
    id: 'override-field-choice', 'data-no-preview': '', onChange: (event) => {
      activeOverrideKey = event.currentTarget.value;
      renderFieldOverrides();
      getElement('override-field-choice').focus();
    },
  });
  for (const field of fields) picker.append(createElement('option', { value: field.key }, fieldDisplayLabel(field)));
  picker.value = activeOverrideKey;
  container.append(createElement('label', { for: picker.id }, 'Field'), picker);
  const field = indicatorsByKey.get(activeOverrideKey);
  const index = reportSelection.indicators.indexOf(activeOverrideKey);
  const overrides = reportSelection.fieldOverrides?.[activeOverrideKey] ?? {};
  const row = createElement('div', { class: 'report-field-override' });
  for (const [setting, label] of [['label', 'Display name'], ['description', 'Description']]) {
    const input = createElement('input', {
      id: `override-${index}-${setting}`, maxlength: setting === 'label' ? 120 : 500,
      value: overrides[setting] ?? '', placeholder: field[setting] || 'Dataset default',
      'data-field-key': activeOverrideKey, 'data-setting': setting, onInput: handleFieldOverride,
    });
    row.append(createElement('label', { for: input.id }, label), input);
  }
  if (field.type !== 'text') {
    const decimals = createElement('select', {
      id: `override-${index}-decimals`, 'data-field-key': activeOverrideKey, 'data-setting': 'decimals', onChange: handleFieldOverride,
    });
    decimals.append(createElement('option', { value: '' }, `Dataset default (${field.decimals})`));
    for (let digits = 0; digits <= 4; digits++) decimals.append(createElement('option', { value: String(digits) }, String(digits)));
    decimals.value = overrides.decimals === undefined ? '' : String(overrides.decimals);
    row.append(createElement('label', { for: decimals.id }, 'Decimals'), decimals);
  }
  container.append(row);
}

function handleFieldOverride(event) {
  const input = event.currentTarget;
  reportSelection.fieldOverrides ??= {};
  const overrides = reportSelection.fieldOverrides[input.dataset.fieldKey] ?? {};
  if (input.value === '') delete overrides[input.dataset.setting];
  else overrides[input.dataset.setting] = input.dataset.setting === 'decimals' ? Number(input.value) : input.value;
  if (Object.keys(overrides).length) reportSelection.fieldOverrides[input.dataset.fieldKey] = overrides;
  else delete reportSelection.fieldOverrides[input.dataset.fieldKey];
  if (input.dataset.setting === 'label') renderLayout();
}

function resetFieldOverrides() {
  reportSelection.fieldOverrides = {};
  renderIndicators();
  renderLayout();
  updateTitleDefaults();
  invalidatePreview();
  schedulePreview();
}


function updateStyleEditor() {
  if (!styleEditor) return;
  const dataset = activeDatasets.find((item) => reportSelection.dataset && isSameDataset(item, reportSelection.dataset));
  styleEditor.set(reportSelection.styleOverrides, dataset?.reportStyle);
  const benchmarkSetting = getElement('report-style-benchmarkColor')?.closest('.style-setting');
  if (benchmarkSetting) benchmarkSetting.hidden = !currentDatasetOptions.hasState;
}

function handleStyleChange(overrides) {
  reportSelection.styleOverrides = overrides;
  invalidatePreview();
  schedulePreview();
}
