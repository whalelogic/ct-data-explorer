/** Interactive exploration uses only staff-approved, dataset-specific fields. */
import { api, loadSession } from './api.js';
import { clearReport, renderReport } from './report-view.js';
import { h as createElement } from './dom.js';
import { boot, debounce, downloadBlob, renderHeader, showStatus } from './layout.js';
import { revealTab } from './tabs.js';
import { fieldUnitLabel, fieldValueLabel } from '/shared/field-groups.js';
import { unitLabel } from '/shared/format.js';

const MAX_FIELDS = 25;

// The page keeps one selection, shared by its controls, preview, and exports.
let urlParameters;
let datasets = [];
let selectedDataset;
let datasetOptions = { columns: [], filters: [], places: [], hasState: false, hasGeography: false };
let selectedTowns = [];
let selectedFieldKeys = [];
let recordFilters = {};
let chartType = 'grouped_bar';
let optionsRequestId = 0;
let previewRequestId = 0;
let isLoadingOptions = false;
let lastPreviewSelection = null;
const schedulePreview = debounce(refreshPreview, 250);

function getElement(id) {
  return document.getElementById(id);
}

async function initializeExplorer() {
  urlParameters = new URLSearchParams(location.search);
  if (urlParameters.get('embed') === '1') {
    document.body.classList.add('embed-mode');
  }

  const requestedChartType = urlParameters.get('chart');
  if (['bar', 'grouped_bar', 'line', 'table'].includes(requestedChartType)) {
    chartType = requestedChartType;
  }

  const { user } = await loadSession();
  renderHeader(user);
  const availableDatasets = await api('/datasets');
  datasets = availableDatasets.filter((dataset) => dataset.isActive);

  getElement('explorer-form').addEventListener('submit', preventFormSubmission);
  renderDatasetOptions();
  if (datasets.length === 0) {
    showEmpty('No datasets available');
    revealTab(getElement('explore-view'));
    return;
  }

  const linkedDatasetId = urlParameters.get('dataset');
  const linkedDataset = datasets.find((dataset) => String(dataset.id) === linkedDatasetId);
  const initialDataset = linkedDataset ?? datasets[0];
  getElement('dataset').disabled = false;
  getElement('dataset').value = String(initialDataset.id);
  if (urlParameters.has('dataset') && !linkedDataset) {
    showStatus(getElement('page-status'), 'Linked dataset unavailable. Select a dataset.');
  }

  connectEventHandlers();
  await loadDataset(true);
}

function preventFormSubmission(event) {
  event.preventDefault();
}

function renderDatasetOptions() {
  const datasetSelect = getElement('dataset');
  datasetSelect.replaceChildren();
  if (datasets.length === 0) {
    const emptyOption = createElement('option', {}, 'No datasets available');
    datasetSelect.append(emptyOption);
    return;
  }

  for (const dataset of datasets) {
    const label = `${dataset.displayName || dataset.name} · ${dataset.vintage}`;
    const datasetOption = createElement('option', { value: dataset.id }, label);
    datasetSelect.append(datasetOption);
  }
}

function connectEventHandlers() {
  getElement('dataset').addEventListener('change', handleDatasetChange);
  getElement('add-town').addEventListener('click', addTown);
  getElement('select-all-towns').addEventListener('click', selectAllTowns);
  getElement('clear-towns').addEventListener('click', clearTowns);
  getElement('town-input').addEventListener('keydown', handleTownKeydown);
  getElement('benchmark').addEventListener('change', handleSelectionChange);
  getElement('field-search').addEventListener('input', renderFields);
  getElement('clear-fields').addEventListener('click', clearFields);
  getElement('chart-type').addEventListener('change', handleChartTypeChange);
  getElement('share-view').addEventListener('click', shareView);
  getElement('open-builder').addEventListener('click', openBuilder);
  getElement('export-pdf').addEventListener('click', exportPdf);
  getElement('show-view').addEventListener('click', showView);
  getElement('choose-fields').addEventListener('click', showFields);
}

function handleDatasetChange() {
  showFields();
  loadDataset(false);
}

function showFields() {
  revealTab(getElement('explore-fields'));
}

function showView() {
  revealTab(getElement('explore-view'));
}

function handleTownKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    addTown();
  }
}

function clearFields() {
  selectedFieldKeys = [];
  renderFields();
  handleSelectionChange();
}

function handleChartTypeChange() {
  chartType = getElement('chart-type').value;
  handleSelectionChange();
}

