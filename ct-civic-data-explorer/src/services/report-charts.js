/** Charts retain the source grain unless the report explicitly requests aggregation. */
import { HttpError } from '../lib/http-error.js';

const MAX_SERIES_PER_CHART = 6;
const AGGREGATION_LABELS = { sum: 'Sum of', average: 'Average', min: 'Minimum', max: 'Maximum' };

/**
 * `context.fields` contains approved field rows, including unselected axis/series fields.
 * Every field's cells have the same order as places. A cell's rawValue is used for
 * grouping/filter identity; value and display contain its presentation settings.
 */
export function buildChartBlocks(layoutBlock, indicatorRows, places, context = {}) {
  const selectedRows = selectNumericRows(layoutBlock.indicators, indicatorRows);
  const aggregation = layoutBlock.aggregation ?? 'none';
  const axisField = layoutBlock.axisField || '';
  const seriesField = layoutBlock.seriesField || '';
  const fields = context.fields ?? indicatorRows;
  const axis = resolveField(axisField, fields, places, 'axis')
    ?? (aggregation !== 'none' ? context.defaultAxis : null);
  const series = resolveField(seriesField, fields, places, 'series');
  const projected = projectRows(selectedRows, places, axis, series, aggregation, context);
  const rowGroups = groupChartRows(projected.rows, layoutBlock.chartType);
  const chartBlocks = [];

  for (const rows of rowGroups) {
    const titleMeasures = [...new Set(rows.map((row) => row.measureLabel ?? row.label))].join(' · ');
    const operation = aggregation === 'none' ? '' : `${AGGREGATION_LABELS[aggregation]} `;
    let title = `${operation}${titleMeasures}${axis ? ` by ${axis.label}` : ''}`;
    if (series) title += ` — ${series.label}`;
    if (context.datasetName) title = `${context.datasetName}: ${title}`;
    const chart = {
      type: layoutBlock.chartType,
      title,
      unit: rows[0].unit,
      decimals: Math.max(...rows.map((row) => row.decimals ?? 0)),
      labels: projected.places.map((place) => place.label),
      places: projected.places,
      axisField: axis?.key ?? axisField,
      axisLabel: axis?.label ?? context.axisLabel ?? 'Location',
      seriesField,
      seriesLabel: series?.label ?? '',
      aggregation,
      categoryLabel: axis?.key === '@location' ? 'Locations'
        : aggregation !== 'none' ? 'Categories' : context.rowBased || axis ? 'Rows' : 'Locations',
      benchmarkIndex: projected.places.findIndex((place) => place.geoType === 'state'),
      series: rows.map((row) => ({
        key: row.key,
        label: row.label,
        unit: row.unit,
        decimals: row.decimals,
        values: row.cells.map((cell) => cell.value),
      })),
    };
    if (layoutBlock.title) {
      chart.title = rowGroups.length > 1 ? `${layoutBlock.title} — ${titleMeasures}` : layoutBlock.title;
    }
    chartBlocks.push({ type: 'chart', chart });
  }
  return chartBlocks;
}

function selectNumericRows(selectedKeys = [], indicatorRows) {
  return indicatorRows.filter((row) => {
    const isSelected = selectedKeys.length === 0 || selectedKeys.includes(row.key);
    return isSelected && (row.type === undefined || row.type === 'number');
  });
}

function resolveField(key, fields, places, purpose) {
  if (!key) return null;
  if (key === '@location') {
    if (!places.some((place) => place.geoType === 'town' || place.geoType === 'state')) {
      throw new HttpError(400, 'Location comparisons are not available for this dataset.');
    }
    return {
      key, label: 'Location',
      cells: places.map((place) => ({
        rawValue: place.geoType ? place.name ?? place.label : null,
        display: place.geoType ? place.name ?? place.label : 'Unmatched location',
      })),
    };
  }
  if (key === '@row') {
    return {
      key, label: 'Source row',
      cells: places.map((place, index) => ({
        rawValue: place.sourceRow ?? index + 1,
        display: `Source row ${place.sourceRow ?? index + 1}`,
      })),
    };
  }
  const field = fields.find((candidate) => candidate.key === key);
  if (!field) {
    throw new HttpError(400, `Chart ${purpose} field "${key}" is not approved for this dataset. Choose an available field.`);
  }
  return field;
}

function cellIdentity(cell) {
  const value = cell?.rawValue !== undefined ? cell.rawValue : cell?.value !== undefined ? cell.value : cell?.display;
  return JSON.stringify(value ?? null);
}

function cellLabel(cell) {
  return cell?.display ?? String(cell?.rawValue ?? cell?.value ?? 'N/A');
}

