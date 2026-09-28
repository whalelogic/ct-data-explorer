/**
 * Renders card data from the API (the same object the PDF renderer consumes) as
 * HTML with a Chart.js chart. Chart.js is loaded as a global from /vendor/chart.js.
 */
import { formatAxisValue, formatValue, unitLabel } from '/shared/format.js';
import { BENCHMARK_COLOR, SERIES_COLORS } from '/shared/theme.js';
import { h } from './dom.js';

const charts = new WeakMap(); // container -> Chart.js instances to destroy on re-render
const HEADING_TAGS = { 1: 'h3', 2: 'h4', 3: 'h5' }; // the card title is the h2

export function renderCard(container, card) {
  clearCard(container);
  const pending = []; // [canvas, chart data] pairs, drawn once attached to the page
  const rowByKey = new Map(card.indicators.map((row) => [row.key, row]));

  const body = card.blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return h('section', { class: 'card-text' }, ...block.nodes.map(renderNode));
      case 'chart': {
        const canvas = h('canvas', { role: 'img', 'aria-label': describeChart(block.chart) });
        pending.push([canvas, block.chart]);
        return h(
          'figure',
          { class: 'card-chart' },
          h('div', { class: 'chart-box' }, canvas),
          // A chart alone is not accessible, so each one carries its values as a table.
          h('details', { class: 'chart-data' }, h('summary', {}, 'Show the chart data as a table'), renderTable(card.places, block.chart.series.map((series) => rowByKey.get(series.key)))),
        );
      }
      case 'table':
        return renderTable(card.places, block.indicators);
      default:
        return null;
    }
  });

  container.append(
    h(
      'article',
      { class: 'card' },
      card.showTitle
        ? h('header', {}, h('h2', { class: 'card-title' }, card.title), card.subtitle ? h('p', { class: 'card-subtitle' }, card.subtitle) : null)
        : null,
      ...body,
      h('footer', { class: 'card-source' }, card.sourceLine),
    ),
  );

  charts.set(container, pending.map(([canvas, chart]) => drawChart(canvas, chart)).filter(Boolean));
}

export function clearCard(container) {
  for (const chart of charts.get(container) ?? []) chart.destroy();
  charts.delete(container);
  container.replaceChildren();
}

/** One node of a parsed text block (see src/services/markup.js). Text only; never HTML. */
function renderNode(node) {
  switch (node.type) {
    case 'heading':
      return h(HEADING_TAGS[node.level], {}, ...renderRuns(node.runs));
    case 'paragraph':
      return h('p', {}, ...renderRuns(node.runs));
    case 'list':
      return h(
        node.ordered ? 'ol' : 'ul',
        { start: node.ordered && node.start !== 1 ? node.start : null },
        ...node.items.map((runs) => h('li', {}, ...renderRuns(runs))),
      );
    default:
      return null;
  }
}

function renderRuns(runs) {
  return runs.map((run) => {
    let el = run.text;
    if (run.italic) el = h('em', {}, el);
    if (run.bold) el = h('strong', {}, el);
    // The server only accepts http(s) and mailto links.
    if (run.href) el = h('a', { href: run.href, rel: 'noopener noreferrer', target: '_blank' }, el);
    return el;
  });
}

function renderTable(places, rows) {
  return tableWrap(
    places.map((p) => p.label),
    rows.map((row) => [row.displayLabel, ...row.cells.map((cell) => cell.display)]),
  );
}

function tableWrap(columns, rows) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Indicator'), ...columns.map((c) => h('th', { scope: 'col', class: 'num' }, c)))),
      h(
        'tbody',
        {},
        ...rows.map(([label, ...cells]) => h('tr', {}, h('th', { scope: 'row' }, label), ...cells.map((c) => h('td', { class: 'num' }, c)))),
      ),
    ),
  );
}

function drawChart(canvas, chart) {
  if (!window.Chart) return null;
  const singleSeries = chart.type === 'bar';
  const datasets = chart.series.map((series, i) => {
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    return {
      label: series.label,
      data: series.values,
      backgroundColor: singleSeries ? chart.labels.map((_, j) => (j === chart.benchmarkIndex ? BENCHMARK_COLOR : color)) : color,
      borderColor: color,
      borderWidth: chart.type === 'line' ? 2 : 0,
      pointRadius: 3,
    };
  });

  return new window.Chart(canvas, {
    type: chart.type === 'line' ? 'line' : 'bar',
    data: { labels: chart.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: unitLabel(chart.unit) },
          ticks: { callback: (value) => formatAxisValue(value, chart) },
        },
      },
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatValue(ctx.parsed.y, { unit: chart.unit, decimals: chart.decimals })}`,
          },
        },
      },
    },
  });
}

function describeChart(chart) {
  const kind = { bar: 'Bar', grouped_bar: 'Grouped bar', line: 'Line' }[chart.type];
  return `${kind} chart of ${chart.series.map((s) => s.label).join(', ')} for ${chart.labels.join(', ')}`;
}
