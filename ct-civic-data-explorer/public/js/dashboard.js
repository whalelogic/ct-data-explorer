import { api, loadSession } from './api.js';
import { cardActionButtons, fetchCards } from './card-library.js';
import { h } from './dom.js';
import { boot, debounce, formatDate, renderHeader, showStatus } from './layout.js';

boot(async () => {
  const { user } = await loadSession();
  renderHeader(user);
  const datasets = await api('/datasets');
  const active = datasets.filter((d) => d.isActive);
  const datasetGrid = document.getElementById('datasets-grid');
  const datasetStatus = document.getElementById('datasets-status');
  const grid = document.getElementById('cards-grid');
  const cardsStatus = document.getElementById('cards-status');
  const search = document.getElementById('search-input');
  let reportRequest = 0;

  function renderDatasets() {
    const query = search.value.trim().toLowerCase();
    const matches = active.filter((dataset) => dataset.name.toLowerCase().includes(query));
    datasetGrid.replaceChildren(...matches.map(datasetTile));
    const empty = query ? 'No datasets match this name.'
      : `No active datasets yet. ${user.role === 'admin' ? 'Select Upload dataset to add one.' : 'Ask an administrator to upload one.'}`;
    showStatus(datasetStatus, matches.length ? '' : empty);
  }

  function datasetTile(dataset) {
    const href = `/builder.html?dataset=${dataset.id}`;
    return h('li', { class: 'saved-card' },
      h('div', { class: 'saved-card-body' },
        h('h3', { class: 'saved-card-title' }, h('a', { href: `/dataset.html?id=${dataset.id}`, class: 'stretched-link' }, dataset.name)),
        h('p', { class: 'muted small' }, `${dataset.vintage} · Version ${dataset.version} · ${dataset.rowCount} rows`),
        h('p', { class: 'small' }, dataset.source),
      ),
      h('div', { class: 'saved-card-actions' }, h('a', { href }, 'Make report')),
    );
  }

  async function loadCards() {
    const request = ++reportRequest;
    try {
      const query = search.value.trim();
      const cards = await fetchCards(query);
      if (request !== reportRequest) return;
      grid.replaceChildren(...cards.map(cardTile));
      const empty = query ? 'No reports match this dataset or report name.' : 'No saved reports yet. Choose a dataset or select Make report to begin.';
      showStatus(cardsStatus, cards.length ? '' : empty);
    } catch (err) {
      if (request !== reportRequest) return;
      grid.replaceChildren();
      showStatus(cardsStatus, err.message, 'error');
    }
  }

  /** The title link stretches over the whole card (see .stretched-link); the action buttons sit above it. */
  function cardTile(card) {
    return h(
      'li',
      { class: 'saved-card' },
      h(
        'div',
        { class: 'saved-card-body' },
        h('h3', { class: 'saved-card-title' }, h('a', { href: `/builder.html?card=${card.id}`, class: 'stretched-link' }, card.title)),
        h('p', { class: 'saved-card-towns' }, card.towns.join(', ')),
        h(
          'dl',
          { class: 'saved-card-meta' },
          h('dt', {}, 'Dataset'),
          h('dd', {}, `${card.dataset.name}, ${card.dataset.vintage}`),
          h('dt', {}, 'Created by'),
          h('dd', {}, card.createdBy.name),
          h('dt', {}, 'Updated'),
          h('dd', {}, h('time', { datetime: card.updatedAt }, formatDate(card.updatedAt))),
        ),
      ),
      h('div', { class: 'saved-card-actions' }, ...cardActionButtons(card, { user, status: cardsStatus, reload: loadCards })),
    );
  }

  const scheduleReports = debounce(loadCards, 250);
  search.addEventListener('input', () => {
    reportRequest++;
    renderDatasets();
    scheduleReports();
  });
  document.getElementById('dashboard-search').addEventListener('submit', (event) => {
    event.preventDefault();
    renderDatasets();
    loadCards();
  });
  renderDatasets();
  await loadCards();
});
