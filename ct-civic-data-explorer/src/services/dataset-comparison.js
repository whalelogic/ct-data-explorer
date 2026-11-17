/** Align approved indicators by canonical Connecticut geography or compatible source labels. */
import { HttpError } from '../lib/http-error.js';
import * as records from '../repositories/dataset-records.js';
import * as observations from '../repositories/observations.js';
import * as towns from '../repositories/towns.js';
import { formatValue } from '../shared/format.js';
import { computeValue } from './compute.js';
import { availableFields, requireAccessibleDataset } from './datasets.service.js';
import { approvedDefinitions } from './field-curation.js';
import { applyFieldPresentation } from './presentation.js';
import { presentDataset, presentPlace } from './presenters.js';
import { PLACE_GROUPS, rowLabelColumn } from './row-labels.js';
import { comparisonIndicatorKey } from './selection.js';
import { formatDatasetCell } from './tabular-data.js';
import { townMembership } from './town-membership.js';

const GROUP_LABELS = { town: 'Towns', county: 'Counties', region: 'Planning regions', state: 'State', label: 'Rows' };
const ROLLUP_ORDER = ['town', 'region', 'county'];
const SUM_UNITS = new Set(['count', 'area', 'number']);
const normalize = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Resolve every source before reading any of its records or fields. */
async function loadDatasets(ids, user, selectedFields = new Map()) {
  const authorized = await Promise.all([...new Set(ids)].map((id) => requireAccessibleDataset(id, user, { activeOnly: true })));
  return Promise.all(authorized.map(async (dataset) => {
    const rowBased = dataset.data_format === 'records';
    const fields = await availableFields(dataset);
    const approved = approvedDefinitions(fields, dataset.approved_fields).filter((field) => field.type === 'number');
    const keys = selectedFields.get(dataset.id) ?? [];
    const invalid = keys.find((key) => !approved.some((field) => field.key === key));
    if (invalid) throw new HttpError(400, `Indicator “${invalid}” is unavailable for comparison`);
    const labelColumn = rowBased ? rowLabelColumn(dataset) : null;
    const cellKeys = labelColumn && labelColumn.role !== 'town' ? [labelColumn.key, ...keys] : keys;
    const rows = rowBased
      ? await records.list(dataset.id, { cellKeys })
      : await observations.previewPlaces(dataset.id, { offset: 0, limit: 10000 });
    return {
      dataset,
      rows,
      rowBased,
      fields: applyFieldPresentation(approved, dataset.presentation),
      labelColumn,
    };
  }));
}

export async function getComparisonOptions(datasetIds, user) {
  const [sources, places] = await Promise.all([loadDatasets(datasetIds, user), towns.list()]);
  const groupBy = Object.keys(GROUP_LABELS).flatMap((group) => {
    const grouped = groupDatasets(group, sources, places);
    if (!grouped) return [];
    return [{
      id: group,
      label: grouped.label,
      values: grouped.places.map((place) => place.name),
      datasets: grouped.groups.map((byPlace, index) => ({
        id: sources[index].dataset.id,
        hasSource: grouped.places.some(({ id }) => byPlace.get(id)?.direct.length),
        hasRollup: grouped.places.some(({ id }) => byPlace.get(id)?.fallback.size),
      })),
    }];
  });
  return { groupBy, datasets: sources.map(({ dataset, fields }) => ({ id: dataset.id, columns: fields })) };
}

