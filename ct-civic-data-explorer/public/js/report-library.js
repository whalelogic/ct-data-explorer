/** Saved-report listing and actions, shared by the dashboard grid and the admin table. */
import { api } from './api.js';
import { h } from './dom.js';
import { confirmDialog, promptDialog } from './dialogs.js';
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

  const rename = async () => {
    const title = await promptDialog({
      title: 'Rename report',
      label: 'Report name',
      value: report.title,
      confirmLabel: 'Rename',
    });
    if (title && title !== report.title) {
      act(() => api(`/reports/${report.id}`, { method: 'PUT', json: { title } }));
    }
  };

  const remove = async () => {
    const confirmed = await confirmDialog({
      title: `Delete “${report.title}”?`,
      message: 'The report and its address are removed for everyone. This cannot be undone. The dataset it uses is not affected.',
      confirmLabel: 'Delete report',
      danger: true,
    });
    if (confirmed) {
      act(() => api(`/reports/${report.id}`, { method: 'DELETE' }));
    }
  };

  // Everyday actions stay as buttons; the occasional ones sit behind "More" so a card stays calm.
  const menu = h('details', { class: 'action-menu' },
    h('summary', { class: 'button secondary', 'aria-label': `More actions for ${report.title}` }, 'More'),
    h('div', { class: 'action-menu-items' },
      h('button', { type: 'button', onClick: () => act(() => api(`/reports/${report.id}/duplicate`, { method: 'POST' })) }, 'Duplicate'),
      own ? h('button', { type: 'button', onClick: rename }, 'Rename') : null,
      own ? h('button', { type: 'button', class: 'action-menu-danger', onClick: remove }, 'Delete') : null,
    ));
  // Choosing an item, pressing Escape or moving elsewhere closes the menu.
  menu.addEventListener('click', (event) => {
    if (event.target.closest('.action-menu-items button')) {
      menu.open = false;
    }
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
  menu.addEventListener('focusout', (event) => {
    if (!menu.contains(event.relatedTarget)) {
      menu.open = false;
    }
  });

  return [
    h('button', { type: 'button', class: 'secondary', onClick: () => downloadPdf(report, status) }, 'PDF'),
    menu,
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
