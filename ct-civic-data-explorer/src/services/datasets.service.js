/** Dataset upload and versioning (SRS US003). */
import { withTransaction } from '../db/pool.js';
import { HttpError } from '../lib/http-error.js';
import * as datasets from '../repositories/datasets.js';
import * as indicators from '../repositories/indicators.js';
import * as observations from '../repositories/observations.js';
import * as reports from '../repositories/reports.js';
import * as sources from '../repositories/sources.js';
import * as towns from '../repositories/towns.js';
import * as records from '../repositories/dataset-records.js';
import { readDatasetRecords } from './dataset-file.js';
import { inspectTabularColumns, prepareTabularDataset, formatDatasetCell } from './tabular-data.js';
import { PLACE_GROUPS, isTownKeyed, recordRowName, rowLabelCandidates, rowLabelColumn, rowNoun } from './row-labels.js';
import { MAX_NAMED_ROWS, MAX_ROW_NAME_LENGTH } from './selection.js';
import { computeValue } from './compute.js';
import { formatValue } from '../shared/format.js';
import { presentDataset, presentIndicator, presentPlace } from './presenters.js';
import {
  approvedDefinitions,
  datasetIndicators,
  isRowIdentity,
  requirePublishable,
  validateApprovedFields,
} from './field-curation.js';

import { applyFieldPresentation, datasetPresentationSchema } from './presentation.js';

export { datasetIndicators } from './field-curation.js';

export function listDatasets({ activeOnly = true, scope, user } = {}) {
  return datasets.list({ activeOnly, scope, ownerId: user?.id });
}

/** Private data is visible only to the uploader. Admin access to public drafts is optional. */
export async function requireAccessibleDataset(datasetId, user, { activeOnly = false, database } = {}) {
  const dataset = await datasets.findById(datasetId, database);
  if (!dataset || (dataset.is_private && dataset.uploaded_by !== user?.id)
      || (!dataset.is_active && (activeOnly || user?.role !== 'admin'))) {
    throw new HttpError(404, 'Dataset not found');
  }
  return dataset;
}

/** Admins inspect source fields before approval; staff previews use only approved fields. */
export async function getDatasetOverview(datasetId, { offset = 0, limit = 25 }, user) {
  const dataset = await requireAccessibleDataset(datasetId, user);

  const previewApprovals = user?.role === 'admin' ? null : dataset.approved_fields;
  const presentedDataset = presentDataset(dataset, { includeUploadDetails: Boolean(user) });
  if (dataset.data_format === 'records') {
    return buildRecordOverview(dataset, presentedDataset, previewApprovals, { offset, limit });
  }
  return buildIndicatorOverview(dataset, presentedDataset, previewApprovals, { offset, limit });
}

async function buildRecordOverview(dataset, presentedDataset, approvedFields, { offset, limit }) {
  const columns = applyFieldPresentation(approvedDefinitions(dataset.column_definitions ?? [], approvedFields, { includeTown: true }), dataset.presentation);
  const sourceRows = await records.list(dataset.id, { offset, limit });
  const previewRows = [];

  for (const row of sourceRows) {
    const cells = [];
    for (const column of columns) {
      const value = row.cell_values[column.key];
      cells.push({ value, display: formatDatasetCell(value, column) });
    }
    previewRows.push({ sourceRow: row.source_row, cells });
  }

  return {
    dataset: presentedDataset,
    shape: describeRecordShape(dataset, await records.list(dataset.id)),
    indicators: columns.filter((column) => !isRowIdentity(column)),
    preview: {
      offset,
      limit,
      total: dataset.row_count,
      columns,
      rows: previewRows,
    },
  };
}

/**
 * What one row of a dataset is, in words people use: which column names the rows, what
 * kinds of things they are ("141 towns, 8 counties" or "12 programs") and whether a name
 * repeats across rows. Nothing here reveals unapproved values: only the row column is read.
 */