export async function compareDatasets(selection, user) {
  const { groupBy, sources: selections } = selection.comparison;
  const selectedFields = new Map();
  for (const { datasetId, indicator } of selections) {
    if (!selectedFields.has(datasetId)) selectedFields.set(datasetId, []);
    selectedFields.get(datasetId).push(indicator);
  }
  const [sources, catalog] = await Promise.all([
    loadDatasets([...selectedFields.keys()], user, selectedFields),
    towns.list(),
  ]);
  const datasets = sources.map((source) => presentDataset(source.dataset));
  const anchor = datasets.find(({ id, name, vintage }) => (!selection.dataset.id || id === selection.dataset.id)
    && selection.dataset.name === name && selection.dataset.vintage === vintage);
  if (!anchor) throw new HttpError(400, 'Choose a dataset used in this comparison');
  const grouped = groupDatasets(groupBy, sources, catalog);
  if (!grouped) throw new HttpError(400, 'These datasets have no comparable rows at this level');

  const placeByName = new Map(grouped.places.map((place) => [normalize(place.name), place]));
  const places = selection.allRows ? grouped.places : selection.rows.map((name) => {
    const place = placeByName.get(normalize(name));
    if (!place) throw new HttpError(400, `“${name}” is unavailable for this comparison`);
    return place;
  });

  const prepared = await Promise.all(sources.map(async (source, index) => ({
    ...source,
    groups: grouped.groups[index],
    values: source.rowBased ? null : await observations.valuesByTown(source.dataset.id, source.rows.map((row) => row.id)),
  })));
  const byDataset = new Map(prepared.map((source) => [source.dataset.id, source]));

  const indicators = selections.map((selected, index) => {
    const { dataset, values, groups, fields } = byDataset.get(selected.datasetId);
    const field = fields.find((candidate) => candidate.key === selected.indicator);
    if (selected.aggregation === 'sum' && (!SUM_UNITS.has(field.unit) || field.derivation === 'ratio')) {
      throw new HttpError(400, `Choose source values or an average for “${field.label}”`);
    }
    const key = comparisonIndicatorKey(selected);
    const name = dataset.presentation?.displayName || dataset.name;
    const label = sources.length === 1 ? field.label : `${field.label} (${name}, ${dataset.vintage}, v${dataset.version})`;
    const decimals = selected.aggregation === 'average' ? Math.max(2, field.decimals ?? 0) : field.decimals;
    const [definition] = applyFieldPresentation([{ ...field, key, label, decimals }], {}, selection.fieldOverrides);
    const read = values ? (row) => readObservation(row, field, values) : (row) => readRecord(row, field);
    const format = values ? (value) => formatValue(value, definition) : (value) => formatDatasetCell(value, { ...definition, scale: 1 });
    const cells = places.map(({ id }) => {
      const result = compareCell(groups.get(id), selected.aggregation, read);
      return { ...result, display: format(result.value) };
    });
    return {
      ...definition,
      cells,
      datasetId: dataset.id,
      indicatorKey: field.key,
      indicatorLabel: field.label,
      role: index === 0 ? 'primary' : 'secondary',
      aggregation: selected.aggregation,
    };
  });

  return {
    dataset: anchor,
    datasets,
    places,
    indicators,
    rowNoun: grouped.noun,
    comparison: {
      groupBy,
      sharedIndicators: sharedIndicators(sources),
      relationships: indicators.slice(1).map((indicator) => correlate(indicators[0], indicator)),
      notes: comparisonNotes(indicators),
    },
  };
}

function groupDatasets(group, sources, catalog) {
  if (group === 'label') return groupLabels(sources);
  const placesByName = new Map(catalog.map((place) => [place.name, place]));
  const groups = sources.map((source) => groupGeography(source, group, placesByName));
  if (groups.some((set) => !set.size)) return null;
  const places = catalog.filter((place) => groups.some((map) => map.has(place.id))).map(presentPlace);
  // State is the row being compared here, so keep the usual benchmark label off.
  if (group === 'state') places.forEach((place) => { place.label = place.name; });
  return { groups, places, label: GROUP_LABELS[group], noun: PLACE_GROUPS[group]?.noun ?? 'State' };
}

