/** Saved-report listing and actions, shared by the dashboard grid and the admin table. */
import { api } from './api.js';
import { h } from './dom.js';
import { getGuestReport, listGuestReports, removeGuestReport, saveGuestReport } from './guest-reports.js';
import { downloadBlob, showStatus } from './layout.js';

export async function fetchReports(query, { user } = {}) {
  if (user === null) return listGuestReports(query);
  return api(`/reports${query ? `?q=${encodeURIComponent(query)}` : ''}`);
}

export function reportBuilderUrl(report) {
  return `/builder?${new URLSearchParams({ [report.isLocal ? 'localReport' : 'report']: report.id })}`;
}

export function reportIsMine(report, user) {
  return report.isLocal || report.createdBy.id === user?.id;
}

/**
 * Action buttons for one saved report. Rename and Delete appear only for the report's
 * creator or for browser-saved guest reports.
 * @param {object} report saved report
 * @param {{ user: object | null, status: HTMLElement, reload: () => Promise<void> }} context
 * @returns {(HTMLElement | null)[]}
 */
export function reportActionButtons(report, { user, status, reload }) {
  const own = reportIsMine(report, user);

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
    if (!title || title === report.title) return;
    act(() => report.isLocal
      ? saveGuestReport({ ...getGuestReport(report.id), title }, report.id)
      : api(`/reports/${report.id}`, { method: 'PUT', json: { title } }));
  };

  const remove = () => {
    if (confirm(`Delete "${report.title}"? This cannot be undone.`)) {
      act(() => report.isLocal ? removeGuestReport(report.id) : api(`/reports/${report.id}`, { method: 'DELETE' }));
    }
  };

  const duplicate = () => act(() => report.isLocal
    ? saveGuestReport({ ...getGuestReport(report.id), title: `${report.title} (copy)`.slice(0, 200) })
    : api(`/reports/${report.id}/duplicate`, { method: 'POST' }));

  return [
    h('button', { type: 'button', class: 'secondary', onClick: () => downloadPdf(report, status) }, 'PDF'),
    h('button', { type: 'button', class: 'secondary', onClick: duplicate }, 'Duplicate'),
    own ? h('button', { type: 'button', class: 'secondary', onClick: rename }, 'Rename') : null,
    own ? h('button', { type: 'button', class: 'danger', onClick: remove }, 'Delete') : null,
  ];
}

async function downloadPdf(report, status) {
  showStatus(status, `Generating PDF for "${report.title}"…`);
  try {
    const { blob, filename } = report.isLocal
      ? await api('/reports/pdf', { method: 'POST', json: getGuestReport(report.id).selection, expect: 'blob' })
      : await api(`/reports/${report.id}/pdf`, { expect: 'blob' });
    downloadBlob(blob, filename);
    showStatus(status, `Downloaded ${filename}.`, 'ok');
  } catch (err) {
    showStatus(status, `No PDF was created: ${err.message}`, 'error');
  }
}

/** "Hartford, New Haven + 3 more", or "All rows" for reports that include every row. */
export function summarizeRows(report) {
  if (report.allRows) {
    return 'All rows';
  }
  const rows = report.rows ?? [];
  if (rows.length > 3) {
    return `${rows.slice(0, 3).join(', ')} + ${rows.length - 3} more`;
  }
  return rows.join(', ') || 'No rows selected';
}
