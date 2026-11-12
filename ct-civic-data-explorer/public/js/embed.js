/**
 * The public embed view at /embed/<report>.html: one saved report and nothing else.
 * It needs no sign-in, so it must not import anything that calls the signed-in API.
 *
 * When framed, the page tells its parent how tall it is so the host can size the
 * iframe: { type: 'ctde:embed-height', height: <pixels> }.
 */
import { renderReport } from './report-view.js';

const status = document.getElementById('embed-status');

async function showReport() {
  const slug = location.pathname.match(/^\/embed\/([a-z0-9-]+)\.html$/)?.[1];
  const response = slug ? await fetch(`/embed/${slug}.json`) : null;
  if (!response?.ok) {
    status.textContent = !response || response.status === 404
      ? 'This report is no longer available.'
      : 'This report could not be shown. Try again in a minute.';
    return;
  }
  const { title, updatedAt, data } = await response.json();
  document.title = title;
  renderReport(document.getElementById('embed-report'), data);
  status.hidden = true;

  const updated = document.getElementById('embed-updated');
  const date = new Date(updatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  updated.textContent = `Updated ${date}`;
  updated.hidden = false;
}

function reportHeight() {
  if (window.parent === window) {
    return;
  }
  const announce = () => {
    window.parent.postMessage({ type: 'ctde:embed-height', height: document.documentElement.scrollHeight }, '*');
  };
  new ResizeObserver(announce).observe(document.body);
}

showReport()
  .catch(() => {
    status.textContent = 'This report could not be shown. Try again in a minute.';
  })
  .finally(reportHeight);