async function loadDataset(useLinkedSelection) {
  const requestId = ++optionsRequestId;
  // Responses from the previous dataset must not replace the new preview.
  previewRequestId += 1;
  isLoadingOptions = true;
  lastPreviewSelection = null;
  setActionButtonsEnabled(false);
  clearReport(getElement('preview'));
  getElement('explorer-empty').hidden = true;
  getElement('visualization-controls').hidden = true;
  getElement('chart-help').hidden = true;
  getElement('location-controls').disabled = true;
  getElement('field-controls').disabled = true;
  getElement('filter-controls').hidden = true;
  getElement('explore-filters-tab').hidden = true;
  getElement('dataset-source').hidden = true;
  getElement('show-view').disabled = true;

  const selectedDatasetId = getElement('dataset').value;
  selectedDataset = datasets.find((dataset) => String(dataset.id) === selectedDatasetId);
  const datasetDescription = `${selectedDataset.source} · ${selectedDataset.vintage} · Version ${selectedDataset.version}`;
  getElement('dataset-caption').textContent = datasetDescription;
  showStatus(getElement('preview-status'), 'Loading dataset…');
  showStatus(getElement('field-status'), '');
  showStatus(getElement('town-status'), '');

  try {
    const loadedOptions = await api(`/datasets/${selectedDataset.id}/report-options`);
    if (requestId !== optionsRequestId) {
      return;
    }

    datasetOptions = loadedOptions;
    if (!useLinkedSelection || !urlParameters.has('chart')) {
      chartType = datasetOptions.defaultChartType || 'grouped_bar';
    }
    getElement('dataset-caption').textContent = datasetDescription;

    const availableTownNames = getAvailableTownNames();
    const requestedTowns = useLinkedSelection ? urlParameters.getAll('town') : selectedTowns;
    restoreSelection(useLinkedSelection, requestedTowns, availableTownNames);
    renderLocationOptions(availableTownNames);
    getElement('field-search').value = '';
    getElement('field-controls').disabled = datasetOptions.columns.length === 0;
    renderTowns();
    renderFields();
    renderFilters();
    renderDatasetSource();

    const linkedTownsChanged = selectedTowns.length !== requestedTowns.length;
    const linkedFieldsChanged = selectedFieldKeys.length !== urlParameters.getAll('field').length;
    if (useLinkedSelection && (linkedTownsChanged || linkedFieldsChanged)) {
      showStatus(getElement('page-status'), 'Some linked fields or locations are unavailable.');
    }
    isLoadingOptions = false;
    handleSelectionChange();
    if (useLinkedSelection && selectedFieldKeys.length > 0) showView();
  } catch (error) {
    if (requestId !== optionsRequestId) {
      return;
    }

    isLoadingOptions = false;
    showStatus(getElement('preview-status'), error.message, 'error');
    showEmpty('Dataset unavailable');
    showView();
    const retryButton = createElement('button', {
      type: 'button',
      class: 'secondary',
      'data-use-linked-selection': String(useLinkedSelection),
      onClick: retryDatasetLoad,
    }, 'Try again');
    getElement('explorer-empty').append(retryButton);
  }
}

function retryDatasetLoad(event) {
  const useLinkedSelection = event.currentTarget.dataset.useLinkedSelection === 'true';
  loadDataset(useLinkedSelection);
}

function getAvailableTownNames() {
  const townNames = new Set();
  for (const place of datasetOptions.places) {
    if (place.geoType === 'town') {
      townNames.add(place.name);
    }
  }
  return townNames;
}

function restoreSelection(useLinkedSelection, requestedTowns, availableTownNames) {
  const uniqueTowns = [...new Set(requestedTowns)];
  selectedTowns = uniqueTowns.filter((town) => availableTownNames.has(town));
  selectedFieldKeys = [];
  recordFilters = {};

  if (useLinkedSelection) {
    const requestedFields = [...new Set(urlParameters.getAll('field'))];
    const availableFieldKeys = new Set(datasetOptions.columns.map((field) => field.key));
    selectedFieldKeys = requestedFields.filter((key) => availableFieldKeys.has(key)).slice(0, MAX_FIELDS);

    for (const filter of datasetOptions.filters) {
      const requestedValue = urlParameters.get(`filter.${filter.key}`);
      const isAvailable = filter.freeText || filter.values.some((value) => String(value) === requestedValue);
      if (requestedValue !== null && isAvailable) {
        recordFilters[filter.key] = requestedValue;
      }
    }
  }

  const benchmarkCheckbox = getElement('benchmark');
  const includeState = useLinkedSelection ? urlParameters.get('state') === '1' : benchmarkCheckbox.checked;
  benchmarkCheckbox.checked = datasetOptions.hasState && includeState;
  benchmarkCheckbox.disabled = !datasetOptions.hasState;
  getElement('benchmark-control').hidden = !datasetOptions.hasState;
}

