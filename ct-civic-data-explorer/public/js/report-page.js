/**
 * The report viewer at /explore/<slug>.html: a saved report rendered from current data,
 * with interactive charts, tables and a ranking of its rows. Add ?embed=1 for a
 * chrome-free version to place inside another same-origin page.
 */
import { api, loadSession } from './api.js';
import { renderReport } from './report-view.js';
import { renderReportDetails } from './report-details.js';
import { boot, downloadBlob, formatDate, renderHeader, showStatus } from './layout.js';

let savedReport = null;

function getElement(id) {
  return document.getElementById(id);
}

async function initializeViewer() {
  const isEmbedded = new URLSearchParams(location.search).get('embed') === '1';
  if (isEmbedded) {
    document.body.classList.add('embed-mode');
  }
  const { user } = await loadSession();
  if (!isEmbedded) {
    renderHeader(user);
  }

  const slug = location.pathname.match(/^\/explore\/([a-z0-9-]+)\.html$/)?.[1];
  if (!slug) {
    throw new Error('This report address is not valid. Choose a report from Explore.');
  }
  let view;
  try {
    view = await api(`/reports/by-slug/${encodeURIComponent(slug)}`);
  } catch (error) {
    getElement('viewer-heading').textContent = error.status === 404 ? 'Report not found' : 'This report could not be shown';
    throw error.status === 404
      ? new Error('No saved report has this address. It may have been renamed or deleted; find it in Explore.')
      : error;
  }

  savedReport = view.report;
  const data = view.data;
  document.title = `${savedReport.title} · CT Civic Data Explorer`;
  getElement('viewer-heading').textContent = savedReport.title;
  renderMeta(user, data);

  getElement('edit-report').href = `/builder?report=${savedReport.id}`;
  getElement('edit-report').textContent = savedReport.createdBy.id === user.id ? 'Edit in builder' : 'Open a copy in builder';
  getElement('copy-link').addEventListener('click', copyLink);
  getElement('viewer-pdf').addEventListener('click', exportPdf);
  getElement('viewer-actions').hidden = isEmbedded;

  renderReport(getElement('viewer-report'), data);
  const details = getElement('viewer-details');
  details.hidden = !renderReportDetails(details, data, { rowNoun: data.rowNoun ?? 'Row' });
  details.querySelector('h2')?.setAttribute('id', 'details-title');
  document.querySelector('.viewer-layout').dataset.hasDetails = String(!details.hidden);
}

function renderMeta(user, data) {
  const dataset = `${savedReport.dataset.displayName || savedReport.dataset.name}, ${savedReport.dataset.vintage}`;
  const owner = savedReport.createdBy.id === user.id ? 'you' : savedReport.createdBy.name;
  const rows = savedReport.allRows ? `all ${data.places.length} rows` : `${data.places.length} ${data.places.length === 1 ? 'row' : 'rows'}`;
  getElement('viewer-meta').textContent = `${dataset} · ${rows} · Saved by ${owner}, ${formatDate(savedReport.updatedAt)}`;
}

async function copyLink() {
  const link = `${location.origin}${location.pathname}`;
  try {
    await navigator.clipboard.writeText(link);
    showStatus(getElement('viewer-status'), 'Link copied. People need to sign in to open it.', 'ok');
  } catch {
    showStatus(getElement('viewer-status'), `Copy this link: ${link}`);
  }
}

async function exportPdf(event) {
  const button = event.currentTarget;
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = 'Exporting…';
  try {
    const { blob, filename } = await api(`/reports/${savedReport.id}/pdf`, { expect: 'blob' });
    downloadBlob(blob, filename);
    showStatus(getElement('viewer-status'), `Downloaded ${filename}.`, 'ok');
  } catch (error) {
    showStatus(getElement('viewer-status'), `No PDF was created: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

boot(initializeViewer);