function describeRecordShape(dataset, sourceRows) {
  const labelColumn = rowLabelColumn(dataset);
  const townKeyed = isTownKeyed(dataset);
  const names = sourceRows.map((row) => [recordRowName(row, labelColumn, townKeyed), townKeyed ? row.geo_type : 'row']);
  return describeShape({ rowColumn: labelColumn && { key: labelColumn.key, label: rowNoun(dataset) }, townKeyed, names });
}

function describeShape({ rowColumn, townKeyed, names }) {
  const distinctByType = new Map();
  for (const [name, type] of names) {
    const group = distinctByType.get(type) ?? new Set();
    group.add(name);
    distinctByType.set(type, group);
  }
  const kinds = [];
  for (const [type, group] of Object.entries({ ...PLACE_GROUPS, state: { label: 'Statewide total', noun: 'statewide total' } })) {
    if (distinctByType.has(type)) {
      kinds.push({ type, label: group.label, noun: group.noun, count: distinctByType.get(type).size });
    }
  }
  if (distinctByType.has('row')) {
    const label = rowColumn?.label ?? 'Row';
    kinds.push({ type: 'row', label, noun: label, count: distinctByType.get('row').size });
  }
  const distinctRows = [...distinctByType.values()].reduce((total, group) => total + group.size, 0);
  return { rowColumn, townKeyed, kinds, totalRows: names.length, distinctRows, repeated: distinctRows < names.length };
}

async function buildIndicatorOverview(dataset, presentedDataset, approvedFields, { offset, limit }) {
  const [definitions, storedKeys, places, totalPlaces] = await Promise.all([
    indicators.list(),
    observations.indicatorKeys(dataset.id),
    observations.previewPlaces(dataset.id, { offset, limit }),
    observations.countPlaces(dataset.id),
  ]);
  const availableIndicators = datasetIndicators(definitions, storedKeys);
  const approvedIndicators = applyFieldPresentation(approvedDefinitions(availableIndicators, approvedFields), dataset.presentation);
  const placeIds = places.map((place) => place.id);
  const valuesByPlace = await observations.valuesByTown(dataset.id, placeIds);
  const previewRows = [];

  for (const place of places) {
    const cells = [];
    for (const indicator of approvedIndicators) {
      const value = computeValue(indicator, valuesByPlace.get(place.id));
      cells.push({ value, display: formatValue(value, indicator) });
    }
    previewRows.push({ place: presentPlace(place), cells });
  }

  const allPlaces = await observations.previewPlaces(dataset.id, { offset: 0, limit: 10000 });
  return {
    dataset: presentedDataset,
    shape: describeShape({ rowColumn: { key: null, label: 'Town' }, townKeyed: true, names: allPlaces.map((place) => [place.name, place.geo_type]) }),
    indicators: approvedIndicators.map(presentIndicator),
    preview: {
      offset,
      limit,
      total: totalPlaces,
      rows: previewRows,
    },
  };
}

export async function availableFields(dataset, database) {
  if (dataset.data_format === 'records') {
    const columns = dataset.column_definitions ?? [];
    return columns.filter((column) => !isRowIdentity(column));
  }

  const [definitions, storedKeys] = await Promise.all([
    indicators.list(database),
    observations.indicatorKeys(dataset.id, database),
  ]);
  const availableIndicators = datasetIndicators(definitions, storedKeys);
  const fields = [];
  for (const indicator of availableIndicators) {
    fields.push({ ...presentIndicator(indicator), type: 'number', role: 'measure' });
  }
  return fields;
}

function addDisplayLabels(fields) {
  const labeledFields = [];
  for (const field of fields) {
    labeledFields.push({ ...field, displayLabel: field.displayLabel ?? field.label });
  }
  return labeledFields;
}

