/** Shared presentation settings for one dataset version. */
import { mountReportStyleEditor } from './report-style-editor.js';
import { api } from './api.js';
import { h } from './dom.js';
import { showStatus } from './layout.js';

let styleEditor;
let current;
let orderedFields = [];
let datasetId;
let onSaved;
let status, form, name, description, chart, fieldsList, save, reload, reset;

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
  const general = h('div', { class: 'presentation-general' });
  general.append(control('Dataset display name', name), control('Default chart style', chart));
  fieldsList = h('ol', { class: 'presentation-fields' });
  const fieldsSection = h('details', { open: true });
  fieldsSection.append(h('summary', {}, 'Field names, descriptions and order'), fieldsList);
  save = h('button', { type: 'submit' }, 'Save shared defaults');
  reload = h('button', { type: 'button', class: 'secondary', onClick: load }, 'Reload defaults');
  reset = h('button', { type: 'button', class: 'link', onClick: resetDefaults }, 'Use source defaults');
  const styleContainer = h('div');
  styleEditor = mountReportStyleEditor(styleContainer, { prefix: 'shared-style', onChange: () => showStatus(status, 'Unsaved shared styling.') });
  // Colors matter less than names, so they start folded away.
  const styleSection = h('details', { class: 'presentation-style' }, h('summary', {}, 'Report colors and appearance'), styleContainer);
  form.append(general, control('Dataset description', description), fieldsSection, styleSection);
  form.append(h('div', { class: 'button-row' }, save, reload, reset), status);
  form.addEventListener('submit', saveDefaults);
  form.addEventListener('input', () => showStatus(status, 'Unsaved changes to shared defaults.'));
  container.replaceChildren(form);
  await load();

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
}

function render() {
  name.value = current.settings.displayName;
  description.value = current.settings.description;
  chart.value = current.settings.defaultChartType;
  styleEditor.set(current.settings.style);
  fieldsList.replaceChildren();
  for (const [index, field] of orderedFields.entries()) {
    const settings = current.settings.fields[field.key] ?? {};
    const row = h('li', { class: 'presentation-field', 'data-field-key': field.key });
    const source = h('div', { class: 'presentation-source' }, h('strong', {}, field.label), h('code', {}, field.key));
    const label = h('input', {
      id: `presentation-label-${index}`, maxlength: 120, value: settings.label ?? '',
      placeholder: field.label, 'data-setting': 'label',
    });
    const decimals = h('select', { id: `presentation-decimals-${index}`, 'data-setting': 'decimals', disabled: field.type === 'text' });
    decimals.append(h('option', { value: '' }, `Source default${field.type === 'text' ? '' : ` (${field.decimals})`}`));
    for (let digits = 0; digits <= 4; digits++) {
      decimals.append(h('option', { value: String(digits) }, String(digits)));
    }
    decimals.value = settings.decimals === undefined ? '' : String(settings.decimals);
    const help = h('input', {
      id: `presentation-help-${index}`, maxlength: 500, value: settings.description ?? '',
      placeholder: 'Help users understand this field', 'data-setting': 'description',
    });
    const orderButtons = h('div', { class: 'order' });
    for (const direction of [-1, 1]) {
      orderButtons.append(h('button', {
        type: 'button', class: 'icon', disabled: direction < 0 ? index === 0 : index === orderedFields.length - 1,
        'aria-label': `Move ${field.label} ${direction < 0 ? 'up' : 'down'}`,
        onClick: () => moveField(index, direction),
      }, direction < 0 ? '↑' : '↓'));
    }
    row.append(source, control(`Display name for ${field.label}`, label), control(`Decimals for ${field.label}`, decimals), orderButtons);
    const helpControl = control(`Description for ${field.label}`, help);
    helpControl.className = 'presentation-field-help';
    row.append(helpControl);
    fieldsList.append(row);
  }
}

function read() {
  const fields = {};
  for (const row of fieldsList.children) {
    const settings = {};
    for (const input of row.querySelectorAll('[data-setting]')) {
      if (input.value.trim() && !input.disabled) {
        settings[input.dataset.setting] = input.dataset.setting === 'decimals' ? Number(input.value) : input.value.trim();
      }
    }
    if (Object.keys(settings).length) fields[row.dataset.fieldKey] = settings;
  }
  return {
    style: styleEditor.read(),
    revision: current.settings.revision,
    displayName: name.value.trim(), description: description.value.trim(),
    defaultChartType: chart.value, fields, fieldOrder: orderedFields.map((field) => field.key),
  };
}

function moveField(index, direction) {
  current.settings = read();
  const next = index + direction;
  [orderedFields[index], orderedFields[next]] = [orderedFields[next], orderedFields[index]];
  render();
  fieldsList.children[next].querySelector('input').focus();
  showStatus(status, 'Unsaved field order.');
}

function resetDefaults() {
  if (!current) return;
  current.settings = { revision: current.settings.revision, displayName: '', description: '', defaultChartType: 'grouped_bar', fields: {}, fieldOrder: [] };
  setFields();
  render();
  showStatus(status, 'Source defaults selected. Save to apply them to this dataset.');
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
    showStatus(status, 'Shared defaults saved. Reports with their own overrides keep those choices.', 'ok');
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
