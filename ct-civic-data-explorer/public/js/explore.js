/** Interactive exploration uses only staff-approved, dataset-specific fields. */
import { api, loadSession } from './api.js';
import { clearCard, renderCard } from './card-view.js';
import { h as createElement } from './dom.js';
import { boot, debounce, downloadBlob, renderHeader, showStatus } from './layout.js';
import { unitLabel } from '/shared/format.js';

const MAX_FIELDS = 25;

// The page keeps one selection, shared by its controls, preview, and exports.
let urlParameters;
let datasets = [];
let selectedDataset;
let datasetOptions = { columns: [], filters: [], places: [], hasState: false };
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
  if (['bar', 'grouped_bar', 'table'].includes(requestedChartType)) {
    chartType = requestedChartType;
  }

  const { user } = await loadSession();
  renderHeader(user);
  const availableDatasets = await api('/datasets');
  datasets = availableDatasets.filter((dataset) => dataset.isActive);

  getElement('explorer-form').addEventListener('submit', preventFormSubmission);
  renderDatasetOptions();
  if (datasets.length === 0) {
    showEmpty('No datasets are available yet.', 'CTData staff will publish a dataset and approved fields here when they are ready.');
    return;
  }

  const linkedDatasetId = urlParameters.get('dataset');
  const linkedDataset = datasets.find((dataset) => String(dataset.id) === linkedDatasetId);
  const initialDataset = linkedDataset ?? datasets[0];
  getElement('dataset').disabled = false;
  getElement('dataset').value = String(initialDataset.id);
  if (urlParameters.has('dataset') && !linkedDataset) {
    showStatus(getElement('page-status'), 'The linked dataset is no longer available. Choose from the current datasets below.');
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
    const label = `${dataset.name} · ${dataset.vintage}`;
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
}

function handleDatasetChange() {
  loadDataset(false);
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
  clearCard(getElement('preview'));
  getElement('explorer-empty').hidden = true;
  getElement('visualization-controls').hidden = true;
  getElement('chart-help').hidden = true;
  getElement('location-controls').disabled = true;
  getElement('field-controls').disabled = true;
  getElement('filter-controls').hidden = true;
  getElement('dataset-source').hidden = true;

  const selectedDatasetId = getElement('dataset').value;
  selectedDataset = datasets.find((dataset) => String(dataset.id) === selectedDatasetId);
  const datasetDescription = `${selectedDataset.source} · ${selectedDataset.vintage} · Version ${selectedDataset.version}`;
  getElement('dataset-caption').textContent = datasetDescription;
  showStatus(getElement('preview-status'), 'Loading approved fields and available locations…');
  showStatus(getElement('field-status'), '');
  showStatus(getElement('town-status'), '');

  try {
    const loadedOptions = await api(`/datasets/${selectedDataset.id}/report-options`);
    if (requestId !== optionsRequestId) {
      return;
    }

    datasetOptions = loadedOptions;
    const reviewDescription = datasetOptions.curationReviewed
      ? 'Available fields reviewed by CTData staff.'
      : 'Legacy dataset: staff field review is pending.';
    getElement('dataset-caption').textContent = `${datasetDescription}. ${reviewDescription}`;
    getElement('field-search-label').textContent = datasetOptions.curationReviewed
      ? 'Search approved fields'
      : 'Search available fields';

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
      showStatus(getElement('page-status'), 'Some linked locations or fields are no longer available. Review your selection before sharing.');
    }
    isLoadingOptions = false;
    handleSelectionChange();
  } catch (error) {
    if (requestId !== optionsRequestId) {
      return;
    }

    isLoadingOptions = false;
    showStatus(getElement('preview-status'), error.message, 'error');
    showEmpty('This dataset could not be loaded.', 'Choose another dataset or try loading this one again.');
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
      const isAvailable = filter.values.some((value) => String(value) === requestedValue);
      if (requestedValue !== null && isAvailable) {
        recordFilters[filter.key] = requestedValue;
      }
    }
  }

  const benchmarkCheckbox = getElement('benchmark');
  const includeState = useLinkedSelection ? urlParameters.get('state') === '1' : benchmarkCheckbox.checked;
  benchmarkCheckbox.checked = datasetOptions.hasState && includeState;
  benchmarkCheckbox.disabled = !datasetOptions.hasState;
  getElement('benchmark-help').hidden = datasetOptions.hasState;
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
  getElement('location-controls').disabled = availableTownNames.size === 0;
}

