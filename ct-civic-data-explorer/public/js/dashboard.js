import { api, loadSession } from './api.js';
import { cardActionButtons, fetchCards } from './card-library.js';
import { h } from './dom.js';
import { boot, debounce, formatDate, renderHeader, showStatus } from './layout.js';

boot(async () => {
  const { user } = await loadSession();
  renderHeader(user);
  const [towns, datasets] = await Promise.all([api('/towns'), api('/datasets')]);

  // Town search
  const townInput = document.getElementById('town-input');
  const townStatus = document.getElementById('town-status');
  document.getElementById('town-options').replaceChildren(...towns.map((t) => h('option', { value: t.name })));
  document.getElementById('town-search').addEventListener('submit', (event) => {
    event.preventDefault();
    const typed = townInput.value.trim();
    const town = towns.find((t) => t.name.toLowerCase() === typed.toLowerCase());
    if (town) location.assign(`/town.html?id=${town.id}`);
    else showStatus(townStatus, typed ? `No Connecticut town is named "${typed}".` : 'Type a town name.', 'error');
  });

  const active = datasets.filter((d) => d.isActive);
  document.getElementById('dataset-badge').textContent = active.length
    ? `Active data: ${active.map((d) => `${d.name}, ${d.vintage} (version ${d.version})`).join('; ')}`
    : `No active dataset yet. ${user.role === 'admin' ? 'Upload one on the Admin page.' : 'Ask an administrator to upload one.'}`;

  // Saved card library
  const grid = document.getElementById('cards-grid');
  const cardsStatus = document.getElementById('cards-status');
  const search = document.getElementById('card-search');

  async function loadCards() {
    try {
      const query = search.value.trim();
      const cards = await fetchCards(query);
      grid.replaceChildren(...cards.map(cardTile));
      const empty = query ? 'No saved cards match your search.' : 'No saved cards yet. Start a new card to build one.';
      showStatus(cardsStatus, cards.length ? '' : empty);
    } catch (err) {
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

  search.addEventListener('input', debounce(loadCards, 250));
  await loadCards();
});