function renderLocationOptions(availableTownNames) {
  const townOptions = getElement('town-options');
  townOptions.replaceChildren();
  const sortedTownNames = [...availableTownNames].sort();
  for (const townName of sortedTownNames) {
    const townOption = createElement('option', { value: townName });
    townOptions.append(townOption);
  }
  getElement('town-input').value = '';
  const hasTownOptions = availableTownNames.size > 0;
  getElement('location-controls').disabled = !hasTownOptions && !datasetOptions.hasState;
  getElement('location-controls').hidden = !hasTownOptions && !datasetOptions.hasState;
  getElement('town-controls').hidden = !hasTownOptions;
}

function renderDatasetSource() {
  const datasetLink = createElement('a', {
    href: `/dataset?id=${encodeURIComponent(selectedDataset.id)}`,
  }, 'Dataset details');
  const sourceContainer = getElement('dataset-source');
  sourceContainer.replaceChildren(datasetLink);
  sourceContainer.hidden = false;
}

function addTown() {
  const typedTownName = getElement('town-input').value.trim().toLowerCase();
  const matchingTown = datasetOptions.places.find((place) => {
    return place.geoType === 'town' && place.name.toLowerCase() === typedTownName;
  });

  let errorMessage = '';
  if (!matchingTown) {
    errorMessage = 'Choose a listed town.';
  } else if (selectedTowns.includes(matchingTown.name)) {
    errorMessage = `${matchingTown.name} is already selected.`;
  }
  if (errorMessage) {
    showStatus(getElement('town-status'), errorMessage);
    return;
  }

  selectedTowns.push(matchingTown.name);
  getElement('town-input').value = '';
  showStatus(getElement('town-status'), '');
  renderTowns();
  handleSelectionChange();
  getElement('town-input').focus();
}

function removeTown(event) {
  const removedTownName = event.currentTarget.dataset.town;
  selectedTowns = selectedTowns.filter((townName) => townName !== removedTownName);
  renderTowns();
  handleSelectionChange();
  getElement('town-input').focus();
}

function selectAllTowns() {
  selectedTowns = [...getAvailableTownNames()].sort();
  getElement('town-input').value = '';
  showStatus(getElement('town-status'), '');
  renderTowns();
  handleSelectionChange();
}

function clearTowns() {
  selectedTowns = [];
  showStatus(getElement('town-status'), '');
  renderTowns();
  handleSelectionChange();
  getElement('town-input').focus();
}

function renderTowns() {
  const townContainer = getElement('chosen-towns');
  townContainer.replaceChildren();
  for (const townName of selectedTowns) {
    const removeButton = createElement('button', {
      type: 'button',
      class: 'explorer-town secondary',
      'aria-label': `Remove ${townName}`,
      'data-town': townName,
      onClick: removeTown,
    }, townName);
    const removeSymbol = createElement('span', { 'aria-hidden': 'true' }, ' ×');
    removeButton.append(removeSymbol);
    townContainer.append(removeButton);
  }
  const availableTownCount = getAvailableTownNames().size;
  getElement('town-help').textContent = selectedTowns.length
    ? `${selectedTowns.length} of ${availableTownCount} towns`
    : 'All towns';
  getElement('select-all-towns').disabled = selectedTowns.length === availableTownCount;
  getElement('clear-towns').disabled = selectedTowns.length === 0;
  townContainer.hidden = selectedTowns.length === 0;
}

function getVisibleFields() {
  const searchText = getElement('field-search').value.trim().toLowerCase();
  return datasetOptions.columns.filter((field) => {
    const fieldUnit = field.type === 'text' ? 'category' : unitLabel(field.unit);
    const searchableText = `${field.displayLabel} ${field.label} ${field.description || ''} ${fieldUnit}`.toLowerCase();
    return searchableText.includes(searchText);
  });
}

