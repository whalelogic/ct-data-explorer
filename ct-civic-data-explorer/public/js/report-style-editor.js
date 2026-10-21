/** Shared style controls, with independent state for each mounted editor. */
import { DEFAULT_REPORT_STYLE, resolveReportStyle, contrastRatio, REPORT_TEXT_COLOR } from '/shared/report-style.js';
import { h } from './dom.js';
import { initializeTabs } from './tabs.js';

const COLOR_SETTINGS = [
  ['benchmarkColor', 'Statewide'],
  ['headingColor', 'Headings'],
  ['tableHeaderColor', 'Table header'],
];

export function mountReportStyleEditor(container, { prefix, overrides = false, onChange = () => {} }) {
  const editor = { prefix, overrides, onChange, shared: {}, choices: {}, controls: new Map() };
  editor.fieldset = h('fieldset', { class: 'report-style-editor' });
  editor.fieldset.append(h('legend', {}, overrides ? 'Report overrides' : 'Shared appearance'));
  if (overrides) editor.fieldset.append(h('p', { class: 'muted small' }, 'Unchecked settings use shared defaults.'));
  const tabs = h('div', { 'data-tabs': `${prefix}-appearance` });
  const tablist = h('div', { class: 'workspace-tabs', role: 'tablist', 'aria-label': 'Appearance settings' });
  const panels = new Map();
  for (const [index, [key, label]] of [['colors', 'Colors'], ['layout', 'Text & spacing'], ['preview', 'Preview']].entries()) {
    const tabId = `${prefix}-${key}-tab`;
    const panelId = `${prefix}-${key}-panel`;
    tablist.append(h('button', {
      id: tabId, type: 'button', role: 'tab', 'aria-controls': panelId,
      'aria-selected': index === 0 ? 'true' : 'false', tabindex: index === 0 ? 0 : -1,
    }, label));
    panels.set(key, h('div', { id: panelId, class: 'tab-panel', role: 'tabpanel', 'aria-labelledby': tabId, hidden: index !== 0 }));
  }
  tabs.append(tablist, ...panels.values());
  editor.fieldset.append(tabs);
  const paletteRow = createSetting(editor, panels.get('colors'), 'palette', 'Series');
  for (let index = 0; index < 6; index++) {
    const input = h('input', { type: 'color', id: `${prefix}-series-${index}`, 'aria-label': `Chart series ${index + 1} color` });
    input.addEventListener('input', changeStyle.bind(null, editor, 'palette'));
    editor.controls.get('palette').inputs.push(input);
    paletteRow.append(input);
  }
  for (const [key, label] of COLOR_SETTINGS) {
    const row = createSetting(editor, panels.get('colors'), key, label);
    const input = h('input', { type: 'color', id: `${prefix}-${key}`, 'aria-label': label });
    input.addEventListener('input', changeStyle.bind(null, editor, key));
    row.append(input);
    editor.controls.get(key).inputs.push(input);
  }
  for (const [key, label, values] of [
    ['textSize', 'Text size', [['standard', 'Standard'], ['large', 'Large']]],
    ['spacing', 'Spacing', [['comfortable', 'Comfortable'], ['compact', 'Compact']]],
  ]) {
    const row = createSetting(editor, panels.get('layout'), key, label);
    const input = h('select', { id: `${prefix}-${key}`, 'aria-label': label });
    for (const [value, text] of values) input.append(h('option', { value }, text));
    input.addEventListener('change', changeStyle.bind(null, editor, key));
    row.append(input);
    editor.controls.get(key).inputs.push(input);
  }
  editor.warning = h('p', { class: 'status', role: 'status', hidden: true });
  editor.sampleTitle = h('strong', {}, 'Report title');
  editor.sampleBars = h('div', { class: 'style-sample-bars', 'aria-hidden': 'true' });
  for (let index = 0; index < 6; index++) editor.sampleBars.append(h('span'));
  editor.sampleHeader = h('div', { class: 'style-sample-header' }, 'Category', h('span', {}, 'Value'));
  editor.sample = h('div', { class: 'style-sample' });
  editor.sample.append(editor.sampleTitle, editor.sampleBars, editor.sampleHeader, h('p', {}, 'Report text'));
  panels.get('preview').append(editor.sample);
  const reset = h('button', { type: 'button', class: 'link', onClick: resetStyling.bind(null, editor) }, overrides ? 'Reset overrides' : 'Reset style');
  editor.fieldset.append(editor.warning, reset);
  container.replaceChildren(editor.fieldset);
  initializeTabs(container);
  setStyle(editor);
  return { set: setStyle.bind(null, editor), read: readStyle.bind(null, editor) };
}

