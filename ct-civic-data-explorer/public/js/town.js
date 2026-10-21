import { api, loadSession } from './api.js';
import { h } from './dom.js';
import { boot, renderHeader } from './layout.js';
import { initializeTabs } from './tabs.js';

boot(async () => {
  const { user } = await loadSession();
  renderHeader(user);

  const id = new URLSearchParams(location.search).get('id');
  if (!id) throw new Error('No place selected.');
  const { town, state, datasets } = await api(`/towns/${encodeURIComponent(id)}`);

  document.title = `${town.name} · CT Civic Data Explorer`;
  document.getElementById('town-name').textContent = town.label;

  const content = document.getElementById('town-content');
  if (datasets.length === 0) {
    content.replaceChildren(h('p', { class: 'empty' }, 'No published data for this place.'));
    return;
  }

  const tabs = h('div', { class: 'workspace-tabs', role: 'tablist', 'aria-label': 'Datasets' });
  const workspace = h('div', { 'data-tabs': 'town-datasets' }, tabs);
  datasets.forEach(({ dataset, indicators }, index) => {
    const tabId = `town-dataset-tab-${dataset.id}`;
    const panelId = `town-dataset-panel-${dataset.id}`;
    const title = dataset.displayName || dataset.name;
    const selected = index === 0;
    tabs.append(h('button', {
      id: tabId, type: 'button', role: 'tab', 'aria-controls': panelId,
      'aria-selected': String(selected), tabindex: selected ? '0' : '-1', title,
    }, title));
    const actions = h('div', { class: 'workspace-actions' },
      h('a', { href: `/dataset?id=${dataset.id}` }, 'Dataset details'),
      town.geoType === 'town'
        ? h('a', { class: 'button', href: `/builder?dataset=${dataset.id}&town=${encodeURIComponent(town.name)}` }, 'New report')
        : null,
    );
    workspace.append(h('section', {
      id: panelId, class: 'tab-panel', role: 'tabpanel', 'aria-labelledby': tabId, hidden: !selected,
    },
    h('div', { class: 'panel-head' },
      h('p', { class: 'muted small' }, `${dataset.source} · ${dataset.vintage}`),
      actions,
    ),
    h('div', { class: 'table-wrap preview-scroll' },
      h('table', { class: 'data' },
        h('thead', {},
          h('tr', {},
            h('th', { scope: 'col' }, 'Indicator'),
            h('th', { scope: 'col', class: 'num' }, town.name),
            state ? h('th', { scope: 'col', class: 'num' }, state.label) : null,
          ),
        ),
        h('tbody', {},
          ...indicators.map((row) => h('tr', {},
            h('th', { scope: 'row' }, row.displayLabel),
            h('td', { class: 'num' }, row.town.display),
            state ? h('td', { class: 'num' }, row.state.display) : null,
          )),
        ),
      ),
    ),
    ));
  });
  content.replaceChildren(workspace);
  initializeTabs(content);
});
