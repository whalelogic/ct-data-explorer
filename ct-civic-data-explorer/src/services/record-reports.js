/**
 * Reports over source rows. Every row stays separate, including repeated totals; nothing
 * is summed. Rows are labeled by the dataset's row label column: a matched town, or the
 * value of another column such as an industry or program.
 */
import { resolveReportStyle } from '../shared/report-style.js';
import { formatValue } from '../shared/format.js';
import { HttpError } from '../lib/http-error.js';
import * as datasetRecords from '../repositories/dataset-records.js';
import * as towns from '../repositories/towns.js';
import { parseMarkup } from './markup.js';
import { presentDataset } from './presenters.js';
import { formatDatasetCell } from './tabular-data.js';
import { approvedDefinitions, isRowIdentity, requireApprovedSelection } from './field-curation.js';
import { applyFieldPresentation, appendFieldNotes } from './presentation.js';
import { buildChartBlocks } from './report-charts.js';
import {
  buildCustomFields, computeRatio, computeSummaries, customIndicatorKeys, isSummaryIndicator, withoutCustomIndicators,
  withoutSummaryIndicators,
} from './custom-indicators.js';
import { PLACE_GROUPS, benchmarkWording, describePlaces, recordRowName, reportGeography, reportRowLabel } from './row-labels.js';

export async function buildRecordReport(selection, dataset, now, { includeUploadDetails = true } = {}) {
  const presented = presentDataset(dataset, { includeUploadDetails });
  const sourceRows = await loadSelectedRows(selection, dataset, presented);
  // Summary benchmarks also read the dataset's other comparable rows.
  const wantsBenchmark = (selection.customIndicators ?? []).some((custom) => isSummaryIndicator(custom)
    && custom.benchmark !== false && selection.indicators.includes(custom.key));
  const datasetRows = wantsBenchmark && !selection.allRows ? await datasetRecords.list(dataset.id) : null;
  return renderRecordReport(selection, presented, sourceRows, now, { datasetRows });
}

/** Use the place catalog only when the selected field is linked to Connecticut geography. */
async function loadSelectedRows(selection, dataset, presented) {
  const { labelColumn, townKeyed } = reportRowLabel(presented, selection.compareBy);
  if (townKeyed) {
    const geography = reportGeography(selection.compareBy);
    if (selection.allRows) {
      const allRows = await datasetRecords.list(dataset.id);
      return allRows.filter(({ geo_type: type }) => type === 'state' ? selection.benchmark : !geography || type === geography);
    }
    const places = await towns.findByNames(selection.rows);
    const eligible = places.filter(({ geo_type: type }) => type !== 'state' && (!geography || type === geography));
    const townIds = eligible.map((place) => place.id);
    if (selection.benchmark) {
      const state = await towns.findState();
      if (state) {
        townIds.push(state.id);
      }
    }
    const sourceRows = await datasetRecords.list(dataset.id, { townIds });
    if (geography) {
      const names = new Set(sourceRows.filter((row) => row.geo_type === geography).map((row) => row.town_name.toLowerCase()));
      const unavailable = selection.rows.find((name) => !names.has(name.toLowerCase()));
      if (unavailable) throw new HttpError(400, `Choose a ${PLACE_GROUPS[geography].noun} in this dataset. “${unavailable}” is unavailable.`);
    }
    return sourceRows;
  }

  const allRows = await datasetRecords.list(dataset.id);
  if (selection.allRows) {
    return allRows;
  }
  const labels = allRows.map((row) => recordRowName(row, labelColumn, false));
  const exact = new Set(labels);
  const folded = new Map();
  for (const label of exact) {
    const lower = label.toLowerCase();
    folded.set(lower, folded.has(lower) ? null : label);
  }
  // Older requests were case-insensitive. An exact match takes priority when codes differ only by case.
  const wanted = new Set();
  const missing = [];
  for (const name of selection.rows) {
    const match = exact.has(name) ? name : folded.get(name.toLowerCase());
    if (match) wanted.add(match);
    else missing.push(name);
  }
  if (missing.length) {
    const field = labelColumn?.label ?? 'row';
    const names = missing.slice(0, 3).map((name) => `“${name}”`).join(', ');
    const more = missing.length > 3 ? ` and ${missing.length - 3} more` : '';
    throw new HttpError(400, `Choose available ${field} values. ${names}${more} ${missing.length === 1 ? 'is' : 'are'} unavailable in this dataset.`);
  }
  return allRows.filter((_, index) => wanted.has(labels[index]));
}

