/** Dataset upload and versioning (SRS US003). */
import { withTransaction } from '../db/pool.js';
import { HttpError } from '../lib/http-error.js';
import * as datasets from '../repositories/datasets.js';
import * as indicators from '../repositories/indicators.js';
import * as observations from '../repositories/observations.js';
import * as sources from '../repositories/sources.js';
import * as towns from '../repositories/towns.js';
import { readDatasetRecords } from './dataset-file.js';
import * as records from '../repositories/dataset-records.js';
import { prepareTabularDataset, formatDatasetCell } from './tabular-data.js';
import { computeValue } from './compute.js';
import { formatValue } from '../shared/format.js';
import { presentDataset, presentIndicator, presentPlace } from './presenters.js';

export function listDatasets({ activeOnly }) {
  return datasets.list({ activeOnly });
}

/** Dataset details and a bounded preview use this specific version, even when archived. */
export async function getDatasetOverview(id, { offset = 0, limit = 25 }, user) {
  const dataset = await datasets.findById(id);
  if (!dataset || (!dataset.is_active && user.role !== 'admin')) throw new HttpError(404, 'Dataset not found');
  if (dataset.data_format === 'records') {
    const columns = dataset.column_definitions;
    const rows = await records.list(id, { offset, limit });
    return { dataset: presentDataset(dataset), indicators: columns.filter((column) => column.role !== 'town'),
      preview: { offset, limit, total: dataset.row_count, columns,
        rows: rows.map((row) => ({ sourceRow: row.source_row,
          cells: columns.map((column) => ({ value: row.cell_values[column.key], display: formatDatasetCell(row.cell_values[column.key], column) })) })) } };
  }
  const [definitions, keys, places, total] = await Promise.all([
    indicators.list(), observations.indicatorKeys(id),
    observations.previewPlaces(id, { offset, limit }), observations.countPlaces(id),
  ]);
  const available = datasetIndicators(definitions, keys);
  const raw = await observations.valuesByTown(id, places.map((place) => place.id));
  return {
    dataset: presentDataset(dataset),
    indicators: available.map(presentIndicator),
    preview: {
      offset, limit, total,
      rows: places.map((place) => ({
        place: presentPlace(place),
        cells: available.map((indicator) => {
          const value = computeValue(indicator, raw.get(place.id));
          return { value, display: formatValue(value, indicator) };
        }),
      })),
    },
  };
}

export function datasetIndicators(definitions, keys) {
  const stored = new Set(keys);
  return definitions.filter((indicator) => indicator.derivation === 'direct'
    ? stored.has(indicator.key)
    : stored.has(indicator.numerator_key) && stored.has(indicator.denominator_key));
}

/**
 * Validate and store a CSV or workbook as a new version of name + vintage. A file with any
 * problem is rejected whole; nothing is written.
 */
export async function uploadDataset({ file, filename, worksheet, name, source, vintage, activate }, user) {
  const [allTowns, allIndicators] = await Promise.all([towns.list(), indicators.list()]);
  const checked = prepareTabularDataset(await readDatasetRecords(file, { filename, worksheet }), { towns: allTowns, indicators: allIndicators });
  if (checked.problemCount > 0) {
    const noun = checked.problemCount === 1 ? 'problem' : 'problems';
    throw new HttpError(422, `Upload rejected: ${checked.problemCount} ${noun} found. Nothing was saved.`, checked.problems);
  }

  return withTransaction(async (client) => {
    await datasets.lockNameVintage(name, vintage, client);
    const version = await datasets.nextVersion(name, vintage, client);
    const sourceId = await sources.findOrCreate(source, client);
    const { id } = await datasets.insert(
      { name, sourceId, vintage, version, rowCount: checked.rowCount, uploadedBy: user.id,
        dataFormat: checked.dataFormat, columns: checked.columns, notes: checked.notes },
      client,
    );
    await observations.insertMany(id, checked.observations, client);
    await records.insertMany(id, checked.rows, client);
    if (activate) await datasets.setActive(id, true, client);
    return datasets.findById(id, client);
  });
}

export async function getReportOptions(id, user) {
  const dataset = await datasets.findById(id);
  if (!dataset || (!dataset.is_active && user.role !== 'admin')) throw new HttpError(404, 'Dataset not found');
  if (dataset.data_format !== 'records') return { columns: [], filters: [] };
  const rows = await records.list(id);
  const repeated = new Set(rows.map((row) => row.town_id)).size < rows.length;
  const columns = dataset.column_definitions.filter((column) => column.role !== 'town');
  return { hasState: rows.some((row) => row.geo_type === 'state'), columns: columns.map((column) => ({ ...column, displayLabel: column.label })),
    filters: repeated ? columns.filter((column) => column.type === 'text').map((column) => ({
      key: column.key, label: column.label,
      values: [...new Set(rows.map((row) => row.cell_values[column.key]).filter((value) => value != null))].sort(),
    })).filter((filter) => filter.values.length <= 250) : [] };
}

/** Versions are deactivated rather than deleted, so saved cards keep working. */
export async function setDatasetActive(id, isActive) {
  return withTransaction(async (client) => {
    if (!(await datasets.setActive(id, isActive, client))) throw new HttpError(404, 'Dataset not found');
    return datasets.findById(id, client);
  });
}
