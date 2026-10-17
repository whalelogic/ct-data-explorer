/** Build charts without omitting selected measures or combining different units. */
const MAX_SERIES_PER_CHART = 6;

export function buildChartBlocks(layoutBlock, indicatorRows, places) {
  const selectedRows = selectNumericRows(layoutBlock.indicators, indicatorRows);
  const rowGroups = groupChartRows(selectedRows, layoutBlock.chartType);
  const chartBlocks = [];

  for (const rows of rowGroups) {
    const chart = buildChart(layoutBlock.chartType, rows, places, layoutBlock.colors ?? {});
    // A custom title is shown as written; the plotted fields move to a subtitle, so a
    // block that splits into several charts stays readable without gluing names together.
    if (layoutBlock.title) {
      chart.subtitle = chart.title;
      chart.title = layoutBlock.title;
    }
    chartBlocks.push({ type: 'chart', chart });
  }
  return chartBlocks;
}

function selectNumericRows(selectedKeys, indicatorRows) {
  const selectedRows = [];
  for (const row of indicatorRows) {
    const isSelected = selectedKeys.length === 0 || selectedKeys.includes(row.key);
    // Registered indicators are numeric and do not have a type property.
    const isNumeric = row.type === undefined || row.type === 'number';
    if (isSelected && isNumeric) {
      selectedRows.push(row);
    }
  }
  return selectedRows;
}

function groupChartRows(indicatorRows, chartType) {
  if (chartType === 'bar') {
    return indicatorRows.map((row) => [row]);
  }

  const rowsByUnit = new Map();
  for (const row of indicatorRows) {
    if (!rowsByUnit.has(row.unit)) {
      rowsByUnit.set(row.unit, []);
    }
    rowsByUnit.get(row.unit).push(row);
  }

  const rowGroups = [];
  for (const rows of rowsByUnit.values()) {
    for (let start = 0; start < rows.length; start += MAX_SERIES_PER_CHART) {
      rowGroups.push(rows.slice(start, start + MAX_SERIES_PER_CHART));
    }
  }
  return rowGroups;
}

/** A series color chosen in the builder wins over the report palette; others use the palette. */
function buildChart(chartType, rows, places, colors) {
  const series = [];
  for (const row of rows) {
    const chartSeries = {
      key: row.key,
      label: row.label,
      values: row.cells.map((cell) => cell.value),
    };
    if (colors[row.key]) {
      chartSeries.color = colors[row.key];
    }
    series.push(chartSeries);
  }

  return {
    type: chartType,
    title: rows.map((row) => row.label).join(' · '),
    unit: rows[0].unit,
    decimals: Math.max(...rows.map((row) => row.decimals ?? 0)),
    labels: places.map((place) => place.label),
    benchmarkIndex: places.findIndex((place) => place.geoType === 'state'),
    series,
  };
}