/**
 * @param {{ datasetRows?: object[] | null }} [options] every row of the dataset, for summary
 *   benchmarks; without it summaries show the report's figure only
 */
export function renderRecordReport(fullSelection, dataset, sourceRows, now = new Date(), { datasetRows = null } = {}) {
  // Summary fields provide one value for the whole report.
  const selection = withoutSummaryIndicators(fullSelection);
  const fieldSelection = withoutCustomIndicators(selection);
  const columns = applyFieldPresentation(
    approvedDefinitions(dataset.columns, dataset.approvedFields, { includeTown: true }),
    {},
    fieldSelection.fieldOverrides,
  );
  const chosen = reportRowLabel(dataset, selection.compareBy);
  const townKeyed = chosen.townKeyed;
  // Use the presented column so report-specific names apply to the row heading too.
  const labelColumn = columns.find((column) => column.key === chosen.labelColumn?.key) ?? chosen.labelColumn;
  const dataColumns = columns.filter((column) => !isRowIdentity(column));
  requireApprovedSelection(fieldSelection, dataColumns, dataset.approvedFields);

  const customFields = applyFieldPresentation(buildCustomFields(selection, dataColumns), {}, selection.fieldOverrides);
  const selectedColumns = findSelectedColumns(selection, dataColumns, customFields);
  const filteredRecords = filterRecords(sourceRows, selection.recordFilters ?? {}, columns);
  const primaryDimension = columns.find((column) => column.role === 'dimension' && column.key !== labelColumn?.key);
  const sourceIdentity = columns.find((column) => isRowIdentity(column) && column.key !== labelColumn?.key);
  const { places, hasRepeatedRows } = buildRecordPlaces(filteredRecords, primaryDimension ?? sourceIdentity, labelColumn, townKeyed);
  const indicatorRows = buildIndicatorRows(selectedColumns, filteredRecords);
  const comparedRecords = townKeyed ? filteredRecords.filter((record) => record.geo_type !== 'state') : filteredRecords;
  const summaryNoun = summaryRowNoun(comparedRecords, townKeyed, hasRepeatedRows);
  const placeLabels = new Map(places.map(({ id, label }) => [id, label]));
  const summaries = computeSummaries(
    fullSelection,
    dataColumns,
    comparedRecords,
    {
      readValue: (record, field) => (field.type === 'number' ? numericCell(record, field) : record.cell_values[field.key]),
      // The report's own row labels, which tell repeated rows apart ("Food pantry — North").
      nameOf: (record) => placeLabels.get(record.id) ?? recordRowName(record, labelColumn, townKeyed),
      rowNoun: summaryNoun,
    },
    recordBenchmark(datasetRows, comparedRecords, { townKeyed, labelColumn, columns, filters: selection.recordFilters ?? {} }),
  );
  const tableData = {
    selectedColumns,
    primaryDimension,
    labelColumn,
    townKeyed,
    sourceIdentity,
    hasRepeatedRows,
    records: filteredRecords,
  };

  const blocks = [];
  let hasDataBlock = false;
  for (const layoutBlock of selection.layout) {
    if (layoutBlock.type === 'text') {
      const nodes = parseMarkup(layoutBlock.text);
      if (nodes.length > 0) {
        blocks.push({ type: 'text', nodes });
      }
    } else if (layoutBlock.type === 'table') {
      blocks.push(buildRecordTable(layoutBlock.indicators, tableData));
      hasDataBlock = true;
    } else {
      const chartBlocks = buildChartBlocks(layoutBlock, indicatorRows, places);
      if (chartBlocks.length > 0) {
        blocks.push(...chartBlocks);
        hasDataBlock = true;
      }
    }
  }
  if (!hasDataBlock) {
    blocks.push(buildRecordTable([], tableData));
  }

  appendFieldNotes(blocks, indicatorRows);

  const generatedOn = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const placeLabel = PLACE_GROUPS[selection.compareBy]?.noun ?? summaryNoun;
  return {
    style: resolveReportStyle(dataset.reportStyle, selection.styleOverrides),
    rowBased: true,
    rowLabelKey: labelColumn?.key ?? null,
    rowNoun: townKeyed ? placeLabel[0].toUpperCase() + placeLabel.slice(1) : labelColumn?.label ?? 'Row',
    title: selection.title || (townKeyed ? describePlaces(places, selection.allRows) : dataset.displayName || dataset.name),
    subtitle: selection.subtitle || `${dataset.displayName || dataset.name}, ${dataset.vintage}`,
    showTitle: selection.showTitle,
    dataset,
    places,
    indicators: indicatorRows,
    summaries,
    blocks,
    generatedOn,
    sourceLine: `Source: ${dataset.source}. Dataset: ${dataset.name}, ${dataset.vintage} (version ${dataset.version}). `
      + `Generated ${generatedOn}. Source rows are preserved; repeated values are not summed.`,
  };
}

