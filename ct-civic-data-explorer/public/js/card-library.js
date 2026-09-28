/** Saved-card listing and actions, shared by the dashboard grid and the admin table. */
import { api } from './api.js';
import { h } from './dom.js';
import { downloadBlob, showStatus } from './layout.js';

export function fetchCards(query) {
  return api(`/cards${query ? `?q=${encodeURIComponent(query)}` : ''}`);
}

/**
 * Action buttons for one saved card. Rename and Delete appear only for the card's
 * creator; the API enforces the same rule.
 * @param {object} card card from GET /api/cards
 * @param {{ user: object, status: HTMLElement, reload: () => Promise<void> }} context
 * @returns {(HTMLElement | null)[]}
 */
export function cardActionButtons(card, { user, status, reload }) {
  const own = card.createdBy.id === user.id;

  const act = async (fn) => {
    try {
      await fn();
      await reload();
    } catch (err) {
      showStatus(status, err.message, 'error');
    }
  };

  const rename = () => {
    const title = prompt('New name for this card', card.title)?.trim();
    if (title && title !== card.title) act(() => api(`/cards/${card.id}`, { method: 'PUT', json: { title } }));
  };

  const remove = () => {
    if (confirm(`Delete "${card.title}"? This cannot be undone.`)) act(() => api(`/cards/${card.id}`, { method: 'DELETE' }));
  };

  return [
    h('button', { type: 'button', class: 'secondary', onClick: () => downloadPdf(card, status) }, 'PDF'),
    h('button', { type: 'button', class: 'secondary', onClick: () => act(() => api(`/cards/${card.id}/duplicate`, { method: 'POST' })) }, 'Duplicate'),
    own ? h('button', { type: 'button', class: 'secondary', onClick: rename }, 'Rename') : null,
    own ? h('button', { type: 'button', class: 'danger', onClick: remove }, 'Delete') : null,
  ];
}

async function downloadPdf(card, status) {
  showStatus(status, `Generating PDF for "${card.title}"…`);
  try {
    const { blob, filename } = await api(`/cards/${card.id}/pdf`, { expect: 'blob' });
    downloadBlob(blob, filename);
    showStatus(status, `Downloaded ${filename}.`, 'ok');
  } catch (err) {
    showStatus(status, `No PDF was created: ${err.message}`, 'error');
  }
}
