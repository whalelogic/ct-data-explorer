/**
 * Report building and the saved report library (SRS US005–US008).
 *
 * buildReport() turns a validated selection into render-ready report data. That one
 * object is returned as JSON for the live preview and handed to the PDF renderer,
 * so both always show the same figures.
 */
import { HttpError } from '../lib/http-error.js';
import { formatValue } from '../shared/format.js';
import * as reports from '../repositories/reports.js';
import * as datasets from '../repositories/datasets.js';
import * as indicators from '../repositories/indicators.js';
import * as observations from '../repositories/observations.js';
import * as towns from '../repositories/towns.js';
import { computeValue } from './compute.js';
import { parseMarkup } from './markup.js';
import { presentDataset, presentIndicator, presentPlace } from './presenters.js';
import { selectionSchema } from './selection.js';
import { buildRecordReport } from './record-reports.js';
import { datasetIndicators, requireApprovedSelection } from './field-curation.js';
import { applyFieldPresentation, appendFieldNotes } from './presentation.js';
import { buildChartBlocks } from './report-charts.js';

const TIME_ZONE = 'America/New_York';

/**
 * @param {import('zod').infer<typeof selectionSchema>} selection already validated
 * @param {{ now?: Date }} [options]
 */
export async function buildReport(selection, { now = new Date() } = {}) {
  const dataset = await requireActiveDataset(selection.dataset);
  const places = await resolvePlaces(selection);
  if (dataset.data_format === 'records') {
    return buildRecordReport(selection, dataset, places, now);
  }
  const selectedIndicators = await resolveIndicators(selection, dataset);
  const placeIds = places.map((place) => place.id);
  const valuesByPlace = await observations.valuesByTown(dataset.id, placeIds);
  const rows = buildIndicatorRows(selectedIndicators, places, valuesByPlace);

  const placeSummaries = places.map(presentPlace);
  const generatedOn = now.toLocaleDateString('en-CA', { timeZone: TIME_ZONE }); // YYYY-MM-DD
  const datasetSummary = presentDataset(dataset);
  const blocks = [];
  for (const layoutBlock of selection.layout) {
    blocks.push(...buildBlocks(layoutBlock, rows, placeSummaries));
  }

  appendFieldNotes(blocks, rows);

  return {
    title: selection.title || defaultTitle(placeSummaries),
    subtitle: selection.subtitle || `${dataset.presentation?.displayName || dataset.name}, ${dataset.vintage}`,
    showTitle: selection.showTitle,
    dataset: datasetSummary,
    places: placeSummaries,
    indicators: rows,
    blocks,
    generatedOn,
    sourceLine:
      `Source: ${dataset.source}. Dataset: ${dataset.name}, ${dataset.vintage} (version ${dataset.version}). ` +
      `Generated ${generatedOn} with CT Civic Data Explorer.`,
  };
}

function buildIndicatorRows(selectedIndicators, places, valuesByPlace) {
  const rows = [];
  for (const indicator of selectedIndicators) {
    const cells = [];
    for (const place of places) {
      const value = computeValue(indicator, valuesByPlace.get(place.id));
      cells.push({ value, display: formatValue(value, indicator) });
    }
    rows.push({ ...presentIndicator(indicator), cells });
  }
  return rows;
}

/** Parse a stored selection with the current schema, so older saved reports pick up new defaults. */
export function parseStoredSelection(storedSelection) {
  const parsedSelection = selectionSchema.safeParse(storedSelection);
  if (!parsedSelection.success) {
    throw new HttpError(422, `This saved report can no longer be built: ${parsedSelection.error.issues[0]?.message}`);
  }
  return parsedSelection.data;
}

export function listReports(query) {
  return reports.list(query);
}

export async function getReport(id) {
  const report = await reports.findById(id);
  if (!report) {
    throw new HttpError(404, 'Report not found');
  }
  return report;
}

export async function createReport({ title, selection }, user) {
  const builtReport = await buildReport(selection);
  const id = await reports.insert({
    title,
    selection,
    createdBy: user.id,
    datasetId: builtReport.dataset.id,
  });
  return reports.findById(id);
}

