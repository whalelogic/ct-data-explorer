/** Saved-report listing and actions, shared by the dashboard grid and the admin table. */
import { api } from './api.js';
import { h } from './dom.js';
import { downloadBlob, showStatus } from './layout.js';

export function fetchReports(query) {
  return api(`/reports${query ? `?q=${encodeURIComponent(query)}` : ''}`);
}

/**
 * Action buttons for one saved report. Rename and Delete appear only for the report's
 * creator; the API enforces the same rule.
 * @param {object} report report from GET /api/reports
 * @param {{ user: object, status: HTMLElement, reload: () => Promise<void> }} context
 * @returns {HTMLElement[]}
 */
export function reportActionButtons(report, { user, status, reload }) {
  const own = report.createdBy.id === user.id;

  const act = async (fn) => {
    try {
      await fn();
      await reload();
    } catch (err) {
      showStatus(status, err.message, 'error');
    }
  };

  const rename = () => {
    const title = prompt('Report title', report.title)?.trim();
    if (title && title !== report.title) act(() => api(`/reports/${report.id}`, { method: 'PUT', json: { title } }));
  };

  const remove = () => {
    if (confirm(`Delete "${report.title}"? This cannot be undone.`)) act(() => api(`/reports/${report.id}`, { method: 'DELETE' }));
  };

  const more = h('details', { class: 'report-more' });
  more.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && more.open) {
      event.preventDefault();
      more.open = false;
      more.querySelector('summary').focus();
    }
  });
  const runAction = (action) => () => {
    more.open = false;
    action();
  };
  more.append(
    h('summary', { 'aria-label': `More actions for ${report.title}` }, 'More'),
    h('div', { class: 'report-more-actions' },
      h('button', { type: 'button', class: 'secondary', onClick: runAction(() => act(() => api(`/reports/${report.id}/duplicate`, { method: 'POST' }))) }, 'Duplicate'),
      own ? h('button', { type: 'button', class: 'secondary', onClick: runAction(rename) }, 'Rename') : null,
      own ? h('button', { type: 'button', class: 'danger', onClick: runAction(remove) }, 'Delete') : null,
    ),
  );
  return [
    h('button', { type: 'button', class: 'secondary', 'aria-label': `Export PDF: ${report.title}`, onClick: () => downloadPdf(report, status) }, 'Export PDF'),
    more,
  ];
}

async function downloadPdf(report, status) {
  showStatus(status, 'Generating PDF…');
  try {
    const { blob, filename } = await api(`/reports/${report.id}/pdf`, { expect: 'blob' });
    downloadBlob(blob, filename);
    showStatus(status, 'PDF downloaded.', 'ok');
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
}
