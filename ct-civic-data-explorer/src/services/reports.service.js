/**
 * Report building and the saved report library (SRS US005–US008).
 *
 * buildReport() turns a validated selection into render-ready report data. That one
 * object is returned as JSON for the live preview and handed to the PDF renderer,
 * so both always show the same figures.
 */
import { resolveReportStyle } from '../shared/report-style.js';
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
import { approvedDefinitions, datasetIndicators, requireApprovedSelection } from './field-curation.js';
import { applyFieldPresentation, appendFieldNotes } from './presentation.js';
import { buildChartBlocks } from './report-charts.js';
import {
  buildCustomFields, computeSummaries, customIndicatorKeys, isSummaryIndicator, withoutCustomIndicators, withoutSummaryIndicators,
} from './custom-indicators.js';
import { createSlug } from './slugs.js';
import { PLACE_GROUPS, benchmarkWording, describePlaces } from './row-labels.js';

const TIME_ZONE = 'America/New_York';

/**
 * @param {import('zod').infer<typeof selectionSchema>} selection already validated
 * @param {{ now?: Date }} [options]
 */
export async function buildReport(fullSelection, { now = new Date() } = {}) {
  const dataset = await requireActiveDataset(fullSelection.dataset);
  if (dataset.data_format === 'records') {
    return buildRecordReport(fullSelection, dataset, now);
  }
  // Summary fields (e.g. average per town) are one value for the report, not a column.
  const selection = withoutSummaryIndicators(fullSelection);
  const places = await resolveTownPlaces(selection, dataset);
  const { selectedIndicators, approvedIndicators } = await resolveIndicators(selection, dataset);
  const placeIds = places.map((place) => place.id);
  const valuesByPlace = await observations.valuesByTown(dataset.id, placeIds);
  const rows = buildIndicatorRows(selectedIndicators, places, valuesByPlace);

  const placeSummaries = places.map(presentPlace);
  const comparedPlaces = places.filter((place) => place.geo_type !== 'state');
  const benchmark = await loadPlaceBenchmark(fullSelection, dataset, comparedPlaces, valuesByPlace);
  const summaries = computeSummaries(
    fullSelection,
    applyFieldPresentation(approvedIndicators, { fields: dataset.presentation?.fields }),
    comparedPlaces,
    {
      readValue: (place, field) => computeValue(field, valuesByPlace.get(place.id)),
      nameOf: (place) => place.name,
      rowNoun: placeNoun(comparedPlaces),
    },
    benchmark,
  );
  const generatedOn = now.toLocaleDateString('en-CA', { timeZone: TIME_ZONE }); // YYYY-MM-DD
  const datasetSummary = presentDataset(dataset);
  const blocks = [];
  for (const layoutBlock of selection.layout) {
    // A report of summaries only has no per-row fields to chart or tabulate.
    if (rows.length > 0 || layoutBlock.type === 'text') {
      blocks.push(...buildBlocks(layoutBlock, rows, placeSummaries));
    }
  }

  appendFieldNotes(blocks, rows);

  return {
    style: resolveReportStyle(dataset.presentation?.style, selection.styleOverrides),
    rowNoun: 'Town',
    title: selection.title || describePlaces(placeSummaries, selection.allRows),
    subtitle: selection.subtitle || `${dataset.presentation?.displayName || dataset.name}, ${dataset.vintage}`,
    showTitle: selection.showTitle,
    dataset: datasetSummary,
    places: placeSummaries,
    indicators: rows,
    summaries,
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
    slug: await uniqueSlug(title),
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
  const nextTitle = title ?? report.title;
  await reports.update(id, {
    title: nextTitle,
    // The address follows the name; an unchanged name keeps its address.
    slug: nextTitle === report.title && report.slug ? report.slug : await uniqueSlug(nextTitle, id),
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
    slug: await uniqueSlug(title),
    selection,
    createdBy: user.id,
    datasetId: builtReport.dataset.id,
  });
  return reports.findById(copyId);
}

/** A saved report with its current figures, for the interactive viewer at /explore/<slug>.html. */
export async function getReportView(slug) {
  const report = await reports.findBySlug(slug);
  if (!report) {
    throw new HttpError(404, 'Report not found');
  }
  const data = await buildReport(parseStoredSelection(report.selection));
  return { report, data };
}

/** Readable and unique: "Hartford housing", then "Hartford housing 2", and so on. */
async function uniqueSlug(title, excludeId = null) {
  const base = createSlug(title);
  for (let attempt = 1; attempt <= 50; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!(await reports.slugTaken(candidate, excludeId))) {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
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

/**
 * Places named in the selection (or every town, county and planning region in the
 * dataset), then the statewide figure when requested. Shared by indicator datasets and town-keyed source-row datasets.
 */
export async function resolveTownPlaces(selection, dataset) {
  let places;
  if (selection.allRows) {
    const datasetPlaces = await observations.previewPlaces(dataset.id, { offset: 0, limit: 10000 });
    places = datasetPlaces.filter((place) => place.geo_type !== 'state');
  } else {
    places = await findNamedTowns(selection.rows);
  }
  if (selection.benchmark) {
    const state = await towns.findState();
    if (state) {
      places.push(state);
    }
  }
  return places;
}

async function findNamedTowns(names) {
  const matchingPlaces = await towns.findByNames(names);
  const townsByName = new Map();
  const matchingNames = new Set();
  for (const place of matchingPlaces) {
    const lowerCaseName = place.name.toLowerCase();
    matchingNames.add(lowerCaseName);
    if (place.geo_type !== 'state') {
      townsByName.set(lowerCaseName, place);
    }
  }

  const places = [];
  for (const name of names) {
    const lowerCaseName = name.toLowerCase();
    const town = townsByName.get(lowerCaseName);
    if (town) {
      places.push(town);
      continue;
    }
    if (matchingNames.has(lowerCaseName)) {
      throw new HttpError(400, `${name} is the statewide row; use the statewide option instead`);
    }
    throw new HttpError(400, `"${name}" does not match any Connecticut town, county or planning region`);
  }
  return places;
}

async function resolveIndicators(selection, dataset) {
  const [definitions, indicatorKeys] = await Promise.all([
    indicators.list(),
    observations.indicatorKeys(dataset.id),
  ]);
  const availableIndicators = datasetIndicators(definitions, indicatorKeys);
  requireApprovedSelection(withoutCustomIndicators(selection), availableIndicators, dataset.approved_fields);
  const approvedIndicators = approvedDefinitions(availableIndicators, dataset.approved_fields);
  const customFields = buildCustomFields(selection, approvedIndicators);

  const indicatorsByKey = new Map();
  for (const indicator of availableIndicators) {
    indicatorsByKey.set(indicator.key, indicator);
  }
  for (const customField of customFields) {
    indicatorsByKey.set(customField.key, customField);
  }
  const customKeys = customIndicatorKeys(selection);
  const selectedIndicators = [];
  for (const key of selection.indicators) {
    if (customKeys.has(key) && !indicatorsByKey.has(key)) {
      throw new HttpError(400, `Custom indicator "${key}" is not defined`);
    }
    const indicator = indicatorsByKey.get(key);
    if (!indicator) {
      throw new HttpError(400, `Unknown indicator "${key}"`);
    }
    selectedIndicators.push(indicator);
  }
  return {
    selectedIndicators: applyFieldPresentation(selectedIndicators, { fields: dataset.presentation?.fields }, selection.fieldOverrides),
    approvedIndicators,
  };
}

/**
 * Every place in the dataset of the same kind as those compared (all towns, or all counties),
 * for summary benchmarks. Their values are added to valuesByPlace. null when no summary
 * asks for one.
 */
async function loadPlaceBenchmark(selection, dataset, comparedPlaces, valuesByPlace) {
  const wanted = (selection.customIndicators ?? []).some((custom) => isSummaryIndicator(custom)
    && custom.benchmark !== false && selection.indicators.includes(custom.key));
  if (!wanted || comparedPlaces.length === 0) {
    return null;
  }
  const types = new Set(comparedPlaces.map((place) => place.geo_type));
  const allPlaces = (await observations.previewPlaces(dataset.id, { offset: 0, limit: 10000 }))
    .filter((place) => types.has(place.geo_type));
  const missing = allPlaces.map((place) => place.id).filter((id) => !valuesByPlace.has(id));
  for (const [id, values] of await observations.valuesByTown(dataset.id, missing)) {
    valuesByPlace.set(id, values);
  }
  return { rows: allPlaces, ...benchmarkWording(allPlaces.length, placeNoun(allPlaces), true) };
}

/** "town" when every compared place is a town (or every one a county…), otherwise "place". */
function placeNoun(places) {
  const types = new Set(places.map((place) => place.geo_type));
  return types.size === 1 ? PLACE_GROUPS[[...types][0]]?.noun ?? 'place' : 'place';
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

