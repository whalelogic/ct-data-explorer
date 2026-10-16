/** Dataset upload and versioning (SRS US003). */
import { withTransaction } from '../db/pool.js';
import { HttpError } from '../lib/http-error.js';
import * as datasets from '../repositories/datasets.js';
import * as indicators from '../repositories/indicators.js';
import * as observations from '../repositories/observations.js';
import * as sources from '../repositories/sources.js';
import * as towns from '../repositories/towns.js';
import * as records from '../repositories/dataset-records.js';
import { readDatasetRecords } from './dataset-file.js';
import { prepareTabularDataset, formatDatasetCell } from './tabular-data.js';
import { computeValue } from './compute.js';
import { formatValue } from '../shared/format.js';
import { presentDataset, presentIndicator, presentPlace } from './presenters.js';
import {
  approvedDefinitions,
  datasetIndicators,
  requirePublishable,
  validateApprovedFields,
} from './field-curation.js';

import { applyFieldPresentation, datasetPresentationSchema } from './presentation.js';

export { datasetIndicators } from './field-curation.js';

export function listDatasets({ activeOnly }) {
  return datasets.list({ activeOnly });
}

/** Admins inspect source fields before approval; staff previews use only approved fields. */
export async function getDatasetOverview(datasetId, { offset = 0, limit = 25 }, user) {
  const dataset = await datasets.findById(datasetId);
  if (!dataset || (!dataset.is_active && user.role !== 'admin')) {
    throw new HttpError(404, 'Dataset not found');
  }

  const previewApprovals = user.role === 'admin' ? null : dataset.approved_fields;
  if (dataset.data_format === 'records') {
    return buildRecordOverview(dataset, previewApprovals, { offset, limit });
  }
  return buildIndicatorOverview(dataset, previewApprovals, { offset, limit });
}

async function buildRecordOverview(dataset, approvedFields, { offset, limit }) {
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
    dataset: presentDataset(dataset),
    indicators: columns.filter((column) => column.role !== 'town'),
    preview: {
      offset,
      limit,
      total: dataset.row_count,
      columns,
      rows: previewRows,
    },
  };
}

async function buildIndicatorOverview(dataset, approvedFields, { offset, limit }) {
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

  return {
    dataset: presentDataset(dataset),
    indicators: approvedIndicators.map(presentIndicator),
    preview: {
      offset,
      limit,
      total: totalPlaces,
      rows: previewRows,
    },
  };
}

async function availableFields(dataset, database) {
  if (dataset.data_format === 'records') {
    const columns = dataset.column_definitions ?? [];
    return columns.filter((column) => column.role !== 'town');
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
  if (!dataset) {
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
    if (!dataset) {
      throw new HttpError(404, 'Dataset not found');
    }

    const fields = await availableFields(dataset, client);
    const validatedFields = validateApprovedFields(fields, approvedFields);
    await datasets.setCuration(datasetId, validatedFields, user.id, client);
    if (approvedFields.length === 0 && dataset.is_active) {
      await datasets.setActive(datasetId, false, client);
    }
    const updatedDataset = await datasets.findById(datasetId, client);
    return presentCuration(updatedDataset, fields);
  });
}