function presentCuration(dataset, fields) {
  const approvedFields = approvedDefinitions(fields, dataset.approved_fields);
  return {
    dataset: presentDataset(dataset),
    fields: applyFieldPresentation(addDisplayLabels(fields), dataset.presentation),
    approvedFields: approvedFields.map((field) => field.key),
    curationReviewed: Boolean(dataset.curation_reviewed_at),
  };
}

export async function getDatasetCuration(datasetId, user) {
  if (user.role !== 'admin') {
    throw new HttpError(403, 'Administrator access is required');
  }
  const dataset = await datasets.findById(datasetId);
  if (!dataset || dataset.is_private) {
    throw new HttpError(404, 'Dataset not found');
  }
  const fields = await availableFields(dataset);
  return presentCuration(dataset, fields);
}

export async function updateDatasetCuration(datasetId, approvedFields, user) {
  if (user.role !== 'admin') {
    throw new HttpError(403, 'Administrator access is required');
  }

  return withTransaction(async (client) => {
    await client.lock(`dataset-curation:${datasetId}`);
    const dataset = await datasets.findById(datasetId, client);
    if (!dataset || dataset.is_private) {
      throw new HttpError(404, 'Dataset not found');
    }

    const fields = await availableFields(dataset, client);
    const validatedFields = validateApprovedFields(fields, approvedFields);
    if (dataset.data_format === 'records' && dataset.row_label_key) {
      const previousKey = rowLabelColumn(dataset)?.key;
      const fallbackKey = rowLabelColumn({ ...dataset, approved_fields: validatedFields })?.key ?? null;
      if (fallbackKey !== dataset.row_label_key) {
        if (previousKey) await reports.pinRecordCompareColumn(datasetId, previousKey, client);
        await datasets.setRowLabelKey(datasetId, fallbackKey, client);
      }
    }
    await datasets.setCuration(datasetId, validatedFields, user.id, client);
    if (approvedFields.length === 0 && dataset.is_active) {
      await datasets.setActive(datasetId, false, client);
    }
    const updatedDataset = await datasets.findById(datasetId, client);
    return presentCuration(updatedDataset, fields);
  });
}

/** Read an uploaded file's columns so staff can choose the row label column. Nothing is saved. */
export async function inspectUpload({ file, filename, worksheet }) {
  const allTowns = await towns.list();
  const sourceRows = await readDatasetRecords(file, { filename, worksheet });
  const inspection = inspectTabularColumns(sourceRows, { towns: allTowns });
  if (inspection.problems.length) {
    throw new HttpError(422, inspection.problems[0], inspection.problems);
  }
  return inspection;
}

/** Reject the whole upload if validation fails; accepted uploads create a new version. */
export async function uploadDataset({ file, filename, worksheet, name, source, vintage, activate, labelColumn, labelIsTown }, user,
  { privateUpload = false } = {}) {
  if (!privateUpload && activate) {
    throw new HttpError(400, 'Upload the dataset for review, approve its fields, then publish it.');
  }

  const [allTowns, allIndicators] = await Promise.all([towns.list(), indicators.list()]);
  const sourceRows = await readDatasetRecords(file, { filename, worksheet });
  const preparedDataset = prepareTabularDataset(
    sourceRows,
    { towns: allTowns, indicators: allIndicators },
    { labelColumn, labelIsTown },
  );
  if (preparedDataset.problemCount > 0) {
    const noun = preparedDataset.problemCount === 1 ? 'problem' : 'problems';
    const message = `Upload rejected: ${preparedDataset.problemCount} ${noun} found. Nothing was saved.`;
    throw new HttpError(422, message, preparedDataset.problems);
  }

  return withTransaction(async (client) => {
    const ownerScope = privateUpload ? user.id : 0;
    await datasets.lockNameVintage(name, vintage, ownerScope, client);
    const version = await datasets.nextVersion(name, vintage, ownerScope, client);
    const sourceId = await sources.findOrCreate(privateUpload ? 'Private upload' : source, client);
    const datasetDetails = {
      name,
      sourceId,
      vintage,
      version,
      rowCount: preparedDataset.rowCount,
      uploadedBy: user.id,
      privateSource: privateUpload ? source : null,
      dataFormat: preparedDataset.dataFormat,
      columns: preparedDataset.columns,
      notes: preparedDataset.notes,
      rowLabelKey: preparedDataset.dataFormat === 'records' ? preparedDataset.rowLabelKey : null,
    };
    const { id: datasetId } = await datasets.insert(datasetDetails, client);
    await observations.insertMany(datasetId, preparedDataset.observations, client);
    await records.insertMany(datasetId, preparedDataset.rows, client);
    return datasets.findById(datasetId, client);
  });
}

