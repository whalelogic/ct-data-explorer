import { api, loadSession } from './api.js';
import { cardActionButtons, fetchCards } from './card-library.js';
import { h as createElement } from './dom.js';
import { boot, debounce, formatDate, renderHeader, showStatus } from './layout.js';

const datasetGrid = document.getElementById('datasets-grid');
const datasetStatus = document.getElementById('datasets-status');
const cardsGrid = document.getElementById('cards-grid');
const cardsStatus = document.getElementById('cards-status');
const searchInput = document.getElementById('search-input');
const scheduleReportSearch = debounce(loadCards, 250);

let currentUser;
let publishedDatasets = [];
let reportRequestNumber = 0;

async function initializeDashboard() {
  const session = await loadSession();
  currentUser = session.user;
  renderHeader(currentUser);

  const datasets = await api('/datasets');
  publishedDatasets = datasets.filter((dataset) => dataset.isActive);
  searchInput.addEventListener('input', handleSearchInput);
  document.getElementById('dashboard-search').addEventListener('submit', handleSearchSubmit);
  renderDatasets();
  await loadCards();
}

function renderDatasets() {
  const searchText = searchInput.value.trim().toLowerCase();
  datasetGrid.replaceChildren();
  let matchingDatasetCount = 0;

  for (const dataset of publishedDatasets) {
    const searchableValues = [dataset.name, dataset.source, dataset.vintage];
    const matchesSearch = searchableValues.some((value) => String(value).toLowerCase().includes(searchText));
    if (matchesSearch) {
      datasetGrid.append(createDatasetTile(dataset));
      matchingDatasetCount += 1;
    }
  }

  let emptyMessage = 'No datasets match this name.';
  if (!searchText) {
    const nextStep = currentUser.role === 'admin'
      ? 'Open Data management to upload and approve data.'
      : 'Your data administrator can publish a dataset here.';
    emptyMessage = `No published datasets yet. ${nextStep}`;
  }
  showStatus(datasetStatus, matchingDatasetCount ? '' : emptyMessage);
}

function createDatasetTile(dataset) {
  const exploreUrl = `/explore.html?dataset=${dataset.id}`;
  const detailsUrl = `/dataset.html?id=${dataset.id}`;
  const hasApprovedFields = dataset.approvedFields === null || dataset.approvedFields?.length > 0;

  const titleLink = createElement('a', {
    href: hasApprovedFields ? exploreUrl : detailsUrl,
    class: 'stretched-link',
  }, dataset.name);
  const title = createElement('h3', { class: 'saved-card-title' }, titleLink);
  const metadata = `${dataset.vintage} · Version ${dataset.version} · ${dataset.rowCount} rows`;
  let reviewStatus = 'Awaiting field approval';
  if (hasApprovedFields) {
    reviewStatus = dataset.curationReviewed
      ? 'Fields reviewed by staff'
      : 'Existing published fields · review pending';
  }

  const body = createElement('div', { class: 'saved-card-body' }, title);
  body.append(
    createElement('p', { class: 'muted small' }, metadata),
    createElement('p', { class: 'small' }, dataset.source),
    createElement('p', { class: 'muted small' }, reviewStatus),
  );

  const actions = createElement('div', { class: 'saved-card-actions' });
  if (hasApprovedFields) {
    actions.append(createElement('a', { href: exploreUrl }, 'Explore dataset'));
  }
  const detailsLabel = currentUser.role === 'admin' ? 'Review dataset' : 'Dataset details';
  actions.append(createElement('a', { href: detailsUrl }, detailsLabel));
  return createElement('li', { class: 'saved-card' }, body, actions);
}

async function loadCards() {
  reportRequestNumber += 1;
  const currentRequestNumber = reportRequestNumber;
  try {
    const searchText = searchInput.value.trim();
    const cards = await fetchCards(searchText);
    // A newer search may finish first. Keep its results on screen.
    if (currentRequestNumber !== reportRequestNumber) {
      return;
    }

    cardsGrid.replaceChildren();
    for (const card of cards) {
      cardsGrid.append(createCardTile(card));
    }
    const emptyMessage = searchText
      ? 'No reports match this dataset or report name.'
      : 'No saved reports yet. Explore a dataset, then save a report when you are ready.';
    showStatus(cardsStatus, cards.length ? '' : emptyMessage);
  } catch (error) {
    if (currentRequestNumber !== reportRequestNumber) {
      return;
    }
    cardsGrid.replaceChildren();
    showStatus(cardsStatus, error.message, 'error');
  }
}

function createCardTile(card) {
  // The title link covers the card; action buttons remain above it in the CSS.
  const titleLink = createElement('a', {
    href: `/builder.html?card=${card.id}`,
    class: 'stretched-link',
  }, card.title);
  const title = createElement('h3', { class: 'saved-card-title' }, titleLink);
  const towns = createElement('p', { class: 'saved-card-towns' }, card.towns.join(', '));
  const updatedTime = createElement('time', { datetime: card.updatedAt }, formatDate(card.updatedAt));
  const metadata = createElement('dl', { class: 'saved-card-meta' });
  metadata.append(
    createElement('dt', {}, 'Dataset'),
    createElement('dd', {}, `${card.dataset.name}, ${card.dataset.vintage}`),
    createElement('dt', {}, 'Created by'),
    createElement('dd', {}, card.createdBy.name),
    createElement('dt', {}, 'Updated'),
    createElement('dd', {}, updatedTime),
  );

  const body = createElement('div', { class: 'saved-card-body' }, title, towns, metadata);
  const buttons = cardActionButtons(card, {
    user: currentUser,
    status: cardsStatus,
    reload: loadCards,
  });
  const actions = createElement('div', { class: 'saved-card-actions' }, ...buttons);
  return createElement('li', { class: 'saved-card' }, body, actions);
}

function handleSearchInput() {
  // Invalidate any active request while the next search waits for the debounce.
  reportRequestNumber += 1;
  renderDatasets();
  scheduleReportSearch();
}

function handleSearchSubmit(event) {
  event.preventDefault();
  renderDatasets();
  loadCards();
}

boot(initializeDashboard);