function renderFields() {
  const visibleFields = getVisibleFields();
  const fieldList = getElement('field-list');
  fieldList.replaceChildren();
  for (const field of visibleFields) fieldList.append(createFieldElement(field));
  if (visibleFields.length === 0) {
    const emptyMessage = datasetOptions.columns.length
      ? 'No fields match your search.'
      : 'No approved fields';
    const emptyParagraph = createElement('p', { class: 'small muted' }, emptyMessage);
    fieldList.append(emptyParagraph);
  }
  updateFieldCount(visibleFields.length);
}

function createFieldElement(field) {
  const checkboxId = `field-${field.key}`;
  const isSelected = selectedFieldKeys.includes(field.key);
  const fieldLabel = createElement('label', {
    for: checkboxId,
    class: 'explorer-field',
    'data-selected': String(isSelected),
    ...(field.description ? { title: field.description } : {}),
  });
  const checkbox = createElement('input', {
    id: checkboxId,
    type: 'checkbox',
    value: field.key,
    checked: isSelected,
    onChange: handleFieldChange,
  });
  const fieldDescription = createElement('span', { class: 'field-copy' });
  const fieldName = createElement('span', {}, field.displayLabel ?? field.label);
  const fieldUnit = field.type === 'text' ? 'Text'
    : !field.unit || field.unit === 'number' ? 'Number' : `Number · ${fieldUnitLabel(field)}`;
  const unitDescription = createElement('span', { class: 'field-unit' }, fieldUnit);
  fieldDescription.append(fieldName, unitDescription);
  fieldLabel.append(checkbox, fieldDescription);
  return fieldLabel;
}

function handleFieldChange(event) {
  const checkbox = event.currentTarget;
  if (checkbox.checked && selectedFieldKeys.length >= MAX_FIELDS) {
    checkbox.checked = false;
    showStatus(getElement('field-status'), `Maximum ${MAX_FIELDS} fields`);
    return;
  }

  if (checkbox.checked) {
    selectedFieldKeys.push(checkbox.value);
  } else {
    selectedFieldKeys = selectedFieldKeys.filter((key) => key !== checkbox.value);
  }
  showStatus(getElement('field-status'), '');
  // Keep the active checkbox in the DOM for keyboard and assistive users.
  checkbox.closest('.explorer-field').dataset.selected = String(checkbox.checked);
  updateFieldCount(getVisibleFields().length);
  handleSelectionChange();
}

function updateFieldCount(visibleFieldCount) {
  const hasSearchText = getElement('field-search').value.trim().length > 0;
  const searchDescription = hasSearchText ? ' matching' : '';
  getElement('field-count').textContent = `${selectedFieldKeys.length} selected · ${visibleFieldCount} available${searchDescription}`;
  getElement('clear-fields').disabled = selectedFieldKeys.length === 0;
}

function renderFilters() {
  getElement('filter-controls').hidden = datasetOptions.filters.length === 0;
  getElement('explore-filters-tab').hidden = getElement('location-controls').hidden && datasetOptions.filters.length === 0;
  const filterContainer = getElement('record-filters');
  filterContainer.replaceChildren();
  for (const filter of datasetOptions.filters) {
    const attributes = {
      id: `filter-${filter.key}`,
      'data-filter-key': filter.key,
      onChange: handleFilterChange,
    };
    let filterControl;
    if (filter.freeText) {
      filterControl = createElement('input', { ...attributes, type: 'text', placeholder: 'Exact source value' });
    } else {
      filterControl = createElement('select', attributes);
      filterControl.append(createElement('option', { value: '' }, 'All values'));
      for (const value of filter.values) {
        const field = datasetOptions.columns.find((column) => column.key === filter.key) ?? filter;
        filterControl.append(createElement('option', { value }, fieldValueLabel(field, value)));
      }
    }
    filterControl.value = recordFilters[filter.key] ?? '';

    const filterRow = createElement('div');
    const typeDescription = filter.type === 'text' ? '' : ` · ${fieldUnitLabel(filter)}`;
    const filterLabel = createElement('label', { for: filterControl.id }, `${filter.displayLabel || filter.label}${typeDescription}`);
    filterRow.append(filterLabel, filterControl);
    filterContainer.append(filterRow);
  }
}

function handleFilterChange(event) {
  const filterSelect = event.currentTarget;
  const filterKey = filterSelect.dataset.filterKey;
  if (filterSelect.value === '') {
    delete recordFilters[filterKey];
  } else {
    recordFilters[filterKey] = filterSelect.value;
  }
  handleSelectionChange();
}

