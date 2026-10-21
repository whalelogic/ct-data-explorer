/** Shared presentation settings for one dataset version. */
import { mountReportStyleEditor } from './report-style-editor.js';
import { api } from './api.js';
import { h } from './dom.js';
import { showStatus } from './layout.js';
import { initializeTabs } from './tabs.js';
import { unitLabel } from '/shared/format.js';

let styleEditor;
let current;
let orderedFields = [];
let fieldSettings = {};
let activeFieldKey;
let datasetId;
let onSaved;
let status, form, name, description, chart, fieldPicker, fieldEditor, save, reload, reset;
let fieldLabel, fieldDescription, decimals, decimalsControl, fieldMeta, moveUp, moveDown, fieldPosition;

export async function mountDatasetPresentation(container, id, onSave) {
  datasetId = id;
  onSaved = onSave;
  status = h('p', { class: 'status', role: 'status', hidden: true });
  form = h('form', { class: 'presentation-form' });
  name = h('input', { id: 'presentation-name', maxlength: 200 });
  description = h('textarea', { id: 'presentation-description', rows: 2, maxlength: 2000 });
  chart = h('select', { id: 'presentation-chart' });
  for (const [value, label] of [['grouped_bar', 'Compare fields'], ['bar', 'Separate charts'], ['line', 'Line charts']]) {
    chart.append(h('option', { value }, label));
  }
  const names = h('div', { class: 'presentation-general' },
    control('Dataset name', name), control('Default chart', chart));
  const namesPanel = h('div', {}, names, control('Description', description));
  const fieldsPanel = buildFieldEditor();
  const styleContainer = h('div');
  const tabs = h('div', { 'data-tabs': 'dataset-presentation' });
  const tablist = h('div', { class: 'workspace-tabs', role: 'tablist', 'aria-label': 'Shared defaults' });
  for (const [index, [key, label, panel]] of [
    ['names', 'Names', namesPanel], ['fields', 'Field labels', fieldsPanel], ['style', 'Style', styleContainer],
  ].entries()) {
    const tabId = `presentation-${key}-tab`;
    const panelId = `presentation-${key}-panel`;
    tablist.append(h('button', {
      id: tabId, type: 'button', role: 'tab', 'aria-controls': panelId,
      'aria-selected': index === 0 ? 'true' : 'false', tabindex: index === 0 ? 0 : -1,
    }, label));
    panel.id = panelId;
    panel.classList.add('tab-panel');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tabId);
    panel.hidden = index !== 0;
  }
  tabs.append(tablist, namesPanel, fieldsPanel, styleContainer);
  save = h('button', { type: 'submit' }, 'Save defaults');
  reload = h('button', { type: 'button', class: 'secondary', onClick: load }, 'Reload');
  reset = h('button', { type: 'button', class: 'link', onClick: resetDefaults }, 'Reset to source');
  form.append(h('p', { class: 'muted small' }, 'Shared dataset defaults'),
    tabs, h('div', { class: 'button-row' }, save, reload, reset), status);
  form.addEventListener('submit', saveDefaults);
  form.addEventListener('input', () => showStatus(status, 'Unsaved defaults.'));
  container.replaceChildren(form);
  styleEditor = mountReportStyleEditor(styleContainer, {
    prefix: 'shared-style', onChange: () => showStatus(status, 'Unsaved defaults.'),
  });
  initializeTabs(container);
  await load();
}

function buildFieldEditor() {
  fieldPicker = h('select', { id: 'presentation-field', onChange: selectField });
  fieldMeta = h('p', { class: 'muted small' });
  fieldLabel = h('input', { id: 'presentation-field-name', maxlength: 120 });
  fieldDescription = h('input', { id: 'presentation-field-description', maxlength: 500, placeholder: 'Optional' });
  decimals = h('select', { id: 'presentation-field-decimals' });
  decimalsControl = control('Decimals', decimals);
  moveUp = h('button', { type: 'button', class: 'secondary', onClick: () => moveField(-1), 'aria-label': 'Move field up' }, '↑');
  moveDown = h('button', { type: 'button', class: 'secondary', onClick: () => moveField(1), 'aria-label': 'Move field down' }, '↓');
  fieldPosition = h('span', { class: 'muted small' });
  fieldEditor = h('div', {}, fieldMeta,
    h('div', { class: 'field-editor-controls' }, control('Display name', fieldLabel), decimalsControl),
    control('Description', fieldDescription),
    h('div', { class: 'button-row' }, h('span', {}, 'Order'), moveUp, moveDown, fieldPosition));
  return h('div', {}, control('Field', fieldPicker), fieldEditor);
}

async function load() {
  save.disabled = true;
  try {
    current = await api(`/datasets/${datasetId}/presentation`);
    setFields();
    render();
    showStatus(status, '');
  } catch (error) {
    showStatus(status, error.message, 'error');
  } finally {
    save.disabled = !current;
  }
}

