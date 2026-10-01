import { api, loadSession } from './api.js';
import { h } from './dom.js';
import { mountIndicatorEditor } from './indicator-editor.js';
import { boot, formatDate, renderHeader, showStatus } from './layout.js';

const $ = (id) => document.getElementById(id);

boot(async () => {
  const { user } = await loadSession();
  if (user.role !== 'admin') {
    location.assign('/');
    return;
  }
  renderHeader(user);
  mountIndicatorEditor($('upload-indicator-editor'), 'upload-indicator');

  const datasets = await api('/datasets');
  $('datasets-body').replaceChildren(...datasets.map((dataset) => {
    const href = `/dataset.html?id=${dataset.id}`;
    return h('tr', { class: 'dataset-row', onClick: (event) => {
      if (!event.target.closest('a')) location.assign(href);
    } },
    h('th', { scope: 'row' }, h('a', { href }, dataset.name)),
    h('td', {}, dataset.vintage),
    h('td', { class: 'num' }, dataset.version),
    h('td', { class: 'num' }, dataset.rowCount.toLocaleString('en-US')),
    h('td', {}, formatDate(dataset.uploadedAt)),
    h('td', {}, h('span', { class: dataset.isActive ? 'tag active' : 'tag' }, dataset.isActive ? 'Active' : 'Inactive')));
  }));
  if (!datasets.length) {
    $('datasets-body').append(h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'No datasets yet. Upload a CSV or Excel file to get started.')));
  }

  $('ds-file').addEventListener('change', () => {
    const file = $('ds-file').files[0];
    $('upload-details').hidden = !file;
    $('column-setup').hidden = !file;
    const excel = file && /\.xlsx$/i.test(file.name);
    $('worksheet-field').hidden = !excel;
    $('ds-worksheet').disabled = !excel;
    $('ds-worksheet').value = '';
    showStatus($('upload-status'), '');
    $('upload-errors').hidden = true;
    if (file && !$('ds-name').value) $('ds-name').value = file.name.replace(/\.(csv|xlsx)$/i, '').replaceAll('_', ' ');
  });

  $('upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    const data = new FormData(form);
    data.set('activate', form.elements.activate.checked ? 'true' : 'false');
    button.disabled = true;
    $('upload-errors').hidden = true;
    showStatus($('upload-status'), 'Uploading and validating…');
    try {
      const dataset = await api('/datasets', { method: 'POST', form: data });
      location.assign(`/dataset.html?id=${dataset.id}`);
    } catch (err) {
      showStatus($('upload-status'), err.message, 'error');
      if (Array.isArray(err.details)) {
        $('upload-errors').replaceChildren(...err.details.map((detail) => h('li', {}, typeof detail === 'string' ? detail : detail.message)));
        $('upload-errors').hidden = false;
      }
    } finally {
      button.disabled = false;
    }
  });
});
