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
import { PLACE_GROUPS, benchmarkWording, describePlaces, recordRowName, reportRowLabel } from './row-labels.js';

export async function buildRecordReport(selection, dataset, now) {
  const presented = presentDataset(dataset);
  const sourceRows = await loadSelectedRows(selection, dataset, presented);
  // Summary benchmarks (e.g. the average for every town) need the dataset's other rows too.
  const wantsBenchmark = (selection.customIndicators ?? []).some((custom) => isSummaryIndicator(custom)
    && custom.benchmark !== false && selection.indicators.includes(custom.key));
  const datasetRows = wantsBenchmark ? await datasetRecords.list(dataset.id) : null;
  return renderRecordReport(selection, presented, sourceRows, now, { datasetRows });
}

/** Town-keyed rows are narrowed in SQL; rows labeled by another column are narrowed by label. */
async function loadSelectedRows(selection, dataset, presented) {
  const { labelColumn, townKeyed } = reportRowLabel(presented, selection.compareBy);
  if (townKeyed) {
    if (selection.allRows) {
      const allRows = await datasetRecords.list(dataset.id);
      return selection.benchmark ? allRows : allRows.filter((row) => row.geo_type !== 'state');
    }
    const places = await towns.findByNames(selection.rows);
    const townIds = places.filter((place) => place.geo_type !== 'state').map((place) => place.id);
    if (selection.benchmark) {
      const state = await towns.findState();
      if (state) {
        townIds.push(state.id);
      }
    }
    return datasetRecords.list(dataset.id, { townIds });
  }

  const allRows = await datasetRecords.list(dataset.id);
  if (selection.allRows) {
    return allRows;
  }
  const wanted = new Set(selection.rows.map((name) => name.toLowerCase()));
  const selectedRows = allRows.filter((row) => wanted.has(recordRowName(row, labelColumn, false).toLowerCase()));

  // A name can stop matching when staff change the label column; say so rather than render a gap.
  const found = new Set(selectedRows.map((row) => recordRowName(row, labelColumn, false).toLowerCase()));
  const missing = selection.rows.filter((name) => !found.has(name.toLowerCase()));
  if (missing.length) {
    const noun = labelColumn?.label ?? 'row';
    const names = missing.slice(0, 3).map((name) => `"${name}"`).join(', ');
    const more = missing.length > 3 ? ` and ${missing.length - 3} more` : '';
    throw new HttpError(400, `${names}${more} ${missing.length === 1 ? 'is' : 'are'} not a ${noun} in this dataset. Choose rows again.`);
  }
  return selectedRows;
}

/**
 * @param {{ datasetRows?: object[] | null }} [options] every row of the dataset, for summary
 *   benchmarks; without it summaries show the report's figure only
 */
export function renderRecordReport(fullSelection, dataset, sourceRows, now = new Date(), { datasetRows = null } = {}) {
  // Summary fields (e.g. average per town) are one value for the report, not a column.
  const selection = withoutSummaryIndicators(fullSelection);
  const fieldSelection = withoutCustomIndicators(selection);
  const columns = applyFieldPresentation(
    approvedDefinitions(dataset.columns, dataset.approvedFields, { includeTown: true }),
    {},
    fieldSelection.fieldOverrides,
  );
  const chosen = reportRowLabel({ ...dataset, townKeyed: dataset.townKeyed ?? true }, selection.compareBy);
  const townKeyed = chosen.townKeyed;
  // Use the presented column so report-specific names apply to the row heading too.
  const labelColumn = columns.find((column) => column.key === chosen.labelColumn?.key) ?? chosen.labelColumn;
  const dataColumns = columns.filter((column) => !isRowIdentity(column));
  requireApprovedSelection(fieldSelection, dataColumns, dataset.approvedFields);

  const customFields = applyFieldPresentation(buildCustomFields(selection, dataColumns), {}, selection.fieldOverrides);
  const selectedColumns = findSelectedColumns(selection, dataColumns, customFields);
  const filteredRecords = filterRecords(sourceRows, selection.recordFilters ?? {}, columns);
  const primaryDimension = columns.find((column) => column.role === 'dimension' && column.key !== labelColumn?.key);
  const { places, hasRepeatedRows } = buildRecordPlaces(filteredRecords, primaryDimension, labelColumn, townKeyed);
  const indicatorRows = buildIndicatorRows(selectedColumns, filteredRecords);
  const comparedRecords = filteredRecords.filter((record) => record.geo_type !== 'state');
  const summaries = computeSummaries(
    fullSelection,
    dataColumns,
    comparedRecords,
    {
      readValue: (record, field) => (field.type === 'number' ? numericCell(record, field) : record.cell_values[field.key]),
      // The report's own row labels, which tell repeated rows apart ("Food pantry — North").
      nameOf: (record) => places.find((place) => place.id === record.id)?.label ?? recordRowName(record, labelColumn, townKeyed),
      rowNoun: summaryRowNoun(comparedRecords, townKeyed, hasRepeatedRows),
    },
    recordBenchmark(datasetRows, comparedRecords, { townKeyed, labelColumn, columns, filters: selection.recordFilters ?? {} }),
  );
  const tableData = {
    columns,
    selectedColumns,
    primaryDimension,
    labelColumn,
    townKeyed,
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
  return {
    style: resolveReportStyle(dataset.reportStyle, selection.styleOverrides),
    rowBased: true,
    rowNoun: townKeyed ? 'Town' : labelColumn?.label ?? 'Row',
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
    let label = record.geo_type === 'state' ? `${name} (statewide)` : name;
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
      geoType: record.geo_type,
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
  const rows = filterRecords(datasetRows, filters, columns).filter((record) => record.geo_type !== 'state' && types.has(record.geo_type));
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
  const { selectedColumns, primaryDimension, labelColumn, townKeyed, hasRepeatedRows, records } = tableData;
  let chosenColumns = selectedColumns;
  if (selectedKeys.length > 0) {
    chosenColumns = selectedColumns.filter((column) => selectedKeys.includes(column.key));
  }

  const tableColumns = [];
  if (labelColumn) {
    tableColumns.push(labelColumn);
  }
  // A town column that no longer labels the rows is still useful context.
  const townColumn = tableData.columns.find((column) => column.role === 'town');
  if (!townKeyed && townColumn && townColumn !== labelColumn) {
    tableColumns.push(townColumn);
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
