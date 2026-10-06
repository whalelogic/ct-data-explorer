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
 * @returns {(HTMLElement | null)[]}
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
    const title = prompt('New name for this report', report.title)?.trim();
    if (title && title !== report.title) act(() => api(`/reports/${report.id}`, { method: 'PUT', json: { title } }));
  };

  const remove = () => {
    if (confirm(`Delete "${report.title}"? This cannot be undone.`)) act(() => api(`/reports/${report.id}`, { method: 'DELETE' }));
  };

  return [
    h('button', { type: 'button', class: 'secondary', onClick: () => downloadPdf(report, status) }, 'PDF'),
    h('button', { type: 'button', class: 'secondary', onClick: () => act(() => api(`/reports/${report.id}/duplicate`, { method: 'POST' })) }, 'Duplicate'),
    own ? h('button', { type: 'button', class: 'secondary', onClick: rename }, 'Rename') : null,
    own ? h('button', { type: 'button', class: 'danger', onClick: remove }, 'Delete') : null,
  ];
}

async function downloadPdf(report, status) {
  showStatus(status, `Generating PDF for "${report.title}"…`);
  try {
    const { blob, filename } = await api(`/reports/${report.id}/pdf`, { expect: 'blob' });
    downloadBlob(blob, filename);
    showStatus(status, `Downloaded ${filename}.`, 'ok');
  } catch (err) {
    showStatus(status, `No PDF was created: ${err.message}`, 'error');
  }
}
