/**
 * Render the API's report report data as HTML and Chart.js charts.
 * Chart.js is loaded as a global from /vendor/chart.js.
 */
import { formatAxisValue, formatValue, unitLabel } from '/shared/format.js';
import { CHART_FONT, INK, MUTED, RULE } from '/shared/theme.js';
import { resolveReportStyle } from '/shared/report-style.js';
import { h as createElement } from './dom.js';

// Keep each container's chart instances so they can be destroyed before a redraw.
const chartsByContainer = new WeakMap();
const HEADING_TAGS = { 1: 'h3', 2: 'h4', 3: 'h5' };
const CHART_PAGE_SIZE = 20;
const TABLE_PAGE_SIZE = 10;
const RECORD_PAGE_SIZE = 50;

export function renderReport(container, report) {
  clearReport(container);
  const pendingCharts = [];
  const indicatorsByKey = new Map();
  for (const indicator of report.indicators) {
    indicatorsByKey.set(indicator.key, indicator);
  }

  const style = resolveReportStyle(report.style);
  const article = createElement('article', { class: 'report', 'data-text-size': style.textSize, 'data-spacing': style.spacing });
  article.style.setProperty('--report-heading', style.headingColor);
  article.style.setProperty('--report-table-header', style.tableHeaderColor);
  if (report.showTitle) {
    const title = createElement('h2', { class: 'report-title' }, report.title);
    const header = createElement('header', {}, title);
    if (report.subtitle) {
      header.append(createElement('p', { class: 'report-subtitle' }, report.subtitle));
    }
    article.append(header);
  }

  for (const block of report.blocks) {
    const blockElement = renderBlock(block, report.places, indicatorsByKey, pendingCharts, style);
    if (blockElement) {
      article.append(blockElement);
    }
  }
  article.append(createElement('footer', { class: 'report-source' }, report.sourceLine));
  container.append(article);

  // Draw only after the canvases are attached, so Chart.js can measure them.
  for (const chartView of pendingCharts) {
    updateChartPage(chartView, 0);
  }
  chartsByContainer.set(container, pendingCharts);
}

export function clearReport(container) {
  for (const chartView of chartsByContainer.get(container) ?? []) {
    chartView.instance?.destroy();
  }
  chartsByContainer.delete(container);
  container.replaceChildren();
}

function renderBlock(block, places, indicatorsByKey, pendingCharts, style) {
  switch (block.type) {
    case 'text': {
      const section = createElement('section', { class: 'report-text' });
      for (const node of block.nodes) {
        const textElement = renderTextNode(node);
        if (textElement) {
          section.append(textElement);
        }
      }
      return section;
    }
    case 'chart': {
      return renderChart({ ...block.chart, style }, places, indicatorsByKey, pendingCharts);
    }
    case 'table':
      return renderPagedIndicatorTable(places, block.indicators);
    case 'records':
      return renderRecordTable(block);
    default:
      return null;
  }
}

function renderChart(chart, places, indicatorsByKey, pendingCharts) {
  const title = chart.title || chart.series.map((series) => series.label).join(', ');
  const canvas = createElement('canvas', { role: 'img' });
  const chartBox = createElement('div', { class: 'chart-box' }, canvas);
  const chartScroll = createElement('div', {
    class: 'chart-scroll',
    tabindex: '0',
    role: 'region',
    'aria-label': `${title}: chart`,
  }, chartBox);
  const tableContainer = createElement('div');
  const summary = createElement('summary', {}, 'Show this chart page as a table');
  const details = createElement('details', { class: 'chart-data' }, summary, tableContainer);
  const heading = createElement('figcaption', { class: 'chart-title' }, title);
  const chartView = {
    canvas,
    chartBox,
    tableContainer,
    chart,
    places,
    indicators: chart.series.map((series) => indicatorsByKey.get(series.key)).filter(Boolean),
    instance: null,
  };
  const pager = createPager(
    chart.labels.length,
    CHART_PAGE_SIZE,
    'Locations',
    updateChartPage.bind(null, chartView),
    `${title}: location pages`,
  );
  pendingCharts.push(chartView);
  return createElement('figure', { class: 'report-chart' }, heading, pager, chartScroll, details);
}

function updateChartPage(chartView, pageIndex) {
  const start = pageIndex * CHART_PAGE_SIZE;
  const end = start + CHART_PAGE_SIZE;
  const chart = {
    ...chartView.chart,
    labels: chartView.chart.labels.slice(start, end),
    benchmarkIndex: chartView.chart.benchmarkIndex - start,
    series: chartView.chart.series.map((series) => ({
      ...series,
      values: series.values.slice(start, end),
    })),
  };
  chartView.instance?.destroy();
  chartView.canvas.setAttribute('aria-label', describeChart(chart));
  chartView.chartBox.style.minWidth = `${Math.max(440, chart.labels.length * 70)}px`;
  chartView.instance = drawChart(chartView.canvas, chart, chartView.chart);
  const table = renderIndicatorTable(chartView.places, chartView.indicators, start, end);
  chartView.tableContainer.replaceChildren(table);
}

