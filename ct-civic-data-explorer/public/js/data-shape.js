/**
 * Summarize the dataset's primary field and reportable columns.
 */
import { h as createElement } from './dom.js';
import { pluralize } from './report-details.js';
import { fieldUnitLabel } from '/shared/field-groups.js';

function joinWords(words) {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function describeRowCounts(shape) {
  return joinWords(shape.kinds.filter((kind) => kind.type !== 'state').map((kind) => {
    const noun = kind.type === 'row' ? 'distinct value' : kind.noun;
    return `${kind.count.toLocaleString('en-US')} ${kind.count === 1 ? noun : pluralize(noun)}`;
  }));
}

/**
 * @param {HTMLElement} container
 * @param {{ shape: object, fields: object[], emptyFieldsText: string }} options
 *   fields are the columns a report may use, already filtered by approval
 */
export function renderShapePanel(container, { shape, fields, emptyFieldsText }) {
  const rows = createElement('section', { class: 'shape-card', 'aria-labelledby': 'shape-rows-title' });
  rows.append(
    createElement('span', { class: 'shape-kicker' }, 'Primary field'),
    createElement('p', { class: 'shape-headline', id: 'shape-rows-title' }, createElement('strong', {}, shape.rowColumn?.label ?? 'Spreadsheet row number')),
  );
  const details = [describeRowCounts(shape)];
  if (shape.kinds.some((kind) => kind.type === 'state')) {
    details.push('Connecticut statewide total');
  }
  if (details.some(Boolean)) {
    rows.append(createElement('p', { class: 'shape-detail' }, details.filter(Boolean).join(' · ')));
  }
  if (shape.repeated) {
    rows.append(createElement('p', { class: 'shape-note' }, 'Some values appear on multiple rows. Reports keep those rows separate.'));
  }

  const columns = createElement('section', { class: 'shape-card', 'aria-labelledby': 'shape-columns-title' });
  const numbers = fields.filter((field) => field.type !== 'text').length;
  const categories = fields.length - numbers;
  const counts = [];
  if (numbers) counts.push(`${numbers} ${numbers === 1 ? 'number' : 'numbers'}`);
  if (categories) counts.push(`${categories} ${categories === 1 ? 'category' : 'categories'}`);
  columns.append(
    createElement('span', { class: 'shape-kicker' }, 'Columns · what is shown for each row'),
    createElement('p', { class: 'shape-headline', id: 'shape-columns-title' },
      fields.length ? createElement('strong', {}, joinWords(counts)) : 'No columns yet',
      fields.length ? ' for each row' : ''),
  );
  if (fields.length) {
    const chips = createElement('ul', { class: 'shape-chips' });
    for (const field of fields) {
      chips.append(createElement('li', {}, field.displayLabel || field.label, createElement('span', {}, fieldUnitLabel(field))));
    }
    columns.append(chips);
  } else {
    columns.append(createElement('p', { class: 'shape-detail' }, emptyFieldsText));
  }

  container.replaceChildren(rows, columns);
}