export async function updateReport(id, { title, selection }, user) {
  const report = await getOwnedReport(id, user);
  const nextSelection = selection ?? parseStoredSelection(report.selection);
  const builtReport = await buildReport(nextSelection);
  await reports.update(id, {
    title: title ?? report.title,
    selection: nextSelection,
    datasetId: builtReport.dataset.id,
  });
  return reports.findById(id);
}

/** Any signed-in user may duplicate a report; the copy belongs to them. */
export async function duplicateReport(id, user) {
  const report = await getReport(id);
  const selection = parseStoredSelection(report.selection);
  const builtReport = await buildReport(selection);
  const title = `${report.title} (copy)`.slice(0, 200);
  const copyId = await reports.insert({
    title,
    selection,
    createdBy: user.id,
    datasetId: builtReport.dataset.id,
  });
  return reports.findById(copyId);
}

export async function deleteReport(id, user) {
  await getOwnedReport(id, user);
  await reports.remove(id);
}

async function getOwnedReport(id, user) {
  const report = await getReport(id);
  if (report.created_by !== user.id) {
    throw new HttpError(403, 'Only the person who created this report can change it');
  }
  return report;
}

async function requireActiveDataset({ name, vintage }) {
  const dataset = await datasets.findActive(name, vintage);
  if (!dataset) {
    throw new HttpError(404, `No active version of "${name}" (${vintage}) is available`);
  }
  return dataset;
}

async function resolvePlaces(selection) {
  const matchingPlaces = await towns.findByNames(selection.towns);
  const townsByName = new Map();
  const matchingNames = new Set();
  for (const place of matchingPlaces) {
    const lowerCaseName = place.name.toLowerCase();
    matchingNames.add(lowerCaseName);
    if (place.geo_type === 'town') {
      townsByName.set(lowerCaseName, place);
    }
  }

  const places = [];
  for (const name of selection.towns) {
    const lowerCaseName = name.toLowerCase();
    const town = townsByName.get(lowerCaseName);
    if (town) {
      places.push(town);
      continue;
    }
    if (matchingNames.has(lowerCaseName)) {
      throw new HttpError(400, `${name} is the statewide row; use the statewide benchmark option instead`);
    }
    throw new HttpError(400, `"${name}" does not match any Connecticut town`);
  }
  if (selection.benchmark) {
    const state = await towns.findState();
    if (state) {
      places.push(state);
    }
  }
  return places;
}

async function resolveIndicators(selection, dataset) {
  const [definitions, indicatorKeys] = await Promise.all([
    indicators.list(),
    observations.indicatorKeys(dataset.id),
  ]);
  const availableIndicators = datasetIndicators(definitions, indicatorKeys);
  requireApprovedSelection(selection, availableIndicators, dataset.approved_fields);

  const indicatorsByKey = new Map();
  for (const indicator of availableIndicators) {
    indicatorsByKey.set(indicator.key, indicator);
  }
  const selectedIndicators = [];
  for (const key of selection.indicators) {
    const indicator = indicatorsByKey.get(key);
    if (!indicator) {
      throw new HttpError(400, `Unknown indicator "${key}"`);
    }
    selectedIndicators.push(indicator);
  }
  return applyFieldPresentation(selectedIndicators, { fields: dataset.presentation?.fields }, selection.fieldOverrides);
}

/**
 * A chart layout block can expand into several charts to include all its measures.
 * Text is parsed once so the preview and PDF draw the same structure.
 */
function buildBlocks(block, rows, places) {
  switch (block.type) {
    case 'text': {
      const nodes = parseMarkup(block.text);
      return nodes.length > 0 ? [{ type: 'text', nodes }] : [];
    }
    case 'chart':
      return buildChartBlocks(block, rows, places);
    case 'table':
      return [{
        type: 'table',
        indicators: block.indicators.length > 0
          ? rows.filter((row) => block.indicators.includes(row.key))
          : rows,
      }];
    default:
      throw new Error(`Unknown block type ${block.type}`);
  }
}

function defaultTitle(places) {
  const names = [];
  for (const place of places) {
    if (place.geoType === 'town') {
      names.push(place.name);
    }
  }
  if (names.length <= 1) {
    return names[0] ?? 'Connecticut';
  }
  if (names.length > 3) {
    return `${names.length} Connecticut towns`;
  }
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