function renderDatasetSource() {
  const datasetName = createElement('strong', {}, selectedDataset.name);
  const sourceDescription = `Source: ${selectedDataset.source} · Vintage: ${selectedDataset.vintage} · Version ${selectedDataset.version}`;
  const datasetSource = createElement('span', {}, sourceDescription);
  const datasetLink = createElement('a', {
    href: `/dataset.html?id=${encodeURIComponent(selectedDataset.id)}`,
  }, 'About this dataset');
  const sourceContainer = getElement('dataset-source');
  sourceContainer.replaceChildren(datasetName, datasetSource, datasetLink);
  sourceContainer.hidden = false;
}

function addTown() {
  const typedTownName = getElement('town-input').value.trim().toLowerCase();
  const matchingTown = datasetOptions.places.find((place) => {
    return place.geoType === 'town' && place.name.toLowerCase() === typedTownName;
  });

  let errorMessage = '';
  if (!matchingTown) {
    errorMessage = 'Choose a town from this dataset’s available locations.';
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
  getElement('town-help').textContent = `${selectedTowns.length} of ${availableTownCount} available towns selected. Select as many as you need.`;
  getElement('select-all-towns').disabled = selectedTowns.length === availableTownCount;
  getElement('clear-towns').disabled = selectedTowns.length === 0;
  townContainer.hidden = selectedTowns.length === 0;
}

function getVisibleFields() {
  const searchText = getElement('field-search').value.trim().toLowerCase();
  return datasetOptions.columns.filter((field) => {
    const fieldUnit = field.type === 'text' ? 'category' : unitLabel(field.unit);
    const searchableText = `${field.displayLabel} ${field.label} ${fieldUnit}`.toLowerCase();
    return searchableText.includes(searchText);
  });
}

function renderFields() {
  const visibleFields = getVisibleFields();
  const fieldList = getElement('field-list');
  fieldList.replaceChildren();
  for (const field of visibleFields) {
    const fieldElement = createFieldElement(field);
    fieldList.append(fieldElement);
  }
  if (visibleFields.length === 0) {
    const emptyMessage = datasetOptions.columns.length
      ? 'No fields match your search.'
      : 'No fields have been approved for this dataset yet.';
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
  const fieldUnit = field.type === 'text' ? 'Category · table' : unitLabel(field.unit);
  const unitDescription = createElement('span', { class: 'field-unit' }, fieldUnit);
  fieldDescription.append(fieldName, unitDescription);
  fieldLabel.append(checkbox, fieldDescription);
  return fieldLabel;
}

function handleFieldChange(event) {
  const checkbox = event.currentTarget;
  if (checkbox.checked && selectedFieldKeys.length >= MAX_FIELDS) {
    checkbox.checked = false;
    showStatus(getElement('field-status'), `Select up to ${MAX_FIELDS} fields. Clear a field to add another.`);
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
  const filterContainer = getElement('record-filters');
  filterContainer.replaceChildren();
  for (const filter of datasetOptions.filters) {
    const filterSelect = createElement('select', {
      id: `filter-${filter.key}`,
      'data-filter-key': filter.key,
      onChange: handleFilterChange,
    });
    const allCategoriesOption = createElement('option', { value: '' }, 'All categories');
    filterSelect.append(allCategoriesOption);
    for (const value of filter.values) {
      const categoryOption = createElement('option', { value }, value);
      filterSelect.append(categoryOption);
    }
    filterSelect.value = recordFilters[filter.key] ?? '';

    const filterRow = createElement('div');
    const filterLabel = createElement('label', { for: filterSelect.id }, filter.label);
    filterRow.append(filterLabel, filterSelect);
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
    if (['bar', 'grouped_bar'].includes(chartOption.value)) {
      chartOption.disabled = numericFields.length === 0;
    }
  }

  const hasSelection = selectedTowns.length > 0 && selectedFieldKeys.length > 0;
  getElement('visualization-controls').hidden = !hasSelection;
  getElement('chart-help').hidden = !hasSelection;
  renderChartHelp(displayedChartType, numericFields.length);
  return numericFields.map((field) => field.key);
}

function renderChartHelp(displayedChartType, chartFieldCount) {
  let helpText;
  if (displayedChartType === 'table') {
    helpText = 'The table includes all selected fields with their original units. N/A means a value is unavailable.';
  } else if (chartType === 'grouped_bar') {
    const fieldSuffix = chartFieldCount === 1 ? '' : 's';
    helpText = `Charting all ${chartFieldCount} selected numeric field${fieldSuffix}. Fields with the same unit are compared together. Larger groups continue in additional charts so every field is included.`;
  } else {
    helpText = 'Each selected numeric field has its own chart, with every selected town included.';
  }
  if (displayedChartType !== 'table') {
    helpText += ' Hover over a bar for its value. Use the page controls to browse larger selections. The table includes every selected field, including text. N/A means a value is unavailable.';
  }
  if (datasetOptions.repeatedRows) {
    helpText += ' Each source row is shown separately; repeated totals are never added together.';
  }
  getElement('chart-help').textContent = helpText;
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
  const chartFieldKeys = renderChartControls();
  updateSummary();
  clearCard(getElement('preview'));

  if (datasetOptions.columns.length === 0) {
    showStatus(getElement('preview-status'), '');
    showEmpty('The fields are still being reviewed.', 'Choose another dataset to explore. Approved fields will appear here when CTData staff publish them.');
    return;
  }
  const hasTownData = datasetOptions.places.some((place) => place.geoType === 'town');
  if (!hasTownData) {
    showStatus(getElement('preview-status'), '');
    showEmpty('No town data is available.', 'Choose a dataset with town-level data to compare Connecticut communities.');
    return;
  }
  if (selectedTowns.length === 0) {
    showStatus(getElement('preview-status'), '');
    showEmpty('Choose a location', 'Add one or more towns from the location selector to begin.');
    return;
  }
  if (selectedFieldKeys.length === 0) {
    showStatus(getElement('preview-status'), '');
    showEmpty('Select a field', 'Choose at least one available field. Your view updates automatically.');
    return;
  }

  getElement('explorer-empty').hidden = true;
  getElement('preview').setAttribute('aria-busy', 'true');
  showStatus(getElement('preview-status'), 'Updating your view…');
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
    title: '',
    subtitle: `${selectedDataset.name} · ${selectedDataset.vintage}`,
    layout,
  };
}

async function refreshPreview(chartFieldKeys) {
  if (isLoadingOptions || selectedTowns.length === 0 || selectedFieldKeys.length === 0) {
    return;
  }
  const requestId = ++previewRequestId;
  const selection = createPreviewSelection(chartFieldKeys);
  try {
    const card = await api('/cards/preview', { method: 'POST', json: selection });
    if (requestId !== previewRequestId) {
      return;
    }
    renderCard(getElement('preview'), card);

    // Wide tables must remain scrollable with the keyboard.
    for (const table of getElement('preview').querySelectorAll('.table-wrap')) {
      table.tabIndex = 0;
      table.setAttribute('role', 'region');
      table.setAttribute('aria-label', 'Selected data table');
    }
    lastPreviewSelection = selection;
    setActionButtonsEnabled(true);
    const fieldSuffix = selectedFieldKeys.length === 1 ? '' : 's';
    const townSuffix = selectedTowns.length === 1 ? '' : 's';
    const stateDescription = selection.benchmark ? ' and Connecticut statewide' : '';
    const successMessage = `${selectedFieldKeys.length} field${fieldSuffix} across ${selectedTowns.length} town${townSuffix}${stateDescription}. View updated.`;
    showStatus(getElement('preview-status'), successMessage, 'success');
    getElement('step-explore').dataset.active = 'true';
    writeUrl();
  } catch (error) {
    if (requestId !== previewRequestId) {
      return;
    }
    showStatus(getElement('preview-status'), error.message, 'error');
    const errorHelp = datasetOptions.dataFormat === 'records'
      ? 'Try a more specific source-row filter or choose Data table to view a larger selection.'
      : 'Choose another field or location, or retry your view.';
    showEmpty('Adjust your selection to continue.', errorHelp);
    const retryButton = createElement('button', {
      type: 'button',
      class: 'secondary',
      onClick: handleSelectionChange,
    }, 'Retry view');
    getElement('explorer-empty').append(retryButton);
  } finally {
    if (requestId === previewRequestId) {
      getElement('preview').removeAttribute('aria-busy');
    }
  }
}

function updateSummary() {
  getElement('view-heading').textContent = getSelectedTownTitle();

  let summaryText = 'Choose a town and at least one field to begin.';
  if (selectedTowns.length > 0 && selectedFieldKeys.length > 0) {
    const fieldSuffix = selectedFieldKeys.length === 1 ? '' : 's';
    const townSuffix = selectedTowns.length === 1 ? '' : 's';
    const stateDescription = getElement('benchmark').checked ? ' + statewide' : '';
    summaryText = `${selectedFieldKeys.length} selected field${fieldSuffix} · ${selectedTowns.length} town${townSuffix}${stateDescription} · ${selectedDataset.vintage}`;
  }
  getElement('selection-summary').textContent = summaryText;
  getElement('step-locations').dataset.active = String(selectedTowns.length === 0);
  getElement('step-fields').dataset.active = String(selectedTowns.length > 0 && selectedFieldKeys.length === 0);
  getElement('step-visualize').dataset.active = String(selectedTowns.length > 0 && selectedFieldKeys.length > 0);
  getElement('step-explore').dataset.active = 'false';
}

function getSelectedTownTitle() {
  if (selectedTowns.length === 0) {
    return 'Your exploration';
  }
  if (selectedTowns.length > 3) {
    return `${selectedTowns.length} towns`;
  }
  return selectedTowns.join(' + ');
}

function showEmpty(title, message) {
  getElement('preview').removeAttribute('aria-busy');
  const emptyContainer = getElement('explorer-empty');
  const stepNumber = createElement('span', { class: 'step-number', 'aria-hidden': 'true' }, '01—04');
  const heading = createElement('h3', {}, title);
  const description = createElement('p', {}, message);
  emptyContainer.hidden = false;
  emptyContainer.replaceChildren(stepNumber, heading, description);
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
    showStatus(getElement('action-status'), 'View link copied. Recipients must sign in to explore the current approved data.', 'success');
  } catch {
    getElement('share-fallback').hidden = false;
    getElement('share-link').value = shareLink.href;
    getElement('share-link').focus();
    getElement('share-link').select();
    showStatus(getElement('action-status'), 'Copy the link below. Recipients must sign in to view this selection.');
  }
}

function openBuilder() {
  if (!lastPreviewSelection) {
    return;
  }
  try {
    sessionStorage.setItem('ctdata:explore-selection', JSON.stringify(lastPreviewSelection));
    location.assign(`/builder.html?from=explore&dataset=${encodeURIComponent(selectedDataset.id)}`);
  } catch {
    showStatus(getElement('action-status'), 'Your browser could not transfer this view. Allow site storage and try again.', 'error');
  }
}

async function exportPdf() {
  if (!lastPreviewSelection) {
    return;
  }
  const selection = lastPreviewSelection;
  getElement('export-pdf').disabled = true;
  showStatus(getElement('action-status'), 'Preparing your PDF…');
  try {
    const { blob, filename } = await api('/cards/pdf', {
      method: 'POST',
      json: selection,
      expect: 'blob',
    });
    downloadBlob(blob, filename);
    showStatus(getElement('action-status'), 'Your PDF is ready.', 'success');
  } catch (error) {
    showStatus(getElement('action-status'), error.message, 'error');
  } finally {
    getElement('export-pdf').disabled = !lastPreviewSelection;
  }
}

boot(initializeExplorer);
