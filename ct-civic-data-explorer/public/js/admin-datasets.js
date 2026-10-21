const textOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const sortKeys = new Set(['name', 'vintage', 'version', 'rowCount', 'uploadedAt', 'publication', 'review']);

export function defaultDatasetQuery() {
  return {
    search: '',
    vintage: '',
    publication: '',
    review: '',
    sortKey: 'uploadedAt',
    sortDirection: 'descending',
  };
}

export function filterAndSortDatasets(datasets, query = {}) {
  const filters = { ...defaultDatasetQuery(), ...query };
  const searchTerms = String(filters.search ?? '').trim().toLocaleLowerCase('en').split(/\s+/).filter(Boolean);
  const sortKey = sortKeys.has(filters.sortKey) ? filters.sortKey : 'uploadedAt';
  const direction = filters.sortDirection === 'ascending' ? 1 : -1;

  return datasets
    .map((dataset, index) => ({ dataset, index }))
    .filter(({ dataset }) => {
      const searchText = [dataset.displayName, dataset.name, sourceName(dataset.source), dataset.vintage]
        .join(' ').toLocaleLowerCase('en');
      return searchTerms.every((term) => searchText.includes(term))
        && (!filters.vintage || String(dataset.vintage ?? '') === String(filters.vintage))
        && (!filters.publication || publication(dataset) === filters.publication)
        && (!filters.review || review(dataset) === filters.review);
    })
    .sort((left, right) => {
      const first = sortValue(left.dataset, sortKey);
      const second = sortValue(right.dataset, sortKey);
      if (first === null && second !== null) return 1;
      if (first !== null && second === null) return -1;
      const difference = first === null && second === null ? 0
        : typeof first === 'number' ? first - second : textOrder.compare(first, second);
      return difference * direction || left.index - right.index;
    })
    .map(({ dataset }) => dataset);
}

export function datasetFilterChoices(datasets) {
  return {
    vintages: [...new Set(datasets.map((dataset) => String(dataset.vintage ?? '')).filter(Boolean))]
      .sort(textOrder.compare),
    publications: ['published', 'unpublished'].filter((value) => datasets.some((dataset) => publication(dataset) === value)),
    reviews: ['needs-review', 'reviewed'].filter((value) => datasets.some((dataset) => review(dataset) === value)),
  };
}

function sourceName(source) {
  return source && typeof source === 'object'
    ? source.displayName || source.name || source.label || source.title || ''
    : source;
}

function publication(dataset) {
  return dataset.isActive ? 'published' : 'unpublished';
}

function review(dataset) {
  return dataset.curationReviewed ? 'reviewed' : 'needs-review';
}

function numericValue(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sortValue(dataset, key) {
  if (key === 'name') return String(dataset.displayName || dataset.name || '');
  if (key === 'publication') return publication(dataset);
  if (key === 'review') return dataset.curationReviewed ? dataset.approvedFields?.length ?? 0 : -1;
  if (key === 'version' || key === 'rowCount') return numericValue(dataset[key]);
  if (key === 'uploadedAt') {
    const value = dataset.uploadedAt;
    if (value === null || value === undefined || value === '') return null;
    const timestamp = typeof value === 'number' ? value : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return String(dataset[key] ?? '');
}