function setFields() {
  const order = new Map(current.settings.fieldOrder.map((key, index) => [key, index]));
  orderedFields = [...current.fields].sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
  fieldSettings = Object.fromEntries(orderedFields
    .filter((field) => current.settings.fields[field.key])
    .map((field) => [field.key, structuredClone(current.settings.fields[field.key])]));
  if (!orderedFields.some((field) => field.key === activeFieldKey)) activeFieldKey = orderedFields[0]?.key;
}

function render() {
  name.value = current.settings.displayName;
  description.value = current.settings.description;
  chart.value = current.settings.defaultChartType;
  styleEditor.set(current.settings.style);
  renderFieldPicker();
}

function renderFieldPicker() {
  fieldPicker.replaceChildren();
  for (const field of orderedFields) {
    fieldPicker.append(h('option', { value: field.key }, fieldSettings[field.key]?.label || field.label));
  }
  fieldPicker.disabled = !orderedFields.length;
  fieldEditor.hidden = !orderedFields.length;
  if (!orderedFields.length) {
    fieldPicker.append(h('option', { value: '' }, 'No approved fields'));
    return;
  }
  fieldPicker.value = activeFieldKey;
  renderActiveField();
}

function renderActiveField() {
  const index = orderedFields.findIndex((field) => field.key === activeFieldKey);
  const field = orderedFields[index];
  if (!field) return;
  const settings = fieldSettings[field.key] ?? {};
  const type = field.type === 'text' ? 'Text' : 'Number';
  const unit = field.type !== 'text' && field.unit && field.unit !== 'number' ? ` · ${unitLabel(field.unit)}` : '';
  fieldMeta.textContent = `${type}${unit} · Source: ${field.label}`;
  fieldLabel.value = settings.label ?? '';
  fieldLabel.placeholder = field.label;
  fieldDescription.value = settings.description ?? '';
  decimalsControl.hidden = field.type === 'text';
  decimals.disabled = field.type === 'text';
  decimals.replaceChildren(h('option', { value: '' }, `Source (${field.decimals ?? 0})`));
  for (let digits = 0; digits <= 4; digits++) decimals.append(h('option', { value: String(digits) }, String(digits)));
  decimals.value = settings.decimals === undefined ? '' : String(settings.decimals);
  moveUp.disabled = index === 0;
  moveDown.disabled = index === orderedFields.length - 1;
  fieldPosition.textContent = `${index + 1} / ${orderedFields.length}`;
}

function storeActiveField() {
  if (!activeFieldKey) return;
  const settings = {};
  if (fieldLabel.value.trim()) settings.label = fieldLabel.value.trim();
  if (fieldDescription.value.trim()) settings.description = fieldDescription.value.trim();
  if (decimals.value !== '' && !decimals.disabled) settings.decimals = Number(decimals.value);
  if (Object.keys(settings).length) fieldSettings[activeFieldKey] = settings;
  else delete fieldSettings[activeFieldKey];
}

function selectField() {
  storeActiveField();
  activeFieldKey = fieldPicker.value;
  renderFieldPicker();
}

function read() {
  storeActiveField();
  return {
    style: styleEditor.read(),
    revision: current.settings.revision,
    displayName: name.value.trim(), description: description.value.trim(),
    defaultChartType: chart.value, fields: structuredClone(fieldSettings), fieldOrder: orderedFields.map((field) => field.key),
  };
}

function moveField(direction) {
  storeActiveField();
  const index = orderedFields.findIndex((field) => field.key === activeFieldKey);
  const next = index + direction;
  if (next < 0 || next >= orderedFields.length) return;
  [orderedFields[index], orderedFields[next]] = [orderedFields[next], orderedFields[index]];
  renderFieldPicker();
  fieldPicker.focus();
  showStatus(status, 'Unsaved order.');
}

function resetDefaults() {
  if (!current) return;
  current.settings = { revision: current.settings.revision, displayName: '', description: '', defaultChartType: 'grouped_bar', fields: {}, fieldOrder: [] };
  setFields();
  render();
  showStatus(status, 'Source defaults selected. Save to apply.');
}

async function saveDefaults(event) {
  event.preventDefault();
  if (!current) return;
  const settings = read();
  save.disabled = true;
  reload.disabled = true;
  reset.disabled = true;
  try {
    current = await api(`/datasets/${datasetId}/presentation`, { method: 'PUT', json: settings });
    setFields();
    render();
    showStatus(status, 'Defaults saved.', 'ok');
    await onSaved();
  } catch (error) {
    showStatus(status, error.message, 'error');
  } finally {
    save.disabled = false;
    reload.disabled = false;
    reset.disabled = false;
  }
}

function control(label, input) {
  return h('div', {}, h('label', { for: input.id }, label), input);
}
