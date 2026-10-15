/** Reports keep the original source rows, including repeated town totals. */
import { HttpError } from '../lib/http-error.js';
import * as datasetRecords from '../repositories/dataset-records.js';
import { parseMarkup } from './markup.js';
import { presentDataset } from './presenters.js';
import { formatDatasetCell } from './tabular-data.js';
import { approvedDefinitions, requireApprovedSelection } from './field-curation.js';
import { buildChartBlocks } from './report-charts.js';

export async function buildRecordReport(selection, dataset, places, now) {
  const townIds = places.map((place) => place.id);
  const sourceRows = await datasetRecords.list(dataset.id, { townIds });
  return renderRecordReport(selection, presentDataset(dataset), sourceRows, now);
}

export function renderRecordReport(selection, dataset, sourceRows, now = new Date()) {
  const columns = approvedDefinitions(dataset.columns, dataset.approvedFields, { includeTown: true });
  const dataColumns = columns.filter((column) => column.role !== 'town');
  requireApprovedSelection(selection, dataColumns, dataset.approvedFields);

  const selectedColumns = findSelectedColumns(selection.indicators, dataColumns);
  const filteredRecords = filterRecords(sourceRows, selection.recordFilters ?? {}, columns);
  const primaryDimension = columns.find((column) => column.role === 'dimension');
  const { places, hasRepeatedTowns } = buildRecordPlaces(filteredRecords, primaryDimension);
  const indicatorRows = buildIndicatorRows(selectedColumns, filteredRecords);
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

  const generatedOn = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return {
    rowBased: true,
    title: selection.title || defaultTitle(selection.towns),
    subtitle: selection.subtitle || `${dataset.name}, ${dataset.vintage}`,
    showTitle: selection.showTitle,
    dataset,
    places,
    indicators: indicatorRows,
    blocks,
    generatedOn,
    sourceLine: `Source: ${dataset.source}. Dataset: ${dataset.name}, ${dataset.vintage} (version ${dataset.version}). `
      + `Generated ${generatedOn}. Source rows are preserved; repeated values are not summed.`,
  };
}

function defaultTitle(townNames) {
  if (townNames.length > 3) {
    return `${townNames.length} Connecticut towns`;
  }
  return townNames.join(' and ');
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
    throw new HttpError(400, 'No source rows match these towns and filters.');
  }
  return matchingRecords;
}

function buildRecordPlaces(records, primaryDimension) {
  const rowCountsByTown = new Map();
  for (const record of records) {
    const previousCount = rowCountsByTown.get(record.town_id) ?? 0;
    rowCountsByTown.set(record.town_id, previousCount + 1);
  }

  const places = [];
  const usedLabels = new Set();
  let hasRepeatedTowns = false;
  for (const record of records) {
    let label = record.name;
    if (rowCountsByTown.get(record.town_id) > 1) {
      hasRepeatedTowns = true;
      const category = primaryDimension && record.cell_values[primaryDimension.key];
      label += ` — ${category || `row ${record.source_row}`}`;
    }
    if (usedLabels.has(label)) {
      label += ` (source row ${record.source_row})`;
    }
    usedLabels.add(label);
    places.push({
      id: record.id,
      name: record.name,
      geoType: record.geo_type,
      label,
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
  const tableColumns = [townColumn];
  if (primaryDimension && hasRepeatedTowns && !chosenColumns.includes(primaryDimension)) {
    tableColumns.push(primaryDimension);
  }
  tableColumns.push(...chosenColumns);

  const dimensionIndex = primaryDimension ? tableColumns.indexOf(primaryDimension) : -1;
  const repeatColumns = [0];
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
