import assert from 'node:assert/strict';
import { test } from 'node:test';
import PDFDocument from 'pdfkit';
import { applyFieldPresentation, appendFieldNotes } from '../src/services/presentation.js';
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

test('all 169 locations, indicator values, chart titles, and page footers survive PDF pagination', async (context) => {
  const writtenText = capturePdfText(context);
  const allPlaces = Array.from({ length: 169 }, (_, index) => ({
    id: index + 1,
    name: `Town ${String(index + 1).padStart(3, '0')}`,
    label: `Town ${String(index + 1).padStart(3, '0')}`,
    geoType: 'town',
  }));
  const allIncome = {
    ...income,
    cells: allPlaces.map((place, index) => ({ value: 1000 + index, display: `Value-${index + 1}` })),
  };
  const chart = {
    ...incomeChart,
    title: 'Income for every selected town',
    labels: allPlaces.map((place) => place.label),
    benchmarkIndex: -1,
    series: [{ key: income.key, label: income.label, values: allIncome.cells.map((cell) => cell.value) }],
  };
  const secondChart = {
    ...chart,
    title: 'A second selected indicator',
    unit: 'percent',
    series: [{ key: 'rate', label: 'Employment rate', values: allPlaces.map(() => 83) }],
  };
  const report = makeReport({
    places: allPlaces,
    indicators: [allIncome],
    blocks: [{ type: 'chart', chart }, { type: 'chart', chart: secondChart }, { type: 'table', indicators: [allIncome] }],
  });
  const pdf = await renderReportPdf(report);
  const numberOfPages = pageCount(pdf);
  assert.ok(numberOfPages > 20);
  for (const place of allPlaces) {
    assert.equal(writtenText.filter((text) => text === place.label).length, 3, place.label);
  }
  for (const cell of allIncome.cells) {
    assert.ok(writtenText.includes(cell.display), cell.display);
  }
  assert.ok(writtenText.includes(chart.title));
  assert.ok(writtenText.includes(secondChart.title));
  assert.ok(writtenText.includes('Locations 169-169 of 169'));
  assert.equal(writtenText.filter((text) => text === report.sourceLine).length, numberOfPages);
  assert.ok(writtenText.includes(`Page ${numberOfPages} of ${numberOfPages}`));
});

test('source rows beyond the old limit remain in every column group', async (context) => {
  const writtenText = capturePdfText(context);
  const columns = Array.from({ length: 7 }, (_, index) => ({ label: `Field ${index + 1}`, type: 'text' }));
  const records = Array.from({ length: 101 }, (_, rowIndex) => ({
    values: columns.map((column, columnIndex) => `Row${rowIndex + 1}-Column${columnIndex + 1}`),
  }));
  const pdf = await renderReportPdf(makeReport({ blocks: [{ type: 'records', columns, records, repeatColumns: [0] }] }));
  assert.ok(pageCount(pdf) > 2);
  for (const record of records) {
    for (const value of record.values) {
      assert.ok(writtenText.includes(value), value);
    }
  }
});

test('charts preserve negative indicator values on their axis', async (context) => {
  const writtenText = capturePdfText(context);
  const chart = {
    ...incomeChart,
    unit: 'number',
    series: [{ key: 'change', label: 'Population change', values: [-50, 0, 50] }],
  };
  const pdf = await renderReportPdf(makeReport({ blocks: [{ type: 'chart', chart }] }));
  assert.equal(pageCount(pdf), 1);
  assert.ok(writtenText.includes('-50'));
});

test('long category labels stay on the chart page and remain complete in the source table or label key', async (context) => {
  const labels = Array.from({ length: 6 }, (_, index) => {
    return `Category ${index + 1}: ${'A detailed source category description with extra context. '.repeat(8)}`;
  });
  const axisWrites = [];
  const fullText = [];
  const originalText = PDFDocument.prototype.text;
  context.mock.method(PDFDocument.prototype, 'text', function recordLongLabel(text, ...options) {
    const firstPage = this.bufferedPageRange().count;
    const result = originalText.call(this, text, ...options);
    if (labels.includes(text) && options[2]?.align === 'center') {
      axisWrites.push({ firstPage, lastPage: this.bufferedPageRange().count });
    } else {
      fullText.push(text);
    }
    return result;
  });
  const chart = {
    ...incomeChart,
    labels,
    series: [{ key: income.key, label: income.label, values: [101, 102, 103, 104, 105, 106] }],
  };
  const records = labels.map((label, index) => ({ values: [label, String(101 + index)] }));
  const sourceTable = {
    type: 'records',
    columns: [{ label: 'Category', type: 'text' }, { label: 'Value', type: 'number' }],
    records,
  };
  const pdf = await renderReportPdf(makeReport({ blocks: [{ type: 'chart', chart }, sourceTable] }));
  assert.ok(pageCount(pdf) <= 4, 'The chart and its source table should occupy only a few readable pages.');
  assert.equal(axisWrites.length, labels.length);
  for (const operation of axisWrites) {
    assert.equal(operation.firstPage, 1);
    assert.equal(operation.lastPage, 1, 'An axis label must never trigger a page break.');
  }
  for (const record of records) {
    for (const value of record.values) {
      assert.ok(fullText.includes(value), 'Source table values must remain complete.');
    }
  }
  assert.ok(!fullText.includes('Full location labels'), 'A source table does not need a duplicate key.');

  fullText.length = 0;
  const chartOnlyPdf = await renderReportPdf(makeReport({ blocks: [{ type: 'chart', chart }] }));
  assert.ok(pageCount(chartOnlyPdf) <= 3);
  assert.ok(fullText.includes('Full location labels'));
  for (const label of labels) {
    assert.ok(fullText.some((text) => text.endsWith(label)), 'A chart-only report must retain every full label.');
  }
});

function capturePdfText(context) {
  const writtenText = [];
  const originalText = PDFDocument.prototype.text;
  context.mock.method(PDFDocument.prototype, 'text', function recordPdfText(text, ...options) {
    writtenText.push(text);
    return originalText.call(this, text, ...options);
  });
  return writtenText;
}


test('custom field names, chart titles and explanations reach the PDF without changing values', async (context) => {
  const writtenText = capturePdfText(context);
  const customized = applyFieldPresentation([income], {}, {
    medhouseholdincome: { label: 'Household earnings', description: 'Median income for households in this period.' },
  });
  const chart = { ...incomeChart, title: 'Income comparison', series: incomeChart.series.map((series) => ({ ...series, label: 'Household earnings' })) };
  const blocks = [{ type: 'chart', chart }, { type: 'table', indicators: customized }];
  appendFieldNotes(blocks, customized);
  const report = makeReport({ indicators: customized, blocks });
  const pdf = await renderReportPdf(report);
  assert.ok(pdf.length > 1000);
  for (const expected of ['Household earnings', 'Income comparison', 'Field notes', 'Median income for households in this period.']) {
    assert.ok(writtenText.some((text) => text.includes(expected)), expected);
  }
  assert.ok(writtenText.includes(income.cells[0].display));
  assert.ok(writtenText.includes(report.sourceLine));
});
