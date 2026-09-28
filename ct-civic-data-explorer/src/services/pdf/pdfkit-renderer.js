/**
 * pdfkit renderer: draws card data (title, then text, chart and table blocks in order, and the source footer) with
 * vector primitives. No headless browser and no network access. Output depends only
 * on the card data, so the same card and dataset version produce the same file.
 */
import PDFDocument from 'pdfkit';
import { formatAxisValue, unitLabel } from '../../shared/format.js';
import { BENCHMARK_COLOR, INK, LINK_COLOR, MUTED, RULE, SERIES_COLORS, TABLE_HEADER_FILL } from '../../shared/theme.js';

const MARGIN = 54;
const FOOTER_HEIGHT = 40;
const CHART_HEIGHT = 230;
const LEGEND_HEIGHT = 18;
const BODY_SIZE = 10.5;
const HEADING_SIZES = { 1: 15, 2: 13, 3: 11.5 };

/** @returns {Promise<Buffer>} */
export function renderWithPdfkit(card) {
  return new Promise((resolve, reject) => {
    const date = new Date(`${card.generatedOn}T12:00:00Z`);
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN + FOOTER_HEIGHT },
      bufferPages: true,
      info: {
        Title: card.title,
        Author: 'CTData Collaborative',
        Creator: 'CT Civic Data Explorer',
        CreationDate: date,
        ModDate: date,
      },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      drawBody(doc, card);
      drawFooters(doc, card);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawBody(doc, card) {
  const width = contentWidth(doc);
  if (card.showTitle) {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(card.title, MARGIN, doc.y, { width });
    if (card.subtitle) doc.moveDown(0.2).font('Helvetica').fontSize(12).fillColor(MUTED).text(card.subtitle, { width });
    doc.moveDown(1);
  }
  card.blocks.forEach((block, i) => {
    const next = card.blocks[i + 1];
    if (block.type === 'text' && next?.type === 'chart') keepWithChart(doc, block.nodes);
    if (block.type === 'text') drawText(doc, block.nodes);
    else if (block.type === 'chart') drawChart(doc, block.chart);
    else if (block.type === 'table') drawTable(doc, card.places, block.indicators);
    doc.x = MARGIN;
    doc.moveDown(1);
  });
}

/**
 * A short text block before a chart usually introduces it, so start a new page rather
 * than leave the text at the bottom of one page and its chart on the next.
 */
function keepWithChart(doc, nodes) {
  const textHeight = measureText(doc, nodes);
  const bodyHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  if (textHeight < bodyHeight / 3) ensureSpace(doc, textHeight + LEGEND_HEIGHT + CHART_HEIGHT + 24);
}

/** Approximate height of a text block, using the same fonts and widths as drawText. */
function measureText(doc, nodes) {
  const width = contentWidth(doc);
  const plain = (runs) => runs.map((run) => run.text).join('');
  let height = 0;
  for (const node of nodes) {
    if (node.type === 'heading') {
      doc.font('Helvetica-Bold').fontSize(HEADING_SIZES[node.level]);
      height += doc.heightOfString(plain(node.runs), { width, lineGap: 2 });
    } else if (node.type === 'paragraph') {
      doc.font('Helvetica').fontSize(BODY_SIZE);
      height += doc.heightOfString(plain(node.runs), { width, lineGap: 2 });
    } else if (node.type === 'list') {
      doc.font('Helvetica').fontSize(BODY_SIZE);
      for (const runs of node.items) height += doc.heightOfString(plain(runs), { width: width - 18, lineGap: 2 }) + 3;
    }
    height += BODY_SIZE; // the half-line gap between nodes, rounded up
  }
  return height;
}

/** A parsed text block (see services/markup.js): headings, paragraphs and lists. */
function drawText(doc, nodes) {
  const width = contentWidth(doc);
  nodes.forEach((node, n) => {
    if (n > 0) doc.moveDown(0.5);
    if (node.type === 'heading') {
      const size = HEADING_SIZES[node.level];
      ensureSpace(doc, size * 1.4 + 40); // keep a heading with the first lines after it
      drawRuns(doc, node.runs, { x: MARGIN, width, size, bold: true });
    } else if (node.type === 'paragraph') {
      ensureSpace(doc, 30);
      drawRuns(doc, node.runs, { x: MARGIN, width, size: BODY_SIZE });
    } else if (node.type === 'list') {
      const indent = 18;
      node.items.forEach((runs, i) => {
        ensureSpace(doc, 18);
        if (i > 0) doc.moveDown(0.15);
        const y = doc.y;
        const marker = node.ordered ? `${node.start + i}.` : '\u2022';
        doc.font('Helvetica').fontSize(BODY_SIZE).fillColor(INK).text(marker, MARGIN, y, { width: indent - 4, align: 'right', lineBreak: false });
        doc.y = y;
        drawRuns(doc, runs, { x: MARGIN + indent, width: width - indent, size: BODY_SIZE });
      });
    }
  });
}

/** Styled runs as one wrapped paragraph. pdfkit carries layout options across `continued` calls. */
function drawRuns(doc, runs, { x, width, size, bold = false }) {
  const visible = runs.filter((run) => run.text !== '');
  doc.fillColor(INK).fontSize(size);
  visible.forEach((run, i) => {
    doc.font(fontFor(bold || run.bold, run.italic)).fillColor(run.href ? LINK_COLOR : INK);
    const options = { continued: i < visible.length - 1, link: run.href ?? null, underline: Boolean(run.href), lineGap: 2 };
    if (i === 0) doc.text(run.text, x, doc.y, { ...options, width });
    else doc.text(run.text, options);
  });
  doc.fillColor(INK);
}

function fontFor(bold, italic) {
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

function drawChart(doc, chart) {
  ensureSpace(doc, LEGEND_HEIGHT + CHART_HEIGHT + 12);
  const top = doc.y;
  const width = contentWidth(doc);
  const axisWidth = 50;
  const labelHeight = 30;
  const plot = { x: MARGIN + axisWidth, y: top + LEGEND_HEIGHT + 8, w: width - axisWidth, h: CHART_HEIGHT - labelHeight };
  const singleSeriesBar = chart.type === 'bar';
  const colorFor = (seriesIndex) => SERIES_COLORS[seriesIndex % SERIES_COLORS.length];

  // Legend (series names) and unit.
  let legendX = plot.x;
  doc.font('Helvetica').fontSize(9);
  chart.series.forEach((series, i) => {
    doc.rect(legendX, top + 3, 9, 9).fill(colorFor(i));
    doc.fillColor(INK).text(series.label, legendX + 13, top + 2, { lineBreak: false });
    legendX += 13 + doc.widthOfString(series.label) + 16;
  });
  doc.fillColor(MUTED).text(unitLabel(chart.unit), MARGIN, top + 2, { width, align: 'right', lineBreak: false });

  // Grid and y-axis ticks. Values below zero are clamped to the baseline.
  const values = chart.series.flatMap((s) => s.values).filter((v) => v != null);
  const max = niceCeiling(Math.max(0, ...values));
  const ticks = 5;
  const scaleY = (v) => plot.y + plot.h - (plot.h * Math.max(0, v)) / max;
  doc.fontSize(8);
  for (let i = 0; i <= ticks; i++) {
    const value = (max / ticks) * i;
    const y = scaleY(value);
    doc.moveTo(plot.x, y).lineTo(plot.x + plot.w, y).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.fillColor(MUTED).text(formatAxisValue(value, chart), MARGIN, y - 4, { width: axisWidth - 6, align: 'right', lineBreak: false });
  }

  const groupWidth = plot.w / chart.labels.length;
  if (chart.type === 'line') {
    chart.series.forEach((series, si) => {
      const points = series.values.map((v, i) => (v == null ? null : [plot.x + groupWidth * (i + 0.5), scaleY(v)]));
      let drawing = false;
      for (const point of points) {
        if (!point) {
          drawing = false;
        } else if (drawing) {
          doc.lineTo(...point);
        } else {
          doc.moveTo(...point);
          drawing = true;
        }
      }
      doc.lineWidth(2).strokeColor(colorFor(si)).stroke();
      for (const point of points) if (point) doc.circle(point[0], point[1], 2.5).fill(colorFor(si));
    });
  } else {
    const groupInner = groupWidth * 0.7;
    const barWidth = groupInner / chart.series.length;
    chart.series.forEach((series, si) => {
      series.values.forEach((v, i) => {
        if (v == null) return;
        const color = singleSeriesBar && i === chart.benchmarkIndex ? BENCHMARK_COLOR : colorFor(si);
        const x = plot.x + groupWidth * i + (groupWidth - groupInner) / 2 + barWidth * si;
        const y = scaleY(v);
        doc.rect(x, y, Math.max(barWidth - 1, 1), plot.y + plot.h - y).fill(color);
      });
    });
  }

  // Baseline and place labels.
  doc.moveTo(plot.x, plot.y + plot.h).lineTo(plot.x + plot.w, plot.y + plot.h).lineWidth(1).strokeColor(MUTED).stroke();
  doc.fontSize(8.5).fillColor(INK);
  chart.labels.forEach((label, i) => {
    doc.text(label, plot.x + groupWidth * i + 2, plot.y + plot.h + 5, {
      width: groupWidth - 4,
      height: labelHeight - 6,
      align: 'center',
      ellipsis: true,
    });
  });

  doc.x = MARGIN;
  doc.y = top + LEGEND_HEIGHT + 8 + CHART_HEIGHT;
}

function drawTable(doc, places, rows) {
  const width = contentWidth(doc);
  const firstColumn = Math.min(200, width * 0.36);
  const column = (width - firstColumn) / places.length;
  const padding = 5;
  const header = ['Indicator', ...places.map((p) => p.label)];

  const drawRow = (cells, { bold = false, fill = null } = {}) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    const cellWidth = (i) => (i === 0 ? firstColumn : column) - 8;
    const height = Math.max(...cells.map((text, i) => doc.heightOfString(text, { width: cellWidth(i) }))) + padding * 2;
    const y = doc.y;
    if (fill) doc.rect(MARGIN, y, width, height).fill(fill);
    cells.forEach((text, i) => {
      const x = i === 0 ? MARGIN : MARGIN + firstColumn + column * (i - 1);
      doc.fillColor(INK).text(text, x + 4, y + padding, { width: cellWidth(i), align: i === 0 ? 'left' : 'right' });
    });
    doc.moveTo(MARGIN, y + height).lineTo(MARGIN + width, y + height).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.x = MARGIN;
    doc.y = y + height;
  };

  ensureSpace(doc, 60);
  drawRow(header, { bold: true, fill: TABLE_HEADER_FILL });
  for (const row of rows) {
    if (ensureSpace(doc, 28)) drawRow(header, { bold: true, fill: TABLE_HEADER_FILL });
    drawRow([row.displayLabel, ...row.cells.map((cell) => cell.display)]);
  }
}

/** Source attribution and page number on every page. */
function drawFooters(doc, card) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the margin must not trigger a page break
    const y = doc.page.height - MARGIN - FOOTER_HEIGHT + 12;
    const width = contentWidth(doc);
    doc.moveTo(MARGIN, y - 6).lineTo(MARGIN + width, y - 6).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    doc.text(card.sourceLine, MARGIN, y, { width: width - 70 });
    doc.text(`Page ${i + 1} of ${range.count}`, MARGIN + width - 60, y, { width: 60, align: 'right' });
    doc.page.margins.bottom = bottomMargin;
  }
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/** Start a new page if the next block would cross the bottom margin. */
function ensureSpace(doc, height) {
  if (doc.y + height <= doc.page.height - doc.page.margins.bottom) return false;
  doc.addPage();
  return true;
}

/** Round up to 1, 2, 2.5 or 5 × 10^n so axis ticks land on readable values. */
function niceCeiling(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const nice = [1, 2, 2.5, 5, 10].find((step) => fraction <= step);
  return nice * magnitude;
}