/** Page only the displayed values. The full selection remains available. */
function createPager(total, pageSize, noun, onChange, label) {
  if (total <= pageSize) {
    return null;
  }
  const pager = { total, pageSize, noun, onChange, pageIndex: 0 };
  pager.first = createElement('button', {
    type: 'button',
    onClick: changePage.bind(null, pager, 'first'),
  }, 'First');
  pager.previous = createElement('button', {
    type: 'button',
    onClick: changePage.bind(null, pager, 'previous'),
  }, 'Previous');
  pager.status = createElement('span', { class: 'page-status', 'aria-live': 'polite' });
  pager.next = createElement('button', {
    type: 'button',
    onClick: changePage.bind(null, pager, 'next'),
  }, 'Next');
  pager.last = createElement('button', {
    type: 'button',
    onClick: changePage.bind(null, pager, 'last'),
  }, 'Last');
  updatePager(pager);
  return createElement('nav', { class: 'data-pager', 'aria-label': label },
    pager.first, pager.previous, pager.status, pager.next, pager.last);
}

function changePage(pager, direction) {
  const lastPage = Math.ceil(pager.total / pager.pageSize) - 1;
  if (direction === 'first') {
    pager.pageIndex = 0;
  } else if (direction === 'previous') {
    pager.pageIndex = Math.max(0, pager.pageIndex - 1);
  } else if (direction === 'next') {
    pager.pageIndex = Math.min(lastPage, pager.pageIndex + 1);
  } else if (direction === 'last') {
    pager.pageIndex = lastPage;
  }
  updatePager(pager);
  pager.onChange(pager.pageIndex);
}

function updatePager(pager) {
  const start = pager.pageIndex * pager.pageSize;
  const end = Math.min(start + pager.pageSize, pager.total);
  pager.status.textContent = `${pager.noun} ${start + 1}–${end} of ${pager.total}`;
  pager.first.disabled = start === 0;
  pager.previous.disabled = start === 0;
  pager.next.disabled = end === pager.total;
  pager.last.disabled = end === pager.total;
}

/** Parsed text is inserted as text nodes, never as raw HTML. */
function renderTextNode(node) {
  switch (node.type) {
    case 'heading':
      return createElement(HEADING_TAGS[node.level], {}, ...renderTextRuns(node.runs));
    case 'paragraph':
      return createElement('p', {}, ...renderTextRuns(node.runs));
    case 'list': {
      const list = createElement(node.ordered ? 'ol' : 'ul', {
        start: node.ordered && node.start !== 1 ? node.start : null,
      });
      for (const runs of node.items) {
        const listItem = createElement('li', {}, ...renderTextRuns(runs));
        list.append(listItem);
      }
      return list;
    }
    default:
      return null;
  }
}

function renderTextRuns(runs) {
  const formattedRuns = [];
  for (const run of runs) {
    let content = run.text;
    if (run.italic) {
      content = createElement('em', {}, content);
    }
    if (run.bold) {
      content = createElement('strong', {}, content);
    }
    // The server only accepts http(s) and mailto links.
    if (run.href) {
      content = createElement('a', {
        href: run.href,
        rel: 'noopener noreferrer',
        target: '_blank',
      }, content);
    }
    formattedRuns.push(content);
  }
  return formattedRuns;
}

function renderPagedIndicatorTable(places, indicators) {
  const tableContainer = createElement('div');
  const tableView = { places, indicators, tableContainer };
  const pager = createPager(
    places.length,
    TABLE_PAGE_SIZE,
    'Locations',
    updateIndicatorTablePage.bind(null, tableView),
    'Indicator table location pages',
  );
  updateIndicatorTablePage(tableView, 0);
  return createElement('section', { class: 'report-table' }, pager, tableContainer);
}

function updateIndicatorTablePage(tableView, pageIndex) {
  const start = pageIndex * TABLE_PAGE_SIZE;
  const table = renderIndicatorTable(tableView.places, tableView.indicators, start, start + TABLE_PAGE_SIZE);
  tableView.tableContainer.replaceChildren(table);
}

function renderIndicatorTable(places, indicators, start = 0, end = places.length) {
  const headingRow = createElement('tr');
  headingRow.append(createElement('th', { scope: 'col' }, 'Indicator'));
  for (const place of places.slice(start, end)) {
    headingRow.append(createElement('th', { scope: 'col', class: 'num' }, place.label));
  }
  const tableHead = createElement('thead', {}, headingRow);

  const tableBody = createElement('tbody');
  for (const indicator of indicators) {
    const rowHeading = createElement('th', { scope: 'row' }, indicator.displayLabel);
    const row = createElement('tr', {}, rowHeading);
    for (const cell of indicator.cells.slice(start, end)) {
      row.append(createElement('td', { class: 'num' }, cell.display));
    }
    tableBody.append(row);
  }

  const table = createElement('table', { class: 'data' }, tableHead, tableBody);
  return createElement('div', {
    class: 'table-wrap',
    tabindex: '0',
    role: 'region',
    'aria-label': 'Indicator values',
  }, table);
}