function findSelectedColumns(selection, columns, customFields) {
  const customKeys = customIndicatorKeys(selection);
  const selectedColumns = [];
  for (const columnKey of selection.indicators) {
    const pool = customKeys.has(columnKey) ? customFields : columns;
    const column = pool.find((candidate) => candidate.key === columnKey);
    if (!column) {
      throw new HttpError(400, `Column "${columnKey}" is not available in this dataset.`);
    }
    selectedColumns.push(column);
  }
  return selectedColumns;
}

function filterRecords(sourceRows, selectedFilters, columns) {
  const filters = Object.entries(selectedFilters);
  for (const [columnKey] of filters) {
    const column = columns.find((candidate) => {
      return candidate.key === columnKey && candidate.role === 'dimension';
    });
    if (!column) {
      throw new HttpError(400, `Unknown category filter "${columnKey}".`);
    }
  }

  const matchingRecords = [];
  for (const record of sourceRows) {
    let matchesAllFilters = true;
    for (const [columnKey, filterValue] of filters) {
      const cellValue = String(record.cell_values[columnKey] ?? '');
      if (cellValue !== filterValue) {
        matchesAllFilters = false;
        break;
      }
    }
    if (matchesAllFilters) {
      matchingRecords.push(record);
    }
  }

  if (matchingRecords.length === 0) {
    throw new HttpError(400, 'No source rows match these rows and filters.');
  }
  return matchingRecords;
}

function buildRecordPlaces(records, primaryDimension, labelColumn, townKeyed) {
  const names = records.map((record) => recordRowName(record, labelColumn, townKeyed));
  const rowCountsByName = new Map();
  for (const name of names) {
    rowCountsByName.set(name, (rowCountsByName.get(name) ?? 0) + 1);
  }

  const places = [];
  const usedLabels = new Set();
  let hasRepeatedRows = false;
  for (const [index, record] of records.entries()) {
    const name = names[index];
    const geoType = townKeyed ? record.geo_type : 'row';
    let label = geoType === 'state' ? `${name} (statewide)` : name;
    if (rowCountsByName.get(name) > 1) {
      hasRepeatedRows = true;
      const category = primaryDimension && record.cell_values[primaryDimension.key];
      label += ` — ${category || `row ${record.source_row}`}`;
    }
    if (usedLabels.has(label)) {
      label += ` (source row ${record.source_row})`;
    }
    usedLabels.add(label);
    places.push({
      id: record.id,
      name,
      geoType,
      label,
    });
  }
  return { places, hasRepeatedRows };
}

/**
 * Every comparable row of the dataset, after the report's category filters: for town data,
 * every row of the same kind as those compared (all towns), otherwise every row.
 */
