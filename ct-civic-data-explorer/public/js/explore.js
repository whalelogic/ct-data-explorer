/**
 * Explore: the gallery of saved reports. Each opens in the interactive viewer at
 * /explore/<slug>.html. Building and editing happen in the report builder.
 */
import { loadSession } from './api.js';
import { h as createElement } from './dom.js';
import { boot, debounce, formatDate, renderHeader, showStatus } from './layout.js';
import { fetchReports, reportActionButtons, summarizeRows } from './report-library.js';

let currentUser = null;
let reports = [];
let requestNumber = 0;
const scheduleSearch = debounce(loadReports, 250);

function getElement(id) {
  return document.getElementById(id);
}

async function initializeExplore() {
  // Links to the former exploration page carried a dataset; that work now starts in the builder.
  const legacy = new URLSearchParams(location.search);
  if (legacy.has('dataset')) {
    const target = new URLSearchParams({ dataset: legacy.get('dataset') });
    if (legacy.get('town')) {
      target.set('town', legacy.get('town'));
    }
    location.replace(`/builder?${target}`);
    return;
  }

  const session = await loadSession();
  currentUser = session.user;
  renderHeader(currentUser);

  getElement('gallery-filters').addEventListener('submit', (event) => event.preventDefault());
  getElement('gallery-search').addEventListener('input', scheduleSearch);
  for (const id of ['gallery-dataset', 'gallery-sort', 'gallery-mine']) {
    getElement(id).addEventListener('change', renderGallery);
  }
  await loadReports();
}

async function loadReports() {
  const thisRequest = ++requestNumber;
  getElement('gallery').setAttribute('aria-busy', 'true');
  try {
    const matching = await fetchReports(getElement('gallery-search').value.trim());
    if (thisRequest !== requestNumber) {
      return;
    }
    reports = matching;
    renderDatasetFilter();
    renderGallery();
  } catch (error) {
    if (thisRequest === requestNumber) {
      showStatus(getElement('page-status'), error.message, 'error');
    }
  } finally {
    if (thisRequest === requestNumber) {
      getElement('gallery').removeAttribute('aria-busy');
    }
  }
}

function datasetLabel(report) {
  return `${report.dataset.displayName || report.dataset.name}, ${report.dataset.vintage}`;
}

function renderDatasetFilter() {
  const select = getElement('gallery-dataset');
  const previous = select.value;
  const labels = [...new Set(reports.map(datasetLabel))].sort();
  select.replaceChildren(createElement('option', { value: '' }, 'All datasets'));
  for (const label of labels) {
    select.append(createElement('option', { value: label }, label));
  }
  select.value = labels.includes(previous) ? previous : '';
}

function renderGallery() {
  const datasetFilter = getElement('gallery-dataset').value;
  const onlyMine = getElement('gallery-mine').checked;
  const sort = getElement('gallery-sort').value;
  const visible = reports.filter((report) => {
    return (!datasetFilter || datasetLabel(report) === datasetFilter) && (!onlyMine || report.createdBy.id === currentUser.id);
  });
  visible.sort((first, second) => {
    if (sort === 'title') {
      return first.title.localeCompare(second.title);
    }
    const difference = new Date(second.updatedAt) - new Date(first.updatedAt);
    return sort === 'oldest' ? -difference : difference;
  });

  const gallery = getElement('gallery');
  gallery.replaceChildren();
  for (const report of visible) {
    gallery.append(createCard(report));
  }
  const total = reports.length;
  getElement('gallery-status').textContent = total ? `${visible.length} of ${total} reports` : '';
  const empty = getElement('gallery-empty');
  empty.hidden = visible.length > 0;
  if (visible.length === 0) {
    const filtered = Boolean(getElement('gallery-search').value.trim() || datasetFilter || onlyMine);
    getElement('gallery-empty-title').textContent = filtered ? 'No reports match' : 'No reports yet';
    getElement('gallery-empty-text').textContent = filtered
      ? 'Try another search, choose All datasets, or turn off Only my reports.'
      : 'Build a report from a dataset, then save it to see it here.';
  }
}

function createCard(report) {
  const viewUrl = report.viewUrl ?? `/builder?report=${report.id}`;
  const title = createElement('h2', { class: 'gallery-card-title' },
    createElement('a', { href: viewUrl, class: 'stretched-link' }, report.title));
  const dataset = createElement('p', { class: 'gallery-card-dataset' }, datasetLabel(report));
  const rows = createElement('p', { class: 'gallery-card-rows' }, summarizeRows(report));
  const owner = report.createdBy.id === currentUser.id ? 'You' : report.createdBy.name;
  const meta = createElement('p', { class: 'gallery-card-meta' },
    `${owner} · `, createElement('time', { datetime: report.updatedAt }, formatDate(report.updatedAt)));

  const actions = createElement('div', { class: 'gallery-card-actions' });
  actions.append(
    createElement('a', { href: viewUrl, class: 'button' }, 'View'),
    createElement('a', { href: `/builder?report=${report.id}`, class: 'button secondary' }, 'Edit'),
    ...reportActionButtons(report, {
      user: currentUser,
      status: getElement('report-action-status'),
      reload: loadReports,
    }).filter(Boolean),
  );
  return createElement('li', { class: 'gallery-card' }, dataset, title, rows, meta, actions);
}

boot(initializeExplore);
