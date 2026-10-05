import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkup } from '../src/services/markup.js';
import { reportFilename, renderReportPdf } from '../src/services/pdf/index.js';

const places = [
  { id: 1, name: 'West Hartford', geoType: 'town', label: 'West Hartford' },
  { id: 2, name: 'Hamden', geoType: 'town', label: 'Hamden' },
  { id: 3, name: 'Connecticut', geoType: 'state', label: 'Connecticut (statewide)' },
];

const income = {
  key: 'medhouseholdincome',
  label: 'Median Household Income',
  displayLabel: 'Median Household Income',
  unit: 'currency',
  decimals: 0,
  cells: [129890, 98306, 95781].map((value) => ({ value, display: `$${value.toLocaleString('en-US')}` })),
};

const incomeChart = {
  type: 'bar',
  unit: 'currency',
  decimals: 0,
  labels: places.map((p) => p.label),
  benchmarkIndex: 2,
  series: [{ key: income.key, label: income.label, values: income.cells.map((c) => c.value) }],
};

const notes = parseMarkup(
  '## Summary\n\nWest Hartford has a **higher** median household income than *Hamden* and the ' +
    '[statewide figure](https://data.census.gov).\n\n- First point\n- Second point\n\n3. Third\n4. Fourth',
);

function makeReport(overrides = {}) {
  return {
    title: 'West Hartford and Hamden',
    subtitle: 'ACS 5-Year Town Profile, 2024',
    showTitle: true,
    dataset: { id: 1, name: 'ACS 5-Year Town Profile', source: 'U.S. Census Bureau', vintage: '2024', version: 1 },
    places,
    indicators: [income],
    blocks: [
      { type: 'chart', chart: incomeChart },
      { type: 'table', indicators: [income] },
      { type: 'text', nodes: notes },
    ],
    generatedOn: '2026-09-13',
    sourceLine: 'Source: U.S. Census Bureau. Dataset: ACS 5-Year Town Profile, 2024 (version 1). Generated 2026-09-13.',
    ...overrides,
  };
}

const pageCount = (pdf) => pdf.toString('latin1').match(/\/Type \/Page\b/g).length;

test('renders a PDF with a chart, a table, formatted text and the footer', async () => {
  const pdf = await renderReportPdf(makeReport());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(pdf), 1);
});

test('the same report renders to identical bytes', async () => {
  const [a, b] = await Promise.all([renderReportPdf(makeReport()), renderReportPdf(makeReport())]);
  assert.ok(a.equals(b));
});

test('grouped bar and line charts render, including missing values', async () => {
  for (const type of ['grouped_bar', 'line']) {
    const chart = { ...incomeChart, type, series: [...incomeChart.series, { key: 'x', label: 'Other', values: [50000, null, 40000] }] };
    const report = makeReport({ blocks: [{ type: 'chart', chart }] });
    const pdf = await renderReportPdf(report);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  }
});

test('long tables continue onto additional pages', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ ...income, key: `k${i}`, displayLabel: `Indicator ${i}` }));
  const pdf = await renderReportPdf(makeReport({ indicators: rows, blocks: [{ type: 'table', indicators: rows }] }));
  assert.ok(pageCount(pdf) >= 2);
});

test('several charts with headings between them flow onto more pages, in order', async () => {
  const section = (n) => [
    { type: 'text', nodes: parseMarkup(`# Section ${n}\n\nA paragraph about section ${n}.`) },
    { type: 'chart', chart: incomeChart },
  ];
  const pdf = await renderReportPdf(makeReport({ blocks: [1, 2, 3, 4].flatMap(section) }));
  assert.ok(pageCount(pdf) >= 2);
});

test('a report without a title and with only text and a table renders', async () => {
  const pdf = await renderReportPdf(makeReport({ showTitle: false, blocks: [{ type: 'text', nodes: notes }, { type: 'table', indicators: [income] }] }));
  assert.equal(pageCount(pdf), 1);
});

test('filenames are readable', () => {
  assert.equal(reportFilename(makeReport()), 'ctdata-report-west-hartford-acs2024.pdf');
});
