/** Reports over original rows: no implicit aggregation, even for repeated town totals. */
import { HttpError } from '../lib/http-error.js';
import * as records from '../repositories/dataset-records.js';
import { parseMarkup } from './markup.js';
import { presentDataset } from './presenters.js';
import { formatDatasetCell } from './tabular-data.js';

export async function buildRecordReport(selection, dataset, places, now) {
  const rows = await records.list(dataset.id, { townIds: places.map((place) => place.id) });
  return renderRecordReport(selection, presentDataset(dataset), rows, now);
}

export function renderRecordReport(selection, dataset, sourceRows, now = new Date()) {
  const definitions = dataset.columns;
  const selected = selection.indicators.map((key) => {
    const column = definitions.find((item) => item.key === key && item.role !== 'town');
    if (!column) throw new HttpError(400, `Column "${key}" is not available in this dataset.`);
    return column;
  });
  const filters = Object.entries(selection.recordFilters ?? {}).map(([key, value]) => {
    const column = definitions.find((item) => item.key === key && item.role === 'dimension');
    if (!column) throw new HttpError(400, `Unknown category filter "${key}".`);
    return [key, value];
  });
  const records = sourceRows.filter((row) => filters.every(([key, value]) => String(row.cell_values[key] ?? '') === value));
  if (!records.length) throw new HttpError(400, 'No source rows match these towns and filters.');
  if (records.length > 1000) throw new HttpError(400, 'Filter this report to at most 1,000 source rows.');
  const primaryDimension = definitions.find((column) => column.role === 'dimension');
  const counts = new Map();
  records.forEach((row) => counts.set(row.town_id, (counts.get(row.town_id) ?? 0) + 1));
  const places = records.map((row) => ({
    id: row.id, name: row.name, geoType: row.geo_type,
    label: counts.get(row.town_id) > 1
      ? `${row.name} — ${primaryDimension && row.cell_values[primaryDimension.key] ? row.cell_values[primaryDimension.key] : `row ${row.source_row}`}`
      : row.name,
  }));
  const usedLabels = new Set();
  places.forEach((place, index) => {
    if (usedLabels.has(place.label)) place.label += ` (source row ${records[index].source_row})`;
    usedLabels.add(place.label);
  });
  const rows = selected.map((column) => ({ ...column, displayLabel: column.label,
    cells: records.map((row) => ({ value: column.type === 'number' && row.cell_values[column.key] != null
      ? row.cell_values[column.key] * (column.scale ?? 1) : null,
    display: formatDatasetCell(row.cell_values[column.key], column) })),
  }));
  function table(keys) {
    const chosen = keys.length ? selected.filter((column) => keys.includes(column.key)) : selected;
    const town = definitions.find((column) => column.role === 'town');
    const columns = [town, ...(primaryDimension && [...counts.values()].some((count) => count > 1)
      && !chosen.includes(primaryDimension) ? [primaryDimension] : []), ...chosen];
    const dimensionIndex = primaryDimension ? columns.indexOf(primaryDimension) : -1;
    return { type: 'records', columns,
      repeatColumns: dimensionIndex > 0 && columns.length > 2 && [...counts.values()].some((count) => count > 1) ? [0, dimensionIndex] : [0],
      records: records.map((row) => ({
      values: columns.map((column) => formatDatasetCell(row.cell_values[column.key], column)),
    })) };
  }
  const blocks = selection.layout.map((block) => {
    if (block.type === 'text') return { type: 'text', nodes: parseMarkup(block.text) };
    if (block.type === 'table') return table(block.indicators);
    let series = rows.filter((row) => row.type === 'number' && (!block.indicators.length || block.indicators.includes(row.key)));
    if (!block.indicators.length && series.length) series = series.filter((row) => row.unit === series[0].unit);
    if (block.chartType === 'bar') series = series.slice(0, 1);
    if (!series.length) return null;
    if (new Set(series.map((row) => row.unit)).size > 1) throw new HttpError(400, 'Chart columns must share a unit. Use separate charts for counts and percentages.');
    if (records.length > 40) throw new HttpError(400, 'Filter charts to at most 40 source rows, or use a table.');
    return { type: 'chart', chart: { type: block.chartType, unit: series[0].unit,
      decimals: Math.max(...series.map((row) => row.decimals)), labels: places.map((place) => place.label),
      benchmarkIndex: places.findIndex((place) => place.geoType === 'state'),
      series: series.map((row) => ({ key: row.key, label: row.label, values: row.cells.map((cell) => cell.value) })) } };
  }).filter(Boolean);
  if (!blocks.some((block) => block.type === 'records' || block.type === 'chart')) blocks.push(table([]));
  const generatedOn = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return { rowBased: true, title: selection.title || selection.towns.join(' and '),
    subtitle: selection.subtitle || `${dataset.name}, ${dataset.vintage}`, showTitle: selection.showTitle,
    dataset, places, indicators: rows, blocks, generatedOn,
    sourceLine: `Source: ${dataset.source}. Dataset: ${dataset.name}, ${dataset.vintage} (version ${dataset.version}). Generated ${generatedOn}. Source rows are preserved; repeated values are not summed.` };
}