export async function getReportOptions(datasetId, user, { compareBy } = {}) {
  const dataset = await requireAccessibleDataset(datasetId, user);
  const labelColumn = rowLabelColumn(dataset);

  const fields = await availableFields(dataset);
  const approvedFields = applyFieldPresentation(approvedDefinitions(fields, dataset.approved_fields), dataset.presentation);
  const sharedOptions = {
    dataFormat: dataset.data_format ?? 'indicators',
    defaultChartType: dataset.presentation?.defaultChartType || 'grouped_bar',
    rowLabelKey: labelColumn?.key ?? null,
    curationReviewed: Boolean(dataset.curation_reviewed_at),
    columns: addDisplayLabels(approvedFields),
  };

  if (dataset.data_format !== 'records') {
    const places = await observations.previewPlaces(datasetId, { offset: 0, limit: 10000 });
    const compareOptions = placeCompareOptions(places);
    return {
      ...sharedOptions,
      compareOptions,
      defaultCompare: compareOptions[0]?.id ?? null,
      rowKind: 'town',
      rowNoun: 'Town',
      filters: [],
      repeatedRows: false,
      hasState: places.some((place) => place.geo_type === 'state'),
      places: places.map(presentPlace),
    };
  }

  const sourceRows = await records.list(datasetId);
  const townKeyed = isTownKeyed(dataset);
  const geographyColumn = rowLabelCandidates(dataset).find((column) => column.role === 'town');
  const placesByName = new Map();
  for (const row of sourceRows) {
    const name = recordRowName(row, labelColumn, townKeyed);
    if (!placesByName.has(name)) {
      placesByName.set(name, {
        id: townKeyed ? row.town_id : null,
        name,
        geo_type: townKeyed ? row.geo_type : 'row',
      });
    }
  }

  const repeatedRows = placesByName.size < sourceRows.length;
  const places = [...placesByName.values()];
  places.sort((firstPlace, secondPlace) => firstPlace.name.localeCompare(secondPlace.name, 'en', { numeric: true }));

  const compareOptions = [
    ...(geographyColumn ? placeCompareOptions(sourceRows) : []),
    ...columnCompareOptions(dataset, sourceRows, { primaryKey: labelColumn?.key, compareBy }),
  ];
  const defaultCompare = townKeyed ? compareOptions[0]?.id : labelColumn?.key;
  return {
    ...sharedOptions,
    geographyKey: geographyColumn?.key ?? null,
    compareOptions,
    defaultCompare: compareOptions.some((option) => option.id === defaultCompare) ? defaultCompare : compareOptions[0]?.id ?? null,
    rowKind: townKeyed ? 'town' : 'label',
    rowNoun: rowNoun(dataset),
    hasState: Boolean(geographyColumn) && sourceRows.some((row) => row.geo_type === 'state'),
    repeatedRows,
    places: places.map((place) => (place.geo_type === 'row' ? { ...place, geoType: 'row', label: place.name } : presentPlace(place))),
    filters: buildCategoryFilters(approvedFields, sourceRows),
  };
}

const byName = (first, second) => first.localeCompare(second, 'en', { numeric: true });

