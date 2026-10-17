/**
 * Explain a dataset's shape in plain words: what each ROW is (the thing being compared)
 * and what the COLUMNS are (what is measured or described for each row).
 * Used on the dataset page and the report builder so both say it the same way.
 */
import { h as createElement } from './dom.js';
import { pluralize } from './report-details.js';
import { fieldUnitLabel } from '/shared/field-groups.js';

function withArticle(noun) {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

function joinWords(words, conjunction = 'and') {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} ${conjunction} ${words.at(-1)}`;
}

/** The things rows can be, without the statewide benchmark, e.g. ["town", "county"]. */
function rowKinds(shape) {
  return shape.kinds.filter((kind) => kind.type !== 'state');
}

/** "141 towns and 8 counties", "12 Program values". */
export function describeRowCounts(shape) {
  return joinWords(rowKinds(shape).map((kind) => {
    const noun = kind.type === 'row' ? `${kind.noun} ${kind.count === 1 ? 'value' : 'values'}` : pluralize(kind.noun);
    return `${kind.count.toLocaleString('en-US')} ${kind.count === 1 && kind.type !== 'row' ? kind.noun : noun}`;
  }));
}

/** "a town or county", "a Program". */
export function describeRowNoun(shape) {
  const nouns = rowKinds(shape).map((kind) => kind.noun);
  if (!nouns.length) return 'a row';
  return `${withArticle(nouns[0])}${nouns.length > 1 ? ` or ${joinWords(nouns.slice(1), 'or')}` : ''}`;
}

/**
 * @param {HTMLElement} container
 * @param {{ shape: object, fields: object[], emptyFieldsText: string }} options
 *   fields are the columns a report may use, already filtered by approval
 */
export function renderShapePanel(container, { shape, fields, emptyFieldsText }) {
  const rows = createElement('section', { class: 'shape-card', 'aria-labelledby': 'shape-rows-title' });
  rows.append(
    createElement('span', { class: 'shape-kicker' }, 'Rows · what is compared'),
    createElement('p', { class: 'shape-headline', id: 'shape-rows-title' }, 'Each row is ', createElement('strong', {}, describeRowNoun(shape))),
  );
  const details = [describeRowCounts(shape)];
  if (shape.rowColumn?.label) {
    details.push(`named by the “${shape.rowColumn.label}” column`);
  }
  if (shape.kinds.some((kind) => kind.type === 'state')) {
    details.push('plus a Connecticut statewide total');
  }
  rows.append(createElement('p', { class: 'shape-detail' }, details.filter(Boolean).join(' · ')));
  if (shape.repeated) {
    rows.append(createElement('p', { class: 'shape-note' },
      `Some appear on more than one row (${shape.totalRows.toLocaleString('en-US')} rows in all). Every row is kept; nothing is added together.`));
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