function projectRows(rows, places, axis, series, aggregation, context) {
  if (!axis && !series && aggregation === 'none') return { rows, places };

  // Default aggregation groups by a real category or location, never by an invented total.
  const effectiveAxis = axis ?? (aggregation !== 'none' ? context.defaultAxis : null);
  const axisCells = effectiveAxis?.cells ?? places.map((place) => ({ rawValue: place.label, display: place.label }));
  const seriesCells = series?.cells;
  const groups = [];
  const groupsByKey = new Map();
  const labelCounts = new Map();
  const axisLabelAt = (index) => {
    const label = cellLabel(axisCells[index]);
    const categoryBenchmark = places[index].geoType === 'state' && effectiveAxis && effectiveAxis.key !== '@location';
    return categoryBenchmark ? `${label} (statewide)` : label;
  };
  for (let index = 0; index < places.length; index++) {
    const label = axisLabelAt(index);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  for (let index = 0; index < places.length; index++) {
    const label = axisLabelAt(index);
    const isBenchmark = places[index].geoType === 'state';
    // A benchmark is a comparison total, so it never enters a town/category aggregate.
    const key = aggregation === 'none' ? String(index) : JSON.stringify([cellIdentity(axisCells[index]), isBenchmark]);
    let group = groupsByKey.get(key);
    if (!group) {
      const sourcePlace = places[index];
      const uniqueLabel = aggregation === 'none' && labelCounts.get(label) > 1
        ? `${label} (source row ${sourcePlace.sourceRow ?? index + 1})` : label;
      const isGeography = effectiveAxis?.key === '@location' || (!effectiveAxis && !axis);
      group = {
        indexes: [],
        place: {
          ...sourcePlace,
          label: uniqueLabel,
          name: label,
          geoType: isBenchmark ? 'state' : isGeography ? sourcePlace.geoType : null,
        },
      };
      groupsByKey.set(key, group);
      groups.push(group);
    }
    group.indexes.push(index);
  }

  const categories = new Map();
  if (seriesCells) {
    for (const cell of seriesCells) {
      const key = cellIdentity(cell);
      if (!categories.has(key)) categories.set(key, cellLabel(cell));
    }
    if (categories.size > 60) {
      throw new HttpError(400, `The series field has ${categories.size} distinct values. Filter the dataset or choose a series field with at most 60 values.`);
    }
  } else categories.set('', '');

  const projectedCells = rows.length * categories.size * groups.length;
  if (projectedCells > 1000000) {
    throw new HttpError(400,
      `This chart would create ${projectedCells.toLocaleString('en-US')} plotted cells (limit 1,000,000). `
      + 'Filter the rows, select fewer measures or series, or choose a category axis and explicitly aggregate.');
  }

  const projectedRows = [];
  for (const row of rows) {
    for (const [categoryKey, categoryLabel] of categories) {
      projectedRows.push({
        ...row,
        key: series ? `${row.key}:${categoryKey}` : row.key,
        measureLabel: row.label,
        label: series ? `${row.label} — ${categoryLabel}` : row.label,
        decimals: aggregation === 'average' ? Math.max(row.decimals ?? 0, 2) : row.decimals,
        cells: groups.map((group) => {
          const indexes = group.indexes.filter((index) => !seriesCells || cellIdentity(seriesCells[index]) === categoryKey);
          const values = indexes.map((index) => row.cells[index]?.value).filter((value) => Number.isFinite(value));
          return { value: aggregate(values, aggregation) };
        }),
      });
    }
  }
  return { rows: projectedRows, places: groups.map((group) => group.place) };
}

function aggregate(values, aggregation) {
  if (!values.length) return null;
  if (aggregation === 'none') return values[0];
  if (aggregation === 'min') return Math.min(...values);
  if (aggregation === 'max') return Math.max(...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  return aggregation === 'average' ? total / values.length : total;
}

function groupChartRows(indicatorRows, chartType) {
  if (chartType === 'bar') return indicatorRows.map((row) => [row]);
  const rowsByUnit = new Map();
  for (const row of indicatorRows) {
    const unit = row.unit ?? 'number';
    if (!rowsByUnit.has(unit)) rowsByUnit.set(unit, []);
    rowsByUnit.get(unit).push(row);
  }
  const rowGroups = [];
  for (const rows of rowsByUnit.values()) {
    for (let start = 0; start < rows.length; start += MAX_SERIES_PER_CHART) {
      rowGroups.push(rows.slice(start, start + MAX_SERIES_PER_CHART));
    }
  }
  return rowGroups;
}