function renderChartControls() {
  const numericFields = [];
  for (const fieldKey of selectedFieldKeys) {
    const selectedField = datasetOptions.columns.find((field) => field.key === fieldKey);
    if (selectedField.type !== 'text') {
      numericFields.push(selectedField);
    }
  }

  // Text fields use a table without replacing the user's chart preference.
  let displayedChartType = chartType;
  if (numericFields.length === 0 && selectedFieldKeys.length > 0) {
    displayedChartType = 'table';
  }
  getElement('chart-type').value = displayedChartType;
  for (const chartOption of getElement('chart-type').options) {
    if (['bar', 'grouped_bar', 'line'].includes(chartOption.value)) {
      chartOption.disabled = numericFields.length === 0;
    }
  }

  const hasSelection = selectedFieldKeys.length > 0;
  getElement('visualization-controls').hidden = !hasSelection;
  renderChartHelp(displayedChartType, numericFields);
  return numericFields.map((field) => field.key);
}

function renderChartHelp(displayedChartType, numericFields) {
  const notes = [];
  if (displayedChartType === 'line') notes.push('Lines follow source row order.');
  const units = new Set(numericFields.map((field) => field.unit));
  if (displayedChartType !== 'table' && units.size > 1) notes.push('Separate scales by unit.');
  const chartHelp = getElement('chart-help');
  chartHelp.textContent = notes.join(' ');
  chartHelp.hidden = notes.length === 0;
}

function handleSelectionChange() {
  if (isLoadingOptions) {
    return;
  }

  // Invalidate old responses immediately, before the next debounced request.
  previewRequestId += 1;
  lastPreviewSelection = null;
  setActionButtonsEnabled(false);
  showStatus(getElement('action-status'), '');
  getElement('share-fallback').hidden = true;
  getElement('show-view').disabled = selectedFieldKeys.length === 0;
  const chartFieldKeys = renderChartControls();
  updateSummary();
  clearReport(getElement('preview'));

  if (datasetOptions.columns.length === 0) {
    showStatus(getElement('preview-status'), '');
    showEmpty('No approved fields');
    return;
  }
  if (selectedFieldKeys.length === 0) {
    showStatus(getElement('preview-status'), '');
    showEmpty('No fields selected');
    return;
  }

  getElement('explorer-empty').hidden = true;
  getElement('preview').setAttribute('aria-busy', 'true');
  showStatus(getElement('preview-status'), 'Updating…');
  schedulePreview(chartFieldKeys);
}

function createPreviewSelection(chartFieldKeys) {
  const layout = [];
  if (chartType !== 'table' && chartFieldKeys.length > 0) {
    layout.push({ type: 'chart', chartType, indicators: chartFieldKeys });
  }
  layout.push({ type: 'table', indicators: [...selectedFieldKeys] });

  return {
    dataset: { name: selectedDataset.name, vintage: selectedDataset.vintage },
    towns: [...selectedTowns],
    benchmark: getElement('benchmark').checked && datasetOptions.hasState,
    indicators: [...selectedFieldKeys],
    recordFilters: { ...recordFilters },
    showTitle: true,
    title: `${selectedDataset.displayName || selectedDataset.name} · ${selectedDataset.vintage}`,
    subtitle: '',
    layout,
  };
}

async function refreshPreview(chartFieldKeys) {
  if (isLoadingOptions || selectedFieldKeys.length === 0) {
    return;
  }
  const requestId = ++previewRequestId;
  const selection = createPreviewSelection(chartFieldKeys);
  try {
    const report = await api('/reports/preview', { method: 'POST', json: selection });
    if (requestId !== previewRequestId) {
      return;
    }
    renderReport(getElement('preview'), { ...report, showTitle: false });

    // Wide tables must remain scrollable with the keyboard.
    for (const table of getElement('preview').querySelectorAll('.table-wrap')) {
      table.tabIndex = 0;
      table.setAttribute('role', 'region');
      table.setAttribute('aria-label', 'Selected data table');
    }
    lastPreviewSelection = selection;
    setActionButtonsEnabled(true);
    showStatus(getElement('preview-status'), '');
    writeUrl();
  } catch (error) {
    if (requestId !== previewRequestId) {
      return;
    }
    showStatus(getElement('preview-status'), error.message, 'error');
    showEmpty('View unavailable');
    const retryButton = createElement('button', {
      type: 'button',
      class: 'secondary',
      onClick: handleSelectionChange,
    }, 'Try again');
    getElement('explorer-empty').append(retryButton);
  } finally {
    if (requestId === previewRequestId) {
      getElement('preview').removeAttribute('aria-busy');
    }
  }
}

