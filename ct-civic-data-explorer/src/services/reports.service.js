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

const TIME_ZONE = 'America/New_York';

/**
 * @param {import('zod').infer<typeof selectionSchema>} selection already validated
 * @param {{ now?: Date }} [options]
 */
export async function buildReport(selection, { now = new Date() } = {}) {
  const dataset = await requireActiveDataset(selection.dataset);
  const places = await resolvePlaces(selection);
  if (dataset.data_format === 'records') return buildRecordReport(selection, dataset, places, now);
  const ordered = await resolveIndicators(selection.indicators);

  const raw = await observations.valuesByTown(dataset.id, places.map((p) => p.id));
  const rows = ordered.map((indicator) => ({
    ...presentIndicator(indicator),
    cells: places.map((place) => {
      const value = computeValue(indicator, raw.get(place.id));
      return { value, display: formatValue(value, indicator) };
    }),
  }));

  const placeSummaries = places.map(presentPlace);
  const generatedOn = now.toLocaleDateString('en-CA', { timeZone: TIME_ZONE }); // YYYY-MM-DD
  const summary = presentDataset(dataset);

  return {
    title: selection.title || defaultTitle(placeSummaries),
    subtitle: selection.subtitle || `${dataset.name}, ${dataset.vintage}`,
    showTitle: selection.showTitle,
    dataset: summary,
    places: placeSummaries,
    indicators: rows,
    blocks: selection.layout.map((block, i) => buildBlock(block, i, rows, placeSummaries)).filter(Boolean),
    generatedOn,
    sourceLine:
      `Source: ${dataset.source}. Dataset: ${dataset.name}, ${dataset.vintage} (version ${dataset.version}). ` +
      `Generated ${generatedOn} with CT Civic Data Explorer.`,
  };
}

/** Parse a stored selection with the current schema, so older saved reports pick up new defaults. */
export function parseStoredSelection(stored) {
  const parsed = selectionSchema.safeParse(stored);
  if (!parsed.success) {
    throw new HttpError(422, `This saved report can no longer be built: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

export function listReports(query) {
  return reports.list(query);
}

export async function getReport(id) {
  const report = await reports.findById(id);
  if (!report) throw new HttpError(404, 'Report not found');
  return report;
}

export async function createReport({ title, selection }, user) {
  const dataset = await requireActiveDataset(selection.dataset);
  const id = await reports.insert({ title, selection, createdBy: user.id, datasetId: dataset.id });
  return reports.findById(id);
}

export async function updateReport(id, { title, selection }, user) {
  const report = await getOwnedReport(id, user);
  const datasetId = selection ? (await requireActiveDataset(selection.dataset)).id : report.dataset_id;
  await reports.update(id, { title: title ?? report.title, selection: selection ?? report.selection, datasetId });
  return reports.findById(id);
}

/** Any signed-in user may duplicate a report; the copy belongs to them. */
export async function duplicateReport(id, user) {
  const report = await getReport(id);
  const title = `${report.title} (copy)`.slice(0, 200);
  const copyId = await reports.insert({ title, selection: report.selection, createdBy: user.id, datasetId: report.dataset_id });
  return reports.findById(copyId);
}

export async function deleteReport(id, user) {
  await getOwnedReport(id, user);
  await reports.remove(id);
}

async function getOwnedReport(id, user) {
  const report = await getReport(id);
  if (report.created_by !== user.id) throw new HttpError(403, 'Only the person who created this report can change it');
  return report;
}

async function requireActiveDataset({ name, vintage }) {
  const dataset = await datasets.findActive(name, vintage);
  if (!dataset) throw new HttpError(404, `No active version of "${name}" (${vintage}) is available`);
  return dataset;
}

async function resolvePlaces(selection) {
  const found = await towns.findByNames(selection.towns);
  const byName = new Map(found.filter((t) => t.geo_type === 'town').map((t) => [t.name.toLowerCase(), t]));
  const places = selection.towns.map((name) => {
    const town = byName.get(name.toLowerCase());
    if (town) return town;
    if (found.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(400, `${name} is the statewide row; use the statewide benchmark option instead`);
    }
    throw new HttpError(400, `"${name}" does not match any Connecticut town`);
  });
  if (selection.benchmark) {
    const state = await towns.findState();
    if (state) places.push(state);
  }
  return places;
}

async function resolveIndicators(keys) {
  const found = new Map((await indicators.findByKeys(keys)).map((i) => [i.key, i]));
  return keys.map((key) => {
    const indicator = found.get(key);
    if (!indicator) throw new HttpError(400, `Unknown indicator "${key}"`);
    return indicator;
  });
}

/**
 * One layout block as render-ready data. Text is parsed into a node tree here, so the
 * preview and the PDF draw the same structure. Empty text blocks are dropped.
 */
function buildBlock(block, index, rows, places) {
  switch (block.type) {
    case 'text': {
      const nodes = parseMarkup(block.text);
      return nodes.length > 0 ? { type: 'text', nodes } : null;
    }
    case 'chart':
      return { type: 'chart', chart: buildChart(block, index, rows, places) };
    case 'table':
      return {
        type: 'table',
        indicators: block.indicators.length > 0 ? rows.filter((r) => block.indicators.includes(r.key)) : rows,
      };
    default:
      throw new Error(`Unknown block type ${block.type}`);
  }
}

/**
 * Chart data in one shape for both Chart.js and pdfkit: one label per place and one
 * series per charted indicator. A single chart has a single unit, so mixed units are refused.
 */
function buildChart(block, index, rows, places) {
  let series = block.indicators.length > 0
    ? rows.filter((r) => block.indicators.includes(r.key))
    : rows.filter((r) => r.unit === rows[0].unit);
  if (block.chartType === 'bar') series = series.slice(0, 1);

  const units = new Set(series.map((s) => s.unit));
  if (units.size > 1) {
    const listed = series.map((s) => `${s.label} (${s.unit})`).join(', ');
    throw new HttpError(400, `Chart ${blockLabel(index)}: charted indicators must share a unit. Chart fewer of these: ${listed}`);
  }

  return {
    type: block.chartType,
    unit: series[0].unit,
    decimals: Math.max(...series.map((s) => s.decimals)),
    labels: places.map((p) => p.label),
    benchmarkIndex: places.findIndex((p) => p.geoType === 'state'),
    series: series.map((s) => ({ key: s.key, label: s.label, values: s.cells.map((c) => c.value) })),
  };
}

/** Which block the user should look at, e.g. "(block 3)", since a report can hold several charts. */
function blockLabel(index) {
  return `(block ${index + 1})`;
}

function defaultTitle(places) {
  const names = places.filter((p) => p.geoType === 'town').map((p) => p.name);
  if (names.length <= 1) return names[0] ?? 'Connecticut';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