/** Towns, counties and planning regions present in the data, each a separate thing to compare. */
function placeCompareOptions(places) {
  const namesByType = new Map();
  for (const place of places) {
    if (PLACE_GROUPS[place.geo_type]) {
      const names = namesByType.get(place.geo_type) ?? new Set();
      names.add(place.name ?? place.town_name);
      namesByType.set(place.geo_type, names);
    }
  }
  return Object.entries(PLACE_GROUPS)
    .filter(([type]) => namesByType.has(type))
    .map(([type, group]) => ({ id: type, kind: 'place', ...group, values: [...namesByType.get(type)].sort(byName) }));
}

/**
 * The primary field and the one used in an existing report are always choices when visible.
 * Other fields are offered when the number of values fits the report's named selection limit.
 */
function columnCompareOptions(dataset, sourceRows, { primaryKey, compareBy }) {
  const options = [];
  const columns = applyFieldPresentation(rowLabelCandidates(dataset), dataset.presentation);
  for (const column of columns) {
    if (column.role === 'town') {
      continue;
    }
    const keepAvailable = column.key === primaryKey || column.key === compareBy;
    const names = new Set();
    for (const row of sourceRows) {
      names.add(recordRowName(row, column, false));
      if (!keepAvailable && names.size > MAX_NAMED_ROWS) break;
    }
    if (!keepAvailable && (names.size < 2 || names.size > MAX_NAMED_ROWS)) {
      continue;
    }
    const values = [...names].filter((name) => name.length <= MAX_ROW_NAME_LENGTH).sort(byName);
    options.push({
      id: column.key, kind: 'column', label: column.label, noun: column.label, values,
      totalValues: names.size, omittedValues: names.size - values.length,
    });
  }
  return options;
}

/** Text fields with a manageable number of values can narrow a report to one category. */
function buildCategoryFilters(fields, sourceRows) {
  const filters = [];
  for (const field of fields) {
    if (field.type !== 'text' || field.role !== 'dimension') {
      continue;
    }

    const distinctValues = new Set();
    for (const row of sourceRows) {
      const value = row.cell_values[field.key];
      if (value != null) {
        distinctValues.add(value);
      }
    }
    if (distinctValues.size >= 2 && distinctValues.size <= 250) {
      filters.push({
        key: field.key,
        label: field.label,
        values: [...distinctValues].sort(),
      });
    }
  }
  return filters;
}

/**
 * Choose a visible source field as the dataset's default comparison field.
 */
export async function setDatasetRowLabel(datasetId, rowLabelKey, user) {
  return withTransaction(async (client) => {
    await client.lock(`dataset-curation:${datasetId}`);
    const dataset = await requireAccessibleDataset(datasetId, user, { database: client });
    if (dataset.data_format !== 'records') {
      throw new HttpError(400, 'This indicator dataset uses its stored geography as the primary field.');
    }
    const candidate = rowLabelCandidates(dataset).find((column) => column.key === rowLabelKey);
    if (!candidate) {
      throw new HttpError(400, 'Choose an available source field as the primary field.');
    }
    const previousKey = rowLabelColumn(dataset)?.key;
    if (previousKey === rowLabelKey) return presentRowLabelSettings(dataset);
    if (previousKey) await reports.pinRecordCompareColumn(datasetId, previousKey, client);
    await datasets.setRowLabelKey(datasetId, rowLabelKey, client);
    return presentRowLabelSettings(await datasets.findById(datasetId, client));
  });
}

export async function getDatasetRowLabel(datasetId, user) {
  const dataset = await requireAccessibleDataset(datasetId, user);
  return presentRowLabelSettings(dataset);
}

function presentRowLabelSettings(dataset) {
  const current = rowLabelColumn(dataset);
  const canChange = dataset.data_format === 'records';
  return {
    canChange,
    rowLabelKey: current?.key ?? null,
    townKeyed: isTownKeyed(dataset),
    candidates: canChange
      ? rowLabelCandidates(dataset).map((column) => ({
        key: column.key,
        label: dataset.presentation?.fields?.[column.key]?.label || column.label,
        sourceLabel: column.label,
        isTown: column.role === 'town',
        type: column.type,
      }))
      : [],
  };
}

