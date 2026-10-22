/**
 * "Explore the details": rank a report's rows on one numeric field. Values and their
 * formatting come from the server; the browser only orders them and scales the bars.
 * A statewide figure is a reference line, not a ranked row, and is left out of the bar
 * scale so town values stay readable.
 */
import { h as createElement } from './dom.js';

/**
 * @param {HTMLElement} container empty element to fill
 * @param {object} report built report data from the API
 * @param {{ rowNoun?: string }} [options]
 * @returns {boolean} false when the report has nothing to rank
 */
export function renderReportDetails(container, report, { rowNoun = 'row' } = {}) {
  container.replaceChildren();
  const numericIndicators = report.indicators.filter((indicator) => {
    return indicator.cells.some((cell) => typeof cell.value === 'number');
  });
  const rankedPlaces = report.places.filter((place) => !isReferencePlace(place, report.places));
  if (numericIndicators.length === 0 || rankedPlaces.length < 2) {
    return false;
  }

  const fieldSelect = createElement('select', { id: 'details-field' });
  for (const indicator of numericIndicators) {
    fieldSelect.append(createElement('option', { value: indicator.key }, indicator.displayLabel));
  }
  const orderSelect = createElement('select', { id: 'details-order' });
  for (const [value, label] of [['desc', 'Highest first'], ['asc', 'Lowest first'], ['name', 'A–Z']]) {
    orderSelect.append(createElement('option', { value }, label));
  }
  const summary = createElement('p', { class: 'details-summary', role: 'status', 'aria-live': 'polite' });
  const list = createElement('ol', { class: 'details-ranking' });
  const note = createElement('p', { class: 'small muted details-note' });

  const controls = createElement('div', { class: 'details-controls' },
    createElement('div', {}, createElement('label', { for: 'details-field' }, 'Field'), fieldSelect),
    createElement('div', {}, createElement('label', { for: 'details-order' }, 'Order'), orderSelect),
  );
  container.append(
    createElement('p', { class: 'eyebrow' }, 'Explore the details'),
    createElement('h2', { class: 'details-heading' }, `Compare ${pluralize(rowNoun.toLowerCase())}`),
    controls,
    summary,
    list,
    note,
  );

  const update = () => drawRanking({ report, numericIndicators, fieldSelect, orderSelect, summary, list, note, rowNoun });
  fieldSelect.addEventListener('change', update);
  orderSelect.addEventListener('change', update);
  update();
  return true;
}

function drawRanking({ report, numericIndicators, fieldSelect, orderSelect, summary, list, note, rowNoun }) {
  const indicator = numericIndicators.find((item) => item.key === fieldSelect.value) ?? numericIndicators[0];
  const rows = [];
  const references = [];
  for (const [index, place] of report.places.entries()) {
    const cell = indicator.cells[index];
    if (isReferencePlace(place, report.places)) {
      references.push({ place, cell });
    } else {
      rows.push({ place, cell, hasValue: typeof cell.value === 'number' });
    }
  }
  const valued = rows.filter((row) => row.hasValue);
  const missing = rows.filter((row) => !row.hasValue);
  const byValue = [...valued].sort((first, second) => second.cell.value - first.cell.value);
  const ordered = [...valued];
  if (orderSelect.value === 'name') {
    ordered.sort((first, second) => first.place.label.localeCompare(second.place.label, 'en', { numeric: true }));
  } else if (orderSelect.value === 'asc') {
    ordered.sort((first, second) => first.cell.value - second.cell.value);
  } else {
    ordered.sort((first, second) => second.cell.value - first.cell.value);
  }
  const largest = Math.max(...valued.map((row) => Math.abs(row.cell.value)), 0);

  list.replaceChildren();
  for (const reference of references) {
    if (typeof reference.cell.value === 'number') {
      list.append(createRow(REFERENCE_TAGS[reference.place.geoType], reference.place.label, reference.cell.display, null, true));
    }
  }
  for (const row of ordered) {
    const rank = byValue.indexOf(row) + 1;
    const share = largest > 0 ? Math.abs(row.cell.value) / largest : 0;
    list.append(createRow(String(rank), row.place.label, row.cell.display, share, false));
  }
  for (const row of missing) {
    list.append(createRow('–', row.place.label, row.cell.display || 'N/A', null, false));
  }

  const noun = pluralize(rowNoun.toLowerCase());
  if (byValue.length >= 2) {
    const highest = byValue[0];
    const lowest = byValue.at(-1);
    summary.textContent = `${highest.place.label} is highest (${highest.cell.display}) and ${lowest.place.label} is lowest (${lowest.cell.display}) of ${byValue.length} ${noun}.`;
  } else {
    summary.textContent = `${indicator.displayLabel} for ${valued.length} ${noun}.`;
  }
  const noteParts = [];
  if (references.some((reference) => reference.place.geoType === 'state')) {
    noteParts.push('The statewide figure is shown for reference and is not ranked.');
  }
  if (references.some((reference) => reference.place.geoType !== 'state')) {
    noteParts.push('County and planning region figures include their towns, so they are shown for reference and not ranked against towns.');
  }
  if (missing.length) {
    noteParts.push(`${missing.length} ${missing.length === 1 ? 'row has' : 'rows have'} no value for this field.`);
  }
  note.textContent = noteParts.join(' ');
  note.hidden = noteParts.length === 0;
}

const REFERENCE_TAGS = { state: 'CT', county: 'Co.', region: 'Rgn' };

/**
 * The statewide row is always a reference. Counties and planning regions are references
 * when towns are also shown, since they contain those towns; on their own they are ranked.
 */
function isReferencePlace(place, places) {
  if (place.geoType === 'state') {
    return true;
  }
  const isSummary = place.geoType === 'county' || place.geoType === 'region';
  return isSummary && places.some((other) => other.geoType === 'town');
}

function createRow(rankText, label, display, share, isReference) {
  const row = createElement('li', { class: isReference ? 'details-row is-reference' : 'details-row' });
  row.append(createElement('span', { class: 'details-rank', 'aria-hidden': 'true' }, rankText));
  row.append(createElement('span', { class: 'details-name' }, label));
  const track = createElement('span', { class: 'details-track', 'aria-hidden': 'true' });
  if (share !== null) {
    const bar = createElement('span', { class: 'details-bar' });
    bar.style.width = `${Math.max(share * 100, 1)}%`;
    track.append(bar);
  }
  row.append(track, createElement('span', { class: 'details-value' }, display));
  return row;
}

export function pluralize(noun) {
  if (/[^aeiou]y$/i.test(noun)) {
    return `${noun.slice(0, -1)}ies`;
  }
  return /s$/i.test(noun) ? noun : `${noun}s`;
}