function updateSummary() {
  getElement('view-heading').textContent = getSelectedTownTitle();

  let summaryText = '';
  if (selectedFieldKeys.length > 0) {
    const fieldSuffix = selectedFieldKeys.length === 1 ? '' : 's';
    const townSuffix = selectedTowns.length === 1 ? '' : 's';
    const stateDescription = getElement('benchmark').checked ? ' + statewide' : '';
    const locationDescription = selectedTowns.length
      ? `${selectedTowns.length} town${townSuffix}${stateDescription}`
      : `All source rows${stateDescription}`;
    summaryText = `${selectedFieldKeys.length} field${fieldSuffix} · ${locationDescription}`;
  }
  getElement('selection-summary').textContent = summaryText;
}

function getSelectedTownTitle() {
  if (selectedTowns.length === 0) {
    return selectedDataset?.displayName || selectedDataset?.name || 'Your exploration';
  }
  if (selectedTowns.length > 3) {
    return `${selectedTowns.length} towns`;
  }
  return selectedTowns.join(' + ');
}

function showEmpty(title) {
  getElement('preview').removeAttribute('aria-busy');
  const emptyContainer = getElement('explorer-empty');
  const heading = createElement('h3', {}, title);
  emptyContainer.hidden = false;
  emptyContainer.replaceChildren(heading);
  if (datasetOptions.columns.length > 0 && selectedFieldKeys.length === 0) {
    emptyContainer.append(createElement('button', { type: 'button', class: 'secondary', onClick: showFields }, 'Choose fields'));
  }
}

function setActionButtonsEnabled(enabled) {
  for (const buttonId of ['share-view', 'open-builder', 'export-pdf']) {
    getElement(buttonId).disabled = !enabled;
  }
}

function writeUrl() {
  const query = new URLSearchParams();
  query.set('dataset', selectedDataset.id);
  for (const town of selectedTowns) {
    query.append('town', town);
  }
  for (const fieldKey of selectedFieldKeys) {
    query.append('field', fieldKey);
  }
  if (getElement('benchmark').checked) {
    query.set('state', '1');
  }
  query.set('chart', chartType);
  for (const [filterKey, filterValue] of Object.entries(recordFilters)) {
    query.set(`filter.${filterKey}`, filterValue);
  }
  if (document.body.classList.contains('embed-mode')) {
    query.set('embed', '1');
  }
  history.replaceState(null, '', `${location.pathname}?${query}`);
}

async function shareView() {
  if (!lastPreviewSelection) {
    return;
  }
  writeUrl();
  const shareLink = new URL(location.href);
  shareLink.searchParams.delete('embed');
  try {
    await navigator.clipboard.writeText(shareLink.href);
    showStatus(getElement('action-status'), 'Link copied', 'success');
  } catch {
    getElement('share-fallback').hidden = false;
    getElement('share-link').value = shareLink.href;
    getElement('share-link').focus();
    getElement('share-link').select();
    showStatus(getElement('action-status'), 'Copy the view link.');
  }
}

function openBuilder() {
  if (!lastPreviewSelection) {
    return;
  }
  try {
    sessionStorage.setItem('ctdata:explore-selection', JSON.stringify(lastPreviewSelection));
    location.assign(`/builder?from=explore&dataset=${encodeURIComponent(selectedDataset.id)}`);
  } catch {
    showStatus(getElement('action-status'), 'Allow site storage to create a report.', 'error');
  }
}

async function exportPdf() {
  if (!lastPreviewSelection) {
    return;
  }
  const selection = lastPreviewSelection;
  getElement('export-pdf').disabled = true;
  showStatus(getElement('action-status'), 'Preparing PDF…');
  try {
    const { blob, filename } = await api('/reports/pdf', {
      method: 'POST',
      json: selection,
      expect: 'blob',
    });
    downloadBlob(blob, filename);
    showStatus(getElement('action-status'), 'PDF ready', 'success');
  } catch (error) {
    showStatus(getElement('action-status'), error.message, 'error');
  } finally {
    getElement('export-pdf').disabled = !lastPreviewSelection;
  }
}

boot(initializeExplorer);
