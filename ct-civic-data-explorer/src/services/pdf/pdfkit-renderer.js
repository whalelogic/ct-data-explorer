/**
 * pdfkit renderer: draws report data (title, then text, chart and table blocks in order, and the source footer) with
 * vector primitives. No headless browser and no network access. Output depends only
 * on the report data, so the same report and dataset version produce the same file.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { formatAxisValue, unitLabel } from '../../shared/format.js';
import { ACCENT, BENCHMARK_COLOR, HEADING, INK, LINK_COLOR, MUTED, RULE, SERIES_COLORS, TABLE_HEADER_FILL } from '../../shared/theme.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Brand fonts (Poppins, SIL OFL 1.1, from @fontsource/poppins), embedded and subset by
 * pdfkit. WOFF rather than WOFF2, because fontkit cannot subset WOFF2 glyph tables.
 * Read once at startup. Names: Body = Regular, Bold = SemiBold, Heading = ExtraBold.
 */
const FONT_FILES = {
  Body: 'poppins-latin-400-normal.woff',
  'Body-Italic': 'poppins-latin-400-italic.woff',
  'Body-Bold': 'poppins-latin-600-normal.woff',
  'Body-BoldItalic': 'poppins-latin-600-italic.woff',
  Heading: 'poppins-latin-800-normal.woff',
};
const FONTS = Object.fromEntries(
  Object.entries(FONT_FILES).map(([name, file]) => [name, readFileSync(require.resolve(`@fontsource/poppins/files/${file}`))]),
);
const LOGO = readFileSync(path.join(here, '..', '..', '..', 'public', 'img', 'ctdata-logo.png'));
const LOGO_HEIGHT = 30;

const MARGIN = 54;
const FOOTER_HEIGHT = 40;
const CHART_HEIGHT = 230;
const LEGEND_HEIGHT = 18;
const BODY_SIZE = 10.5;
const HEADING_SIZES = { 1: 15, 2: 13, 3: 11.5 };

/** @returns {Promise<Buffer>} */
export function renderWithPdfkit(report) {
  return new Promise((resolve, reject) => {
    const date = new Date(`${report.generatedOn}T12:00:00Z`);
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN + FOOTER_HEIGHT },
      bufferPages: true,
      info: {
        Title: report.title,
        Author: 'CT Data Collaborative',
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
      for (const [name, data] of Object.entries(FONTS)) doc.registerFont(name, data);
      drawLetterhead(doc);
      drawBody(doc, report);
      drawFooters(doc, report);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Logo and an orange separator rule at the top of the first page. */
function drawLetterhead(doc) {
  doc.image(LOGO, MARGIN, MARGIN - 18, { height: LOGO_HEIGHT });
  const y = MARGIN - 18 + LOGO_HEIGHT + 8;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + contentWidth(doc), y).lineWidth(2).strokeColor(ACCENT).stroke();
  doc.x = MARGIN;
  doc.y = y + 16;
}

function drawBody(doc, report) {
  const width = contentWidth(doc);
  if (report.showTitle) {
    doc.font('Heading').fontSize(20).fillColor(HEADING).text(report.title, MARGIN, doc.y, { width });
    if (report.subtitle) doc.moveDown(0.1).font('Body-Bold').fontSize(12).fillColor(INK).text(report.subtitle, { width });
    doc.moveDown(1);
  }
  report.blocks.forEach((block, i) => {
    const next = report.blocks[i + 1];
    if (block.type === 'text' && next?.type === 'chart') keepWithChart(doc, block.nodes);
    if (block.type === 'text') drawText(doc, block.nodes);
    else if (block.type === 'chart') drawChart(doc, block.chart);
    else if (block.type === 'table') drawTable(doc, report.places, block.indicators);
    else if (block.type === 'records') drawRecordTables(doc, block);
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
      doc.font('Body-Bold').fontSize(HEADING_SIZES[node.level]);
      height += doc.heightOfString(plain(node.runs), { width, lineGap: 2 });
    } else if (node.type === 'paragraph') {
      doc.font('Body').fontSize(BODY_SIZE);
      height += doc.heightOfString(plain(node.runs), { width, lineGap: 2 });
    } else if (node.type === 'list') {
      doc.font('Body').fontSize(BODY_SIZE);
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
      drawRuns(doc, node.runs, { x: MARGIN, width, size, bold: true, color: HEADING });
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
        doc.font('Body').fontSize(BODY_SIZE).fillColor(INK).text(marker, MARGIN, y, { width: indent - 4, align: 'right', lineBreak: false });
        doc.y = y;
        drawRuns(doc, runs, { x: MARGIN + indent, width: width - indent, size: BODY_SIZE });
      });
    }
  });
}