function groupLabels(sources) {
  const label = sources[0]?.labelColumn?.label;
  if (!label || sources.some(({ labelColumn }) => labelColumn?.role === 'town' || normalize(labelColumn?.label) !== normalize(label))) {
    return null;
  }
  const labels = new Map();
  const groups = sources.map(({ rows, labelColumn }) => {
    const byLabel = new Map();
    for (const row of rows) {
      const name = String(row.cell_values[labelColumn.key] ?? '').trim();
      if (!name) continue;
      const id = normalize(name);
      if (!labels.has(id)) labels.set(id, name);
      addRow(byLabel, id, row);
    }
    return byLabel;
  });
  const places = [...labels.entries()]
    .filter(([id]) => groups.every((group) => group.has(id)))
    .map(([id, name]) => ({ id, name, label: name, geoType: 'row' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return places.length ? { groups, places, label, noun: label } : null;
}

function groupGeography({ rows, rowBased }, group, placesByName) {
  const byPlace = new Map();
  for (const row of rows) {
    const type = row.geo_type;
    if (type === group) {
      addRow(byPlace, rowBased ? row.town_id : row.id, row);
    } else if (group === 'state' && ROLLUP_ORDER.includes(type)) {
      const state = placesByName.get('Connecticut');
      if (state) addRow(byPlace, state.id, row, type);
    } else if (type === 'town' && (group === 'county' || group === 'region')) {
      const membership = townMembership.get(row.name);
      const parent = placesByName.get(membership?.[group === 'county' ? 0 : 1]);
      if (parent) addRow(byPlace, parent.id, row, type);
    }
  }
  return byPlace;
}

function addRow(groups, id, row, fallbackType) {
  if (!groups.has(id)) groups.set(id, { direct: [], fallback: new Map() });
  const group = groups.get(id);
  if (!fallbackType) {
    group.direct.push(row);
  } else {
    if (!group.fallback.has(fallbackType)) group.fallback.set(fallbackType, []);
    group.fallback.get(fallbackType).push(row);
  }
}

function readRecord(row, field) {
  const value = row.cell_values[field.key];
  return value == null ? null : value * (field.scale ?? 1);
}

function readObservation(row, field, values) {
  return computeValue({ ...field, numerator_key: field.numeratorKey, denominator_key: field.denominatorKey }, values.get(row.id));
}

export function compareCell(group, method, read) {
  if (!group) return { value: null, observationCount: 0 };
  if (method === 'source') {
    const value = group.direct.length === 1 ? read(group.direct[0]) : null;
    return Number.isFinite(value) ? { value, observationCount: 1 } : { value: null, observationCount: 0 };
  }
  let values = group.direct.map(read).filter(Number.isFinite);
  let rollupFrom;
  for (const level of ROLLUP_ORDER) {
    if (values.length) break;
    values = (group.fallback.get(level) ?? []).map(read).filter(Number.isFinite);
    if (values.length) rollupFrom = level;
  }
  if (!values.length) return { value: null, observationCount: 0 };
  const divisor = method === 'average' ? values.length : 1;
  const total = values.reduce((sum, value) => sum + value / divisor, 0);
  return {
    value: Number.isFinite(total) ? total : null,
    observationCount: values.length,
    ...(rollupFrom ? { rollupFrom } : {}),
  };
}

function sharedIndicators(sources) {
  const byIndicator = new Map();
  for (const { dataset, fields } of sources) {
    const seen = new Set();
    for (const field of fields) {
      // Match the label and unit. Record keys such as "c2" are positions, not identities.
      const key = JSON.stringify([normalize(field.label), field.unit]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!byIndicator.has(key)) byIndicator.set(key, { label: field.label, unit: field.unit, datasets: [] });
      byIndicator.get(key).datasets.push({ id: dataset.id, name: dataset.name, indicator: field.key });
    }
  }
  return [...byIndicator.values()].filter((indicator) => indicator.datasets.length > 1);
}

export function correlate(primary, secondary) {
  const pairs = primary.cells.map((cell, index) => [cell.value, secondary.cells[index].value])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const result = { primary: primary.key, secondary: secondary.key, pairedRows: pairs.length, correlation: null };
  if (pairs.length < 3) return result;

  const maxX = Math.max(...pairs.map(([x]) => Math.abs(x)));
  const maxY = Math.max(...pairs.map(([, y]) => Math.abs(y)));
  if (maxX === 0 || maxY === 0) return result;
  // Scaling first keeps the variance in range even for very large source values.
  const scaled = pairs.map(([x, y]) => [x / maxX, y / maxY]);
  const [totalX, totalY] = scaled.reduce(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0]);
  const mx = totalX / pairs.length;
  const my = totalY / pairs.length;
  const [varianceX, varianceY, covariance] = scaled.reduce(([vx, vy, cov], [x, y]) => {
    const dx = x - mx;
    const dy = y - my;
    return [vx + dx * dx, vy + dy * dy, cov + dx * dy];
  }, [0, 0, 0]);
  const correlation = covariance / Math.sqrt(varianceX) / Math.sqrt(varianceY);
  if (Number.isFinite(correlation)) result.correlation = Math.max(-1, Math.min(1, correlation));
  return result;
}

function comparisonNotes(indicators) {
  const notes = [];
  if (indicators.some((series) => series.cells.some((cell) => cell.rollupFrom))) {
    notes.push('Geographic rollups use available rows from one smaller geography and may have partial coverage.');
  }
  if (indicators.some((series) => series.aggregation === 'sum' && series.cells.some((cell) => cell.observationCount > 1))) {
    notes.push('Totals add source rows. Overlapping categories can affect their interpretation.');
  }
  if (indicators.some((series) => series.aggregation === 'average' && series.cells.some((cell) => cell.observationCount > 1))) {
    notes.push('Averages give each source row equal weight.');
  }
  if (indicators.some((series) => series.cells.some((cell) => cell.value == null))) {
    notes.push('N/A marks a missing value or a place with multiple source rows.');
  }
  return notes;
}