function renderRecordTable(block) {
  const tableContainer = createElement('div');
  const tableView = { block, tableContainer };
  const pager = createPager(
    block.records.length,
    RECORD_PAGE_SIZE,
    'Rows',
    updateRecordTablePage.bind(null, tableView),
    'Source table row pages',
  );
  updateRecordTablePage(tableView, 0);
  return createElement('section', { class: 'report-table' }, pager, tableContainer);
}

function updateRecordTablePage(tableView, pageIndex) {
  const { block } = tableView;
  const start = pageIndex * RECORD_PAGE_SIZE;
  const headingRow = createElement('tr');
  for (const column of block.columns) {
    headingRow.append(createElement('th', { scope: 'col' }, column.label));
  }
  const tableHead = createElement('thead', {}, headingRow);

  const tableBody = createElement('tbody');
  for (const record of block.records.slice(start, start + RECORD_PAGE_SIZE)) {
    const row = createElement('tr');
    for (const [columnIndex, value] of record.values.entries()) {
      const isNumeric = block.columns[columnIndex].type === 'number';
      row.append(createElement('td', { class: isNumeric ? 'num' : null }, value));
    }
    tableBody.append(row);
  }

  const table = createElement('table', { class: 'data' }, tableHead, tableBody);
  const tableWrap = createElement('div', {
    class: 'table-wrap',
    tabindex: '0',
    role: 'region',
    'aria-label': 'Source rows',
  }, table);
  tableView.tableContainer.replaceChildren(tableWrap);
}

function drawChart(canvas, chart, fullChart = chart) {
  if (!window.Chart) {
    return null;
  }
  window.Chart.defaults.font.family = CHART_FONT;
  window.Chart.defaults.color = INK;
  window.Chart.defaults.borderColor = RULE;
  let minimumValue = 0;
  let maximumValue = 0;
  for (const series of fullChart.series) {
    for (const value of series.values) {
      if (value == null) {
        continue;
      }
      minimumValue = Math.min(minimumValue, value);
      maximumValue = Math.max(maximumValue, value);
    }
  }

  const datasets = [];
  for (const [seriesIndex, series] of chart.series.entries()) {
    const style = resolveReportStyle(chart.style);
    const seriesColor = style.palette[seriesIndex % style.palette.length];
    let backgroundColor = seriesColor;
    if (chart.type === 'bar') {
      backgroundColor = chart.labels.map((label, labelIndex) => (
        labelIndex === chart.benchmarkIndex ? style.benchmarkColor : seriesColor
      ));
    }
    datasets.push({
      label: series.label,
      data: series.values,
      backgroundColor,
      borderColor: seriesColor,
      borderWidth: chart.type === 'line' ? 2 : 0,
      pointRadius: 3,
    });
  }

  const chartInstance = new window.Chart(canvas, {
    type: chart.type === 'line' ? 'line' : 'bar',
    data: { labels: chart.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: MUTED,
            autoSkip: false,
            maxRotation: 60,
            minRotation: chart.labels.length > 5 ? 35 : 0,
          },
        },
        y: {
          beginAtZero: true,
          suggestedMin: minimumValue,
          suggestedMax: maximumValue,
          title: { display: true, text: unitLabel(chart.unit) },
          ticks: {
            color: MUTED,
            callback: (value) => formatAxisValue(value, chart),
          },
        },
      },
      plugins: {
        legend: {
          position: 'top',
          labels: { usePointStyle: true, boxWidth: 8, padding: 18 },
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const value = formatValue(context.parsed.y, {
                unit: chart.unit,
                decimals: chart.decimals,
              });
              return `${context.dataset.label}: ${value}`;
            },
          },
        },
      },
    },
  });

  // Canvas text does not redraw when a font loads. Refresh only if this chart
  // still exists and its canvas is attached to the page.
  document.fonts?.load(`12px ${CHART_FONT}`).then(() => {
    if (chartInstance.canvas && canvas.isConnected) {
      chartInstance.update('none');
    }
  });
  return chartInstance;
}

function describeChart(chart) {
  const chartTypes = { bar: 'Bar', grouped_bar: 'Grouped bar', line: 'Line' };
  const chartType = chartTypes[chart.type];
  const seriesLabels = chart.series.map((series) => series.label).join(', ');
  const placeLabels = chart.labels.join(', ');
  return `${chartType} chart of ${seriesLabels} for ${placeLabels}`;
}