function createSetting(editor, panel, key, label) {
  const title = h('span', { class: 'style-setting-label' }, label);
  const inputs = h('div', { class: 'style-setting-inputs' });
  const row = h('div', { class: 'style-setting' }, title, inputs);
  let toggle;
  if (editor.overrides) {
    toggle = h('input', { type: 'checkbox', 'aria-label': `Override ${label.toLowerCase()}`, onChange: toggleOverride.bind(null, editor, key) });
    row.append(h('label', { class: 'check style-override-toggle' }, toggle, 'Override'));
  }
  editor.controls.set(key, { toggle, inputs: [] });
  panel.append(row);
  return inputs;
}

function toggleOverride(editor, key, event) {
  if (event.currentTarget.checked) editor.choices[key] = structuredClone(resolveReportStyle(editor.shared)[key]);
  else delete editor.choices[key];
  refreshStyle(editor);
  editor.onChange(readStyle(editor));
}

function changeStyle(editor, key, event) {
  editor.choices[key] = key === 'palette'
    ? editor.controls.get(key).inputs.map((input) => input.value)
    : event.currentTarget.value;
  updateStyleSample(editor);
  editor.onChange(readStyle(editor));
}

function resetStyling(editor) {
  editor.choices = {};
  refreshStyle(editor);
  editor.onChange(readStyle(editor));
}

function readStyle(editor) {
  return structuredClone(editor.choices);
}

function refreshStyle(editor) {
  const effective = resolveReportStyle(editor.shared, editor.choices);
  for (const [key, control] of editor.controls) {
    const enabled = !editor.overrides || Object.hasOwn(editor.choices, key);
    if (control.toggle) control.toggle.checked = enabled;
    for (const [index, input] of control.inputs.entries()) {
      input.disabled = !enabled;
      input.value = key === 'palette' ? effective.palette[index] : effective[key];
    }
  }
  updateStyleSample(editor);
}

function updateStyleSample(editor) {
  const effective = resolveReportStyle(editor.shared, editor.choices);
  editor.sampleTitle.style.color = effective.headingColor;
  editor.sampleHeader.style.backgroundColor = effective.tableHeaderColor;
  editor.sample.style.fontSize = effective.textSize === 'large' ? '16px' : '14px';
  editor.sample.style.padding = effective.spacing === 'compact' ? '12px' : '20px';
  for (const [index, bar] of [...editor.sampleBars.children].entries()) {
    bar.style.backgroundColor = effective.palette[index];
    bar.style.height = `${20 + index * 5}px`;
  }
  const errors = [];
  if (contrastRatio(effective.headingColor, '#FFFFFF') < 4.5) errors.push('Headings need a darker color.');
  if (contrastRatio(effective.tableHeaderColor, REPORT_TEXT_COLOR) < 4.5) errors.push('Table headers need a lighter color.');
  editor.warning.textContent = errors.join(' ');
  editor.warning.hidden = errors.length === 0;
}

function setStyle(editor, settings = {}, inherited = DEFAULT_REPORT_STYLE) {
  editor.shared = inherited ?? {};
  editor.choices = structuredClone(settings ?? {});
  refreshStyle(editor);
}
