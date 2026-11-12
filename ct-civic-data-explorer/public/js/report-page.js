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
  getElement('copy-embed').addEventListener('click', copyEmbedCode);
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
  const noun = (data.rowNoun ?? 'Row').toLowerCase();
  const count = data.places.length;
  let plural = `${noun}s`;
  if (/[^aeiou]y$/.test(noun)) {
    plural = `${noun.slice(0, -1)}ies`;
  } else if (noun.endsWith('s')) {
    plural = noun;
  }
  const rows = `${savedReport.allRows ? 'all ' : ''}${count.toLocaleString('en-US')} ${count === 1 ? noun : plural}`;
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

/** An <iframe> for another website. The embed page is public: it needs no sign-in. */
async function copyEmbedCode() {
  const title = savedReport.title.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const address = `${location.origin}/embed/${savedReport.slug}.html`;
  const code = `<iframe src="${address}" title="${title}" width="100%" height="700" style="border:0" loading="lazy"></iframe>`;
  try {
    await navigator.clipboard.writeText(code);
    showStatus(getElement('viewer-status'), 'Embed code copied. Paste it into a web page; anyone can see the report there without signing in.', 'ok');
  } catch {
    showStatus(getElement('viewer-status'), `Copy this code: ${code}`);
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