/** Versions are deactivated rather than deleted, so saved reports keep working. */
export async function setDatasetActive(datasetId, isActive) {
  return withTransaction(async (client) => {
    await client.lock(`dataset-curation:${datasetId}`);
    const dataset = await datasets.findById(datasetId, client);
    if (!dataset || dataset.is_private) {
      throw new HttpError(404, 'Dataset not found');
    }

    // Existing published versions stay usable; a new publication needs approval.
    if (isActive && !dataset.is_active) {
      requirePublishable(dataset);
    }
    const wasUpdated = await datasets.setActive(datasetId, isActive, client);
    if (!wasUpdated) {
      throw new HttpError(404, 'Dataset not found');
    }
    return datasets.findById(datasetId, client);
  });
}

async function presentationAccess(datasetId, user, database) {
  const dataset = await requireAccessibleDataset(datasetId, user, { database });
  const fields = dataset.data_format === 'records' ? dataset.column_definitions ?? [] : await availableFields(dataset, database);
  return { dataset, fields: user.role === 'admin' ? fields : approvedDefinitions(fields, dataset.approved_fields, { includeTown: true }) };
}

function presentSettings(dataset, fields) {
  const allowed = new Set(fields.map((field) => field.key));
  const settings = dataset.presentation ?? {};
  return {
    revision: dataset.presentation_revision ?? 0,
    displayName: settings.displayName ?? '',
    description: settings.description ?? '',
    style: settings.style ?? {},
    defaultChartType: settings.defaultChartType ?? 'grouped_bar',
    fieldOrder: (settings.fieldOrder ?? []).filter((key) => allowed.has(key)),
    fields: Object.fromEntries(Object.entries(settings.fields ?? {}).filter(([key]) => allowed.has(key))),
  };
}

export async function getDatasetPresentation(datasetId, user) {
  const { dataset, fields } = await presentationAccess(datasetId, user);
  return { settings: presentSettings(dataset, fields), fields };
}

export async function updateDatasetPresentation(datasetId, input, user) {
  const parsed = datasetPresentationSchema.parse(input);
  return withTransaction(async (client) => {
    await client.lock(`dataset-curation:${datasetId}`);
    const { dataset, fields } = await presentationAccess(datasetId, user, client);
    if (parsed.revision !== (dataset.presentation_revision ?? 0)) {
      throw new HttpError(409, 'Another staff member changed these defaults. Reload defaults before saving.');
    }
    const allowed = new Set(fields.map((field) => field.key));
    const keys = [...Object.keys(parsed.fields), ...parsed.fieldOrder];
    if (keys.some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'Customize only fields available to you in this dataset.');
    }
    if (new Set(parsed.fieldOrder).size !== parsed.fieldOrder.length) {
      throw new HttpError(400, 'Choose each field only once in the display order.');
    }
    for (const field of fields) {
      if (field.type === 'text' && parsed.fields[field.key]?.decimals !== undefined) {
        throw new HttpError(400, 'Decimal precision applies only to numeric fields.');
      }
    }
    // Staff edits must not erase defaults belonging to currently withheld fields.
    const previous = dataset.presentation ?? {};
    const withheld = Object.fromEntries(Object.entries(previous.fields ?? {}).filter(([key]) => !allowed.has(key)));
    const settings = { ...parsed };
    delete settings.revision;
    settings.style = parsed.style ?? previous.style ?? {};
    settings.fields = { ...withheld, ...parsed.fields };
    settings.fieldOrder = [...parsed.fieldOrder, ...(previous.fieldOrder ?? []).filter((key) => !allowed.has(key))];
    await datasets.setPresentation(datasetId, settings, client);
    const updated = await datasets.findById(datasetId, client);
    return { settings: presentSettings(updated, fields), fields };
  });
}