/** Styled runs as one wrapped paragraph. pdfkit carries layout options across `continued` calls. */
function drawRuns(doc, runs, { x, width, size, bold = false, color = INK }) {
  const visible = runs.filter((run) => run.text !== '');
  doc.fillColor(color).fontSize(size);
  visible.forEach((run, i) => {
    doc.font(fontFor(bold || run.bold, run.italic)).fillColor(run.href ? LINK_COLOR : color);
    const options = { continued: i < visible.length - 1, link: run.href ?? null, underline: Boolean(run.href), lineGap: 2 };
    if (i === 0) doc.text(run.text, x, doc.y, { ...options, width });
    else doc.text(run.text, options);
  });
  doc.fillColor(INK);
}

function fontFor(bold, italic) {
  if (bold && italic) return 'Body-BoldItalic';
  if (bold) return 'Body-Bold';
  if (italic) return 'Body-Italic';
  return 'Body';
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
  doc.font('Body').fontSize(9);
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
    doc.font(bold ? 'Body-Bold' : 'Body').fontSize(9.5);
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

/** Wide source data is split into readable tables, repeating Town in each part. */
function drawRecordTables(doc, block) {
  const repeated = block.repeatColumns ?? [0];
  const otherColumns = block.columns.map((_, i) => i).filter((i) => !repeated.includes(i));
  const perPart = 4 - repeated.length;
  for (let start = 0; start < otherColumns.length; start += perPart) {
    const indices = [...repeated, ...otherColumns.slice(start, start + perPart)];
    const cellWidth = contentWidth(doc) / indices.length;
    const header = indices.map((i) => block.columns[i].label);
    const measure = (text) => doc.heightOfString(text || ' ', { width: cellWidth - 10 });
    const draw = (values, bold = false) => {
      doc.font(bold ? 'Body-Bold' : 'Body').fontSize(9);
      const height = Math.max(...values.map(measure)) + 10;
      const top = doc.y;
      if (bold) doc.rect(MARGIN, top, contentWidth(doc), height).fill(TABLE_HEADER_FILL);
      values.forEach((value, i) => doc.fillColor(INK).text(value, MARGIN + i * cellWidth + 5, top + 5, { width: cellWidth - 10 }));
      doc.moveTo(MARGIN, top + height).lineTo(MARGIN + contentWidth(doc), top + height).strokeColor(RULE).stroke();
      doc.x = MARGIN;
      doc.y = top + height;
    };
    doc.font('Body-Bold').fontSize(9);
    const headerHeight = Math.max(...header.map(measure)) + 10;
    ensureSpace(doc, headerHeight + 35);
    draw(header, true);
    for (const record of block.records) {
      let remaining = indices.map((i) => record.values[i]);
      while (remaining.some((value) => value.length)) {
        doc.font('Body').fontSize(9);
        let available = doc.page.height - doc.page.margins.bottom - doc.y - 10;
        if (available < 25) { doc.addPage(); draw(header, true); doc.font('Body').fontSize(9); available = doc.page.height - doc.page.margins.bottom - doc.y - 10; }
        const fullHeight = Math.max(...remaining.map(measure));
        const pageCapacity = doc.page.height - doc.page.margins.top - doc.page.margins.bottom - headerHeight - 10;
        if (fullHeight > available && fullHeight <= pageCapacity) {
          doc.addPage(); draw(header, true); continue;
        }
        const parts = remaining.map((text) => {
          if (measure(text) <= available) return text;
          let low = 0, high = text.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (measure(text.slice(0, middle)) <= available) low = middle;
            else high = middle - 1;
          }
          return text.slice(0, Math.max(1, low));
        });
        draw(parts);
        remaining = remaining.map((text, i) => text.slice(parts[i].length));
      }
    }
    doc.moveDown(1);
  }
}

/** Source attribution and page number on every page. */
function drawFooters(doc, report) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the margin must not trigger a page break
    const y = doc.page.height - MARGIN - FOOTER_HEIGHT + 12;
    const width = contentWidth(doc);
    doc.moveTo(MARGIN, y - 6).lineTo(MARGIN + width, y - 6).lineWidth(1).strokeColor(ACCENT).stroke();
    doc.font('Body-Italic').fontSize(7.5).fillColor(MUTED);
    doc.text(report.sourceLine, MARGIN, y, { width: width - 70 });
    doc.font('Body').text(`Page ${i + 1} of ${range.count}`, MARGIN + width - 60, y, { width: 60, align: 'right' });
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