function recordBenchmark(datasetRows, comparedRecords, { townKeyed, labelColumn, columns, filters }) {
  if (!datasetRows || comparedRecords.length === 0) {
    return null;
  }
  const types = new Set(comparedRecords.map((record) => record.geo_type));
  const rows = filterRecords(datasetRows, filters, columns)
    .filter((record) => !townKeyed || (record.geo_type !== 'state' && types.has(record.geo_type)));
  const names = new Set(rows.map((record) => recordRowName(record, labelColumn, townKeyed)));
  const repeated = names.size < rows.length;
  const noun = summaryRowNoun(rows, townKeyed, repeated);
  const count = noun === 'row' ? rows.length : names.size;
  return { rows, ...benchmarkWording(count, noun, townKeyed) };
}

/** Rows are counted as towns (or counties…) only when each place has exactly one row. */
function summaryRowNoun(records, townKeyed, hasRepeatedRows) {
  if (!townKeyed || hasRepeatedRows) {
    return 'row';
  }
  const types = new Set(records.map((record) => record.geo_type));
  return types.size === 1 ? PLACE_GROUPS[[...types][0]]?.noun ?? 'row' : 'place';
}

function numericCell(record, column) {
  const rawValue = record.cell_values[column.key];
  if (column.type !== 'number' || rawValue == null) {
    return null;
  }
  return rawValue * (column.scale ?? 1);
}

/** Custom ratios are computed per source row from the two fields' stored values. */
function cellFor(record, column) {
  if (column.derivation === 'custom') {
    const value = computeRatio(numericCell(record, column.numerator), numericCell(record, column.denominator), column.multiplier);
    return { value, display: formatValue(value, column) };
  }
  return { value: numericCell(record, column), display: formatDatasetCell(record.cell_values[column.key], column) };
}

/** A custom ratio's component definitions are for computing, not for the report output. */
function withoutRatioParts(column) {
  const definition = { ...column };
  delete definition.numerator;
  delete definition.denominator;
  return definition;
}

function buildIndicatorRows(columns, records) {
  const indicatorRows = [];
  for (const column of columns) {
    const cells = records.map((record) => cellFor(record, column));
    indicatorRows.push({
      ...withoutRatioParts(column),
      displayLabel: column.label,
      cells,
    });
  }
  return indicatorRows;
}

function buildRecordTable(selectedKeys, tableData) {
  const { selectedColumns, primaryDimension, labelColumn, townKeyed, sourceIdentity, hasRepeatedRows, records } = tableData;
  let chosenColumns = selectedColumns;
  if (selectedKeys.length > 0) {
    chosenColumns = selectedColumns.filter((column) => selectedKeys.includes(column.key));
  }

  const tableColumns = [];
  if (labelColumn) {
    tableColumns.push(labelColumn);
  }
  if (sourceIdentity) {
    tableColumns.push(sourceIdentity);
  }
  const identityCount = tableColumns.length;
  if (primaryDimension && hasRepeatedRows && !chosenColumns.includes(primaryDimension)) {
    tableColumns.push(primaryDimension);
  }
  for (const column of chosenColumns) {
    if (!tableColumns.includes(column)) {
      tableColumns.push(column);
    }
  }

  const dimensionIndex = primaryDimension ? tableColumns.indexOf(primaryDimension) : -1;
  const repeatColumns = [...Array(identityCount).keys()];
  if (dimensionIndex >= identityCount && tableColumns.length > identityCount + 1 && hasRepeatedRows) {
    repeatColumns.push(dimensionIndex);
  }

  const tableRecords = [];
  for (const record of records) {
    const values = [];
    for (const column of tableColumns) {
      if (column === labelColumn && !townKeyed) {
        values.push(recordRowName(record, labelColumn, false));
      } else {
        values.push(cellFor(record, column).display);
      }
    }
    tableRecords.push({ values });
  }
  return {
    type: 'records',
    columns: tableColumns.map(withoutRatioParts),
    repeatColumns,
    records: tableRecords,
  };
}
