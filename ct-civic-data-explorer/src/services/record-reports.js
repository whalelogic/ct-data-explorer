/** Reports keep the original source rows, including repeated town totals. */
import { resolveReportStyle } from '../shared/report-style.js';
import { HttpError } from '../lib/http-error.js';
import * as datasetRecords from '../repositories/dataset-records.js';
import { parseMarkup } from './markup.js';
import { presentDataset } from './presenters.js';
import { formatDatasetCell } from './tabular-data.js';
import { approvedDefinitions, requireApprovedSelection } from './field-curation.js';
import { applyFieldPresentation, appendFieldNotes } from './presentation.js';
import { buildChartBlocks } from './report-charts.js';

export async function buildRecordReport(selection, dataset, now) {
  const sourceRows = await datasetRecords.list(dataset.id);
  return renderRecordReport(selection, presentDataset(dataset), sourceRows, now);
}

export function renderRecordReport(selection, dataset, sourceRows, now = new Date()) {
  const columns = applyFieldPresentation(approvedDefinitions(dataset.columns, dataset.approvedFields, { includeTown: true }), {}, selection.fieldOverrides);
  const dataColumns = columns.filter((column) => column.role !== 'town');
  requireApprovedSelection(selection, dataColumns, dataset.approvedFields);

  const selectedColumns = findSelectedColumns(selection.indicators, dataColumns);
  const geographicRecords = selectGeographicRecords(selection, sourceRows);
  const filteredRecords = filterRecords(geographicRecords, selection.recordFilters ?? {}, dataColumns);
  const primaryDimension = columns.find((column) => column.role === 'dimension');
  const { places, hasRepeatedTowns } = buildRecordPlaces(filteredRecords, primaryDimension);
  const indicatorRows = buildIndicatorRows(selectedColumns, filteredRecords);
  const allFieldRows = buildIndicatorRows(dataColumns, filteredRecords);
  const defaultAxis = primaryDimension
    ? allFieldRows.find((field) => field.key === primaryDimension.key)
    : places.some((place) => place.geoType) ? {
      key: '@location', label: 'Location',
      cells: places.map((place) => ({ rawValue: place.name, display: place.name })),
    } : null;
  const chartContext = {
    fields: allFieldRows,
    rowBased: true,
    datasetName: dataset.displayName || dataset.name,
    axisLabel: primaryDimension && !places.some((place) => place.geoType) ? primaryDimension.label : 'Location',
    defaultAxis,
  };
  const tableData = {
    columns,
    selectedColumns,
    primaryDimension,
    hasRepeatedTowns,
    records: filteredRecords,
  };

  const blocks = [];
  let hasDataBlock = false;
  for (const layoutBlock of selection.layout) {
    if (layoutBlock.type === 'text') {
      blocks.push({ type: 'text', nodes: parseMarkup(layoutBlock.text) });
    } else if (layoutBlock.type === 'table') {
      blocks.push(buildRecordTable(layoutBlock.indicators, tableData));
      hasDataBlock = true;
    } else {
      const chartBlocks = buildChartBlocks(layoutBlock, indicatorRows, places, chartContext);
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
    title: selection.title || defaultTitle(dataset, selectedColumns),
    subtitle: selection.subtitle || `${dataset.displayName || dataset.name}, ${dataset.vintage}`,
    showTitle: selection.showTitle,
    dataset,
    places,
    indicators: indicatorRows,
    blocks,
    generatedOn,
    sourceLine: `Source: ${dataset.source} · ${dataset.name}, ${dataset.vintage} · v${dataset.version} · ${generatedOn}`,
  };
}

function defaultTitle(dataset, columns) {
  return `${dataset.displayName || dataset.name}: ${columns.map((column) => column.label).join(' · ')}`.slice(0, 200);
}

/** Empty locations means every source row; an explicit location choice is checked against this version. */
function selectGeographicRecords(selection, records) {
  const selectedNames = new Set((selection.towns ?? []).map((name) => name.toLowerCase()));
  const availableTowns = new Set(records.filter((record) => record.geo_type === 'town').map((record) => record.name.toLowerCase()));
  for (const name of selection.towns ?? []) {
    if (!availableTowns.has(name.toLowerCase())) {
      throw new HttpError(400, `Location "${name}" is not available in this dataset.`);
    }
  }
  const hasState = records.some((record) => record.geo_type === 'state');
  if (selection.benchmark && !hasState) {
    throw new HttpError(400, 'A statewide benchmark is not available in this dataset.');
  }
  return records.filter((record) => {
    if (record.geo_type === 'state') return Boolean(selection.benchmark);
    return selectedNames.size === 0 || (record.geo_type === 'town' && selectedNames.has(record.name.toLowerCase()));
  });
}

function findSelectedColumns(selectedKeys, columns) {
  const selectedColumns = [];
  for (const columnKey of selectedKeys) {
    const column = columns.find((candidate) => candidate.key === columnKey);
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
      return candidate.key === columnKey;
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
    throw new HttpError(400, 'No source rows match these locations and filters.');
  }
  return matchingRecords;
}

function buildRecordPlaces(records, primaryDimension) {
  const rowCountsByTown = new Map();
  for (const record of records) {
    if (record.town_id != null) {
      const previousCount = rowCountsByTown.get(record.town_id) ?? 0;
      rowCountsByTown.set(record.town_id, previousCount + 1);
    }
  }

  const places = [];
  const usedLabels = new Set();
  let hasRepeatedTowns = false;
  for (const record of records) {
    const category = primaryDimension && record.cell_values[primaryDimension.key];
    let label = record.name || (category == null ? `Source row ${record.source_row}` : String(category));
    if (record.town_id != null && rowCountsByTown.get(record.town_id) > 1) {
      hasRepeatedTowns = true;
      label += ` — ${category || `row ${record.source_row}`}`;
    }
    if (usedLabels.has(label)) {
      label += ` (source row ${record.source_row})`;
    }
    usedLabels.add(label);
    places.push({
      id: record.id,
      name: record.name || label,
      geoType: record.geo_type,
      label,
      sourceRow: record.source_row,
    });
  }
  return { places, hasRepeatedTowns };
}

function buildIndicatorRows(columns, records) {
  const indicatorRows = [];
  for (const column of columns) {
    const cells = [];
    for (const record of records) {
      const rawValue = record.cell_values[column.key];
      let value = null;
      if (column.type === 'number' && rawValue != null) {
        value = rawValue * (column.scale ?? 1);
      }
      cells.push({
        value,
        rawValue,
        display: formatDatasetCell(rawValue, column),
      });
    }
    indicatorRows.push({
      ...column,
      displayLabel: column.label,
      cells,
    });
  }
  return indicatorRows;
}

function buildRecordTable(selectedKeys, tableData) {
  const { selectedColumns, primaryDimension, hasRepeatedTowns, records } = tableData;
  let chosenColumns = selectedColumns;
  if (selectedKeys.length > 0) {
    chosenColumns = selectedColumns.filter((column) => selectedKeys.includes(column.key));
  }

  const townColumn = tableData.columns.find((column) => column.role === 'town');
  const tableColumns = townColumn ? [townColumn] : [];
  if (primaryDimension && hasRepeatedTowns && !chosenColumns.includes(primaryDimension)) {
    tableColumns.push(primaryDimension);
  }
  tableColumns.push(...chosenColumns);

  const dimensionIndex = primaryDimension ? tableColumns.indexOf(primaryDimension) : -1;
  const repeatColumns = tableColumns.length ? [0] : [];
  if (dimensionIndex > 0 && tableColumns.length > 2 && hasRepeatedTowns) {
    repeatColumns.push(dimensionIndex);
  }

  const tableRecords = [];
  for (const record of records) {
    const values = [];
    for (const column of tableColumns) {
      values.push(formatDatasetCell(record.cell_values[column.key], column));
    }
    tableRecords.push({ values });
  }
  return {
    type: 'records',
    columns: tableColumns,
    repeatColumns,
    records: tableRecords,
  };
}
