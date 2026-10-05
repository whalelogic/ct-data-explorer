import { api, loadSession } from './api.js';
import { h } from './dom.js';
import { boot, renderHeader } from './layout.js';

boot(async () => {
  const { user } = await loadSession();
  renderHeader(user);

  const id = new URLSearchParams(location.search).get('id');
  if (!id) throw new Error('No town selected. Search for a town on the dashboard.');
  const { town, state, datasets } = await api(`/towns/${encodeURIComponent(id)}`);

  document.title = `${town.name} · CT Civic Data Explorer`;
  document.getElementById('town-name').textContent = town.label;
  const buildLink = document.getElementById('build-link');
  buildLink.href = `/builder.html?town=${encodeURIComponent(town.name)}`;
  buildLink.hidden = town.geoType !== 'town';

  const content = document.getElementById('town-content');
  if (datasets.length === 0) {
    content.replaceChildren(h('p', { class: 'empty' }, 'No active dataset holds figures for this place yet.'));
    return;
  }

  content.replaceChildren(
    ...datasets.map(({ dataset, indicators }) =>
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, `${dataset.name}, ${dataset.vintage}`),
        h('p', { class: 'muted small' }, `Source: ${dataset.source}. Version ${dataset.version}.`),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', { scope: 'col' }, 'Indicator'),
                h('th', { scope: 'col', class: 'num' }, town.name),
                state ? h('th', { scope: 'col', class: 'num' }, state.label) : null,
              ),
            ),
            h(
              'tbody',
              {},
              ...indicators.map((row) =>
                h(
                  'tr',
                  {},
                  h('th', { scope: 'row' }, row.displayLabel),
                  h('td', { class: 'num' }, row.town.display),
                  state ? h('td', { class: 'num' }, row.state.display) : null,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
