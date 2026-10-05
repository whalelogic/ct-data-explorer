/**
 * Report builder (SRS US005–US009). The page keeps one `selection` object, the same
 * shape the API validates and stores, and sends it for the preview, PDF, summary and save.
 */
import { api, loadSession } from './api.js';
import { clearReport, renderReport } from './report-view.js';
import { h } from './dom.js';
import { boot, debounce, downloadBlob, renderHeader, showStatus } from './layout.js';

const $ = (id) => document.getElementById(id);
const sameDataset = (a, b) => a.name === b.name && a.vintage === b.vintage;
const BLOCK_NAMES = { text: 'Text', chart: 'Chart', table: 'Table' };

boot(async () => {
  const { user, features } = await loadSession();
  renderHeader(user);

  const [datasets, towns, allIndicators] = await Promise.all([api('/datasets'), api('/towns'), api('/indicators')]);
  let indicators = allIndicators;
  const activeDatasets = datasets.filter((d) => d.isActive);
  let indicatorByKey = new Map(indicators.map((i) => [i.key, i]));
  let optionsRequest = 0;
  const params = new URLSearchParams(location.search);
  const requestedDataset = activeDatasets.find((dataset) => String(dataset.id) === params.get('dataset'));
  const initialDataset = requestedDataset ?? activeDatasets[0];
  if (params.has('dataset') && !requestedDataset && !params.has('report')) {
    throw new Error('This dataset is no longer active. Choose another dataset from the dashboard.');
  }

  let saved = null; // { id, ownerId, title } once the report exists
  let selection = {
    dataset: initialDataset ? { name: initialDataset.name, vintage: initialDataset.vintage } : null,
    towns: params.get('town') ? [params.get('town')] : [],
    benchmark: true,
    indicators: [],
    showTitle: true,
    title: '',
    subtitle: '',
    layout: [newBlock('chart'), newBlock('table')],
    recordFilters: {},
  };

  if (params.has('report')) {
    const report = await api(`/reports/${encodeURIComponent(params.get('report'))}`);
    saved = { id: report.id, ownerId: report.createdBy.id, title: report.title };
    selection = { ...selection, ...report.selection };
  }

  // ---- Controls ← selection ----

  const datasetOptions = activeDatasets.map((d) => ({ name: d.name, vintage: d.vintage, label: `${d.name}, ${d.vintage}` }));
  if (selection.dataset && !datasetOptions.some((o) => sameDataset(o, selection.dataset))) {
    datasetOptions.push({ ...selection.dataset, label: `${selection.dataset.name}, ${selection.dataset.vintage} (no active version)` });
  }
  $('dataset').replaceChildren(...datasetOptions.map((o, i) => h('option', { value: String(i) }, o.label)));
  $('dataset').value = String(Math.max(0, datasetOptions.findIndex((o) => selection.dataset && sameDataset(o, selection.dataset))));

  $('town-options').replaceChildren(...towns.filter((t) => t.geoType === 'town').map((t) => h('option', { value: t.name })));
  const townInputs = [$('town-primary'), ...document.querySelectorAll('.comparison-town')];
  townInputs.forEach((input, i) => {
    input.value = selection.towns[i] ?? '';
  });
  $('benchmark').checked = selection.benchmark;
  $('show-title').checked = selection.showTitle;
  $('title').value = selection.title;
  $('subtitle').value = selection.subtitle;
  $('report-name').value = saved?.title ?? '';
  $('ai-panel').hidden = !features.aiSummary;
  updateHeading();
  await loadDatasetColumns();
  renderIndicators();
  renderLayout();

  // ---- Controls → selection ----

  function readControls() {
    const option = datasetOptions[Number($('dataset').value)];
    selection.dataset = option ? { name: option.name, vintage: option.vintage } : null;
    selection.towns = townInputs.map((input) => input.value.trim()).filter(Boolean);
    selection.benchmark = $('benchmark').checked;
    selection.showTitle = $('show-title').checked;
    selection.title = $('title').value;
    selection.subtitle = $('subtitle').value;
    selection.recordFilters = Object.fromEntries([...$('record-filters').querySelectorAll('select')]
      .filter((input) => input.value !== '').map((input) => [input.dataset.column, input.value]));
    // selection.layout is updated directly by the layout editor's controls.
  }

  const schedulePreview = debounce(refreshPreview, 300);
  const form = $('builder-form');
  form.addEventListener('submit', (event) => event.preventDefault());
  for (const type of ['input', 'change']) {
    form.addEventListener(type, (event) => {
      if (event.target.closest('[data-no-preview]')) return;
      readControls();
      if (event.target.id === 'dataset') return;
      schedulePreview();
    });
  }

  $('dataset').addEventListener('change', async () => {
    readControls();
    selection.recordFilters = {};
    await loadDatasetColumns();
    renderIndicators();
    renderLayout();
    await refreshPreview();
  });

  async function loadDatasetColumns() {
    const request = ++optionsRequest;
    const dataset = activeDatasets.find((item) => selection.dataset && sameDataset(item, selection.dataset));
    let options = { columns: allIndicators, filters: [], hasState: true };
    if (dataset?.dataFormat === 'records') {
      options = await api(`/datasets/${dataset.id}/report-options`);
      if (request !== optionsRequest) return;
    }
    indicators = options.columns;
    indicatorByKey = new Map(indicators.map((indicator) => [indicator.key, indicator]));
    selection.indicators = selection.indicators.filter((key) => indicatorByKey.has(key));
    if (dataset?.dataFormat === 'records' && !selection.indicators.length) {
      selection.indicators = indicators.slice(0, 25).map((indicator) => indicator.key);
    }
    for (const block of selection.layout) {
      if (block.indicators) block.indicators = block.indicators.filter((key) => selection.indicators.includes(key));
    }
    $('benchmark').disabled = !options.hasState;
    if (!options.hasState) { selection.benchmark = false; $('benchmark').checked = false; }
    $('record-filter-panel').hidden = options.filters.length === 0;
    $('record-filters').replaceChildren(...options.filters.map((filter) => {
      const select = h('select', { id: `filter-${filter.key}`, 'data-column': filter.key },
        h('option', { value: '' }, 'All source rows'), ...filter.values.map((value) => h('option', { value }, value)));
      select.value = selection.recordFilters?.[filter.key] ?? '';
      return h('div', {}, h('label', { for: select.id }, filter.label), select);
    }));
  }

  // ---- Indicators ----

  function renderIndicators(focusId) {
    const chosen = selection.indicators.filter((key) => indicatorByKey.has(key));
    const rest = indicators.map((i) => i.key).filter((key) => !chosen.includes(key));
    $('indicator-list').replaceChildren(
      ...[...chosen, ...rest].map((key) => {
        const indicator = indicatorByKey.get(key);
        const position = chosen.indexOf(key);
        const id = `indicator-${key}`;
        return h(
          'li',
          {},
          h('input', { type: 'checkbox', id, checked: position !== -1, onChange: (e) => toggleIndicator(key, e.target.checked) }),
          h('label', { for: id }, indicator.displayLabel),
          position === -1
            ? null
            : h(
                'span',
                { class: 'order' },
                h('button', { type: 'button', class: 'icon', id: `${id}-up`, 'aria-label': `Move ${indicator.label} up`, disabled: position === 0, onClick: () => moveIndicator(key, -1) }, '↑'),
                h('button', { type: 'button', class: 'icon', id: `${id}-down`, 'aria-label': `Move ${indicator.label} down`, disabled: position === chosen.length - 1, onClick: () => moveIndicator(key, 1) }, '↓'),
              ),
        );
      }),
    );
    if (focusId) {
      // Keep keyboard focus on the moved row, falling back when its button became disabled.
      const target = $(focusId);
      const fallback = target?.closest('li')?.querySelector('button:not(:disabled), input');
      (target && !target.disabled ? target : fallback)?.focus();
    }
  }

  function toggleIndicator(key, on) {
    selection.indicators = on ? [...selection.indicators, key] : selection.indicators.filter((k) => k !== key);
    for (const block of selection.layout) {
      if (block.indicators) block.indicators = block.indicators.filter((k) => selection.indicators.includes(k));
    }
    renderIndicators(`indicator-${key}`);
    renderLayout();
    schedulePreview();
  }

  function moveIndicator(key, delta) {
    const list = [...selection.indicators];
    const from = list.indexOf(key);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
    selection.indicators = list;
    renderIndicators(`indicator-${key}-${delta < 0 ? 'up' : 'down'}`);
    schedulePreview();
  }

  // ---- Layout: an ordered list of text, chart and table blocks ----

  function renderLayout(focusId) {
    const last = selection.layout.length - 1;
    $('layout-list').replaceChildren(
      ...selection.layout.map((block, i) => {
        const id = `block-${i}`;
        const name = `${BLOCK_NAMES[block.type]} block ${i + 1}`;
        return h(
          'li',
          { class: 'layout-block', 'aria-labelledby': `${id}-name` },
          h(
            'div',
            { class: 'layout-block-head' },
            h('span', { id: `${id}-name`, class: 'layout-block-name' }, name),
            h(
              'span',
              { class: 'order' },
              h('button', { type: 'button', class: 'icon', id: `${id}-up`, 'aria-label': `Move ${name} up`, disabled: i === 0, onClick: () => moveBlock(i, -1) }, '↑'),
              h('button', { type: 'button', class: 'icon', id: `${id}-down`, 'aria-label': `Move ${name} down`, disabled: i === last, onClick: () => moveBlock(i, 1) }, '↓'),
              h('button', { type: 'button', class: 'icon', 'aria-label': `Remove ${name}`, onClick: () => removeBlock(i) }, '✕'),
            ),
          ),
          blockEditor(block, id, name),
        );
      }),
    );
    if (selection.layout.length === 0) {
      $('layout-list').replaceChildren(h('li', { class: 'muted small' }, 'Add a chart or a table so the report shows its figures.'));
    }
    if (focusId) {
      const target = $(focusId);
      const fallback = target?.closest('li')?.querySelector('button:not(:disabled), textarea, select');
      (target && !target.disabled ? target : fallback)?.focus();
    }
  }

  function blockEditor(block, id, name) {
    if (block.type === 'text') {
      return h('textarea', {
        id: `${id}-text`,
        rows: 5,
        maxlength: 4000,
        'aria-label': name,
        value: block.text,
        placeholder: '## Heading\n\nA paragraph of text.\n\n- A list item',
        onInput: (e) => {
          block.text = e.target.value;
        },
      });
    }

    const chosen = selection.indicators.filter((key) => indicatorByKey.has(key)
      && (block.type !== 'chart' || indicatorByKey.get(key).type !== 'text'));
    const checkboxes =
      chosen.length === 0
        ? h('p', { class: 'muted small' }, 'Select indicators first.')
        : h(
            'div',
            {},
            ...chosen.map((key) =>
              h(
                'label',
                { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  checked: block.indicators.includes(key),
                  onChange: (e) => {
                    block.indicators = e.target.checked ? [...block.indicators, key] : block.indicators.filter((k) => k !== key);
                  },
                }),
                indicatorByKey.get(key).displayLabel,
              ),
            ),
          );

    if (block.type === 'table') {
      return h('div', {}, h('p', { class: 'muted small' }, 'Indicators in this table. Leave all unchecked to show every indicator.'), checkboxes);
    }
    return h(
      'div',
      {},
      h('label', { for: `${id}-type` }, 'Chart type'),
      h(
        'select',
        {
          id: `${id}-type`,
          onChange: (e) => {
            block.chartType = e.target.value;
          },
        },
        ...[
          ['bar', 'Bar (one indicator)'],
          ['grouped_bar', 'Grouped bar'],
          ['line', 'Line'],
        ].map(([value, label]) => h('option', { value, selected: block.chartType === value }, label)),
      ),
      h('p', { class: 'muted small' }, "Indicators to chart. Leave all unchecked to chart the indicators that share the first indicator's unit."),
      checkboxes,
    );
  }

  function newBlock(type) {
    if (type === 'text') return { type, text: '' };
    if (type === 'chart') return { type, chartType: 'bar', indicators: [] };
    return { type, indicators: [] };
  }

  function addBlock(type, fields = {}) {
    selection.layout.push({ ...newBlock(type), ...fields });
    const i = selection.layout.length - 1;
    renderLayout(type === 'text' ? `block-${i}-text` : type === 'chart' ? `block-${i}-type` : `block-${i}-up`);
    schedulePreview();
  }

  function moveBlock(from, delta) {
    const to = from + delta;
    if (to < 0 || to >= selection.layout.length) return;
    const list = selection.layout;
    [list[from], list[to]] = [list[to], list[from]];
    renderLayout(`block-${to}-${delta < 0 ? 'up' : 'down'}`);
    schedulePreview();
  }

  function removeBlock(i) {
    selection.layout.splice(i, 1);
    const next = Math.min(i, selection.layout.length - 1);
    renderLayout(next >= 0 ? `block-${next}-up` : null);
    if (next < 0) document.querySelector('[data-add-block="chart"]').focus();
    schedulePreview();
  }

  for (const button of document.querySelectorAll('[data-add-block]')) {
    button.addEventListener('click', () => addBlock(button.dataset.addBlock));
  }

  // ---- Preview ----

  let previewRequest = 0;
  async function refreshPreview() {
    const request = ++previewRequest;
    const problem = !selection.dataset
      ? 'No active dataset is available. An administrator needs to upload and activate one.'
      : selection.towns.length === 0
        ? 'Choose a town to start the report.'
        : selection.indicators.length === 0
          ? 'Select at least one indicator for the report.'
          : null;
    if (problem) {
      clearReport($('preview'));
      showStatus($('preview-status'), problem);
      return;
    }
    try {
      const report = await api('/reports/preview', { method: 'POST', json: selection });
      if (request !== previewRequest) return;
      showStatus($('preview-status'), '');
      renderReport($('preview'), report);
    } catch (err) {
      if (request === previewRequest) showStatus($('preview-status'), err.message, 'error');
    }
  }

  // ---- Save, PDF ----

  function updateHeading() {
    const own = !saved || saved.ownerId === user.id;
    $('builder-heading').textContent = saved ? `Report: ${saved.title}` : 'Make report';
    $('save').textContent = own ? 'Save report' : 'Save as my copy';
  }

  $('save').addEventListener('click', async () => {
    readControls();
    const title = $('report-name').value.trim();
    if (!title) {
      showStatus($('builder-status'), 'Give the report a name before saving.', 'error');
      $('report-name').focus();
      return;
    }
    try {
      const report =
        saved && saved.ownerId === user.id
          ? await api(`/reports/${saved.id}`, { method: 'PUT', json: { title, selection } })
          : await api('/reports', { method: 'POST', json: { title, selection } });
      saved = { id: report.id, ownerId: report.createdBy.id, title: report.title };
      history.replaceState(null, '', `/builder.html?report=${report.id}`);
      updateHeading();
      showStatus($('builder-status'), `Saved "${report.title}".`, 'ok');
    } catch (err) {
      showStatus($('builder-status'), err.message, 'error');
    }
  });

  $('pdf').addEventListener('click', async (event) => {
    readControls();
    const button = event.currentTarget;
    button.disabled = true;
    showStatus($('builder-status'), 'Generating PDF…');
    try {
      const { blob, filename } = await api('/reports/pdf', { method: 'POST', json: selection, expect: 'blob' });
      downloadBlob(blob, filename);
      showStatus($('builder-status'), `Downloaded ${filename}.`, 'ok');
    } catch (err) {
      showStatus($('builder-status'), `No PDF was created: ${err.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  });

  // ---- AI-drafted summary: a proposal the user reviews; nothing reaches the report until accepted ----

  async function draftSummary() {
    readControls();
    const buttons = [$('draft-summary'), $('draft-regenerate')];
    buttons.forEach((b) => (b.disabled = true));
    showStatus($('builder-status'), 'Drafting a summary…');
    try {
      const { text, mismatches } = await api('/reports/summary', { method: 'POST', json: selection });
      $('draft-text').value = text;
      $('draft-warnings').replaceChildren(...mismatches.map((m) => h('li', {}, m.message)));
      $('draft').hidden = false;
      showStatus(
        $('builder-status'),
        mismatches.length ? 'Draft ready. Some figures could not be verified against the report; check them first.' : 'Draft ready for review.',
        mismatches.length ? 'error' : 'ok',
      );
      $('draft-text').focus();
    } catch (err) {
      showStatus($('builder-status'), err.message, 'error');
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  $('draft-summary').addEventListener('click', draftSummary);
  $('draft-regenerate').addEventListener('click', draftSummary);
  $('draft-accept').addEventListener('click', () => {
    $('draft').hidden = true;
    addBlock('text', { text: $('draft-text').value.trim() });
  });
  $('draft-discard').addEventListener('click', () => {
    $('draft').hidden = true;
    $('draft-text').value = '';
    $('draft-summary').focus();
  });

  await refreshPreview();
});