/** Reject the whole upload if validation fails; accepted uploads create a new version. */
export async function uploadDataset({ file, filename, worksheet, name, source, vintage, activate }, user) {
  if (activate) {
    throw new HttpError(400, 'Upload the dataset for review, approve its fields, then publish it.');
  }

  const [allTowns, allIndicators] = await Promise.all([towns.list(), indicators.list()]);
  const sourceRows = await readDatasetRecords(file, { filename, worksheet });
  const preparedDataset = prepareTabularDataset(sourceRows, { towns: allTowns, indicators: allIndicators });
  if (preparedDataset.problemCount > 0) {
    const noun = preparedDataset.problemCount === 1 ? 'problem' : 'problems';
    const message = `Upload rejected: ${preparedDataset.problemCount} ${noun} found. Nothing was saved.`;
    throw new HttpError(422, message, preparedDataset.problems);
  }

  return withTransaction(async (client) => {
    await datasets.lockNameVintage(name, vintage, client);
    const version = await datasets.nextVersion(name, vintage, client);
    const sourceId = await sources.findOrCreate(source, client);
    const datasetDetails = {
      name,
      sourceId,
      vintage,
      version,
      rowCount: preparedDataset.rowCount,
      uploadedBy: user.id,
      dataFormat: preparedDataset.dataFormat,
      columns: preparedDataset.columns,
      notes: preparedDataset.notes,
    };
    const { id: datasetId } = await datasets.insert(datasetDetails, client);
    await observations.insertMany(datasetId, preparedDataset.observations, client);
    await records.insertMany(datasetId, preparedDataset.rows, client);
    return datasets.findById(datasetId, client);
  });
}

export async function getReportOptions(datasetId, user) {
  const dataset = await datasets.findById(datasetId);
  if (!dataset || (!dataset.is_active && user.role !== 'admin')) {
    throw new HttpError(404, 'Dataset not found');
  }

  const fields = await availableFields(dataset);
  const approvedFields = applyFieldPresentation(approvedDefinitions(fields, dataset.approved_fields), dataset.presentation);
  const sharedOptions = {
    dataFormat: dataset.data_format ?? 'indicators',
    defaultChartType: dataset.presentation?.defaultChartType || 'grouped_bar',
    curationReviewed: Boolean(dataset.curation_reviewed_at),
    columns: addDisplayLabels(approvedFields),
  };

  if (dataset.data_format !== 'records') {
    const places = await observations.previewPlaces(datasetId, { offset: 0, limit: 10000 });
    return {
      ...sharedOptions,
      filters: [],
      repeatedRows: false,
      hasState: places.some((place) => place.geo_type === 'state'),
      places: places.map(presentPlace),
    };
  }

  const sourceRows = await records.list(datasetId);
  const placesById = new Map();
  for (const row of sourceRows) {
    placesById.set(row.town_id, {
      id: row.town_id,
      name: row.name,
      geo_type: row.geo_type,
    });
  }

  const repeatedRows = placesById.size < sourceRows.length;
  const places = [...placesById.values()];
  places.sort((firstPlace, secondPlace) => firstPlace.name.localeCompare(secondPlace.name));

  return {
    ...sharedOptions,
    hasState: sourceRows.some((row) => row.geo_type === 'state'),
    repeatedRows,
    places: places.map(presentPlace),
    filters: repeatedRows ? buildCategoryFilters(approvedFields, sourceRows) : [],
  };
}

function buildCategoryFilters(fields, sourceRows) {
  const filters = [];
  for (const field of fields) {
    if (field.type !== 'text') {
      continue;
    }

    const distinctValues = new Set();
    for (const row of sourceRows) {
      const value = row.cell_values[field.key];
      if (value != null) {
        distinctValues.add(value);
      }
    }
    if (distinctValues.size <= 250) {
      filters.push({
        key: field.key,
        label: field.label,
        values: [...distinctValues].sort(),
      });
    }
  }
  return filters;
}

/** Versions are deactivated rather than deleted, so saved reports keep working. */
export async function setDatasetActive(datasetId, isActive) {
  return withTransaction(async (client) => {
    await client.lock(`dataset-curation:${datasetId}`);
    const dataset = await datasets.findById(datasetId, client);
    if (!dataset) {
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
  const dataset = await datasets.findById(datasetId, database);
  if (!dataset || (!dataset.is_active && user.role !== 'admin')) {
    throw new HttpError(404, 'Dataset not found');
  }
  const fields = await availableFields(dataset, database);
  return { dataset, fields: user.role === 'admin' ? fields : approvedDefinitions(fields, dataset.approved_fields) };
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
