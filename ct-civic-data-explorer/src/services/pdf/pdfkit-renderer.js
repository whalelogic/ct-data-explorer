/**
 * Draw report titles, text, charts, tables, and source footers with PDFKit.
 * Rendering uses local fonts and report data, so the same report produces the
 * same PDF without a browser or network request.
 */
import PDFDocument from 'pdfkit';
import { resolveReportStyle } from '../../shared/report-style.js';
import { fileURLToPath } from 'node:url';
import { formatAxisValue, formatValue, unitLabel } from '../../shared/format.js';
import { HttpError } from '../../lib/http-error.js';
import {
  INK,
  MUTED,
  RULE,
} from '../../shared/theme.js';

const FONT_STYLES = ['Regular', 'SemiBold', 'Bold', 'ExtraBold', 'Italic', 'BoldItalic'];
const MARGIN = 54;
const FOOTER_HEIGHT = 40;
const CHART_HEIGHT = 230;
const LEGEND_HEIGHT = 18;
// Up to this many rows, a chart is drawn as upright bars with the row names beneath.
const CHART_PLACES_PER_PART = 6;
// Line charts with more rows are split into parts of this many points.
const LINE_POINTS_PER_PART = 12;
// Up to this many rows, a table has one column per row; beyond it, one line per row.
const TABLE_PLACES_PER_PART = 4;
const TABLE_FIELDS_PER_PART = 5;
/**
 * Rendering is synchronous, so an unbounded report would hold up every other request
 * while it is drawn. Reports this long are not readable on paper either.
 */
export const MAX_PDF_PAGES = 500;
const CHART_LABEL_LINES = 3;
const BODY_SIZE = 10.5;

function bodySize(document) {
  return document.reportStyle.textSize === 'large' ? 12 : BODY_SIZE;
}
const HEADING_SIZES = { 1: 15, 2: 13, 3: 11.5 };

/** @returns {Promise<Buffer>} */
export function renderWithPdfkit(report) {
  return new Promise((resolve, reject) => {
    const generatedDate = new Date(`${report.generatedOn}T12:00:00Z`);
    const document = new PDFDocument({
      size: 'LETTER',
      margins: {
        top: MARGIN,
        left: MARGIN,
        right: MARGIN,
        bottom: MARGIN + FOOTER_HEIGHT,
      },
      bufferPages: true,
      // Screen readers announce the language; viewers show the report title, not the file name.
      lang: 'en-US',
      displayTitle: true,
      info: {
        Title: report.title,
        Author: 'CTData Collaborative',
        Creator: 'CT Civic Data Explorer',
        CreationDate: generatedDate,
        ModDate: generatedDate,
      },
    });

    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    let pages = 1;
    document.on('pageAdded', () => {
      pages += 1;
      if (pages > MAX_PDF_PAGES) {
        throw new HttpError(
          422,
          `This report would be longer than ${MAX_PDF_PAGES} pages. Choose fewer rows or fields, or remove a chart or table, then download it again.`,
        );
      }
    });

    try {
      for (const style of FONT_STYLES) {
        const fontName = `Poppins-${style}`;
        const fontUrl = new URL(`../../../public/fonts/${fontName}.ttf`, import.meta.url);
        document.registerFont(fontName, fileURLToPath(fontUrl));
      }

      document.reportStyle = resolveReportStyle(report.style);
      document.rowWords = rowWords(report.rowNoun);
      document.font('Poppins-Regular');
      drawBody(document, report);
      drawFooters(document, report);
      document.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * What rows are called in headings. Town reports can mix towns, counties and the state,
 * so they keep the neutral "location"; other datasets use their own row name ("Industry").
 */
function rowWords(rowNoun) {
  if (!rowNoun || rowNoun === 'Town' || rowNoun === 'Row') {
    const word = rowNoun === 'Row' ? 'Row' : 'Location';
    return { singular: word, plural: `${word}s` };
  }
  let plural = `${rowNoun}s`;
  if (/[^aeiou]y$/i.test(rowNoun)) {
    plural = `${rowNoun.slice(0, -1)}ies`;
  } else if (/s$/i.test(rowNoun)) {
    plural = rowNoun;
  }
  return { singular: rowNoun, plural };
}

function drawBody(document, report) {
  const width = contentWidth(document);
  const hasDataTable = report.blocks.some((block) => block.type === 'table' || block.type === 'records');

  if (report.showTitle) {
    document.font('Poppins-ExtraBold');
    document.fontSize(20);
    document.fillColor(document.reportStyle.headingColor);
    document.text(report.title, MARGIN, document.y, { width });

    if (report.subtitle) {
      document.moveDown(0.2);
      document.font('Poppins-Regular');
      document.fontSize(12);
      document.fillColor(MUTED);
      document.text(report.subtitle, { width });
    }

    document.moveDown(1);
  }
  if (report.summaries?.length) {
    drawSummaries(document, report.summaries);
  }

  for (let blockIndex = 0; blockIndex < report.blocks.length; blockIndex++) {
    const block = report.blocks[blockIndex];
    const nextBlock = report.blocks[blockIndex + 1];

    if (block.type === 'text' && nextBlock?.type === 'chart') {
      keepWithChart(document, block.nodes);
    }

    if (block.type === 'text') {
      drawText(document, block.nodes);
    } else if (block.type === 'chart') {
      drawChart(document, block.chart, !hasDataTable);
    } else if (block.type === 'table') {
      drawTable(document, report.places, block.indicators);
    } else if (block.type === 'records') {
      drawRecordTables(document, block);
    }

    document.x = MARGIN;
    document.moveDown(document.reportStyle.spacing === 'compact' ? 0.5 : 1);
  }
}

/**
 * Report-wide values (e.g. average population per town) side by side, up to three per line:
 * label, value, then how it was worked out.
 */
function drawSummaries(document, summaries) {
  const width = contentWidth(document);
  const perLine = Math.min(3, summaries.length);
  const gap = 18;
  const cellWidth = (width - gap * (perLine - 1)) / perLine;
  const size = bodySize(document);
  // Label, the figure, a plain line, then the Connecticut figure: no working on the page.
  const parts = (summary) => [
    { text: summary.label.toUpperCase(), font: 'Poppins-Bold', size: size - 2, color: MUTED },
    { text: summary.display, font: 'Poppins-ExtraBold', size: 24, color: document.reportStyle.headingColor },
    { text: summary.detail ?? '', font: 'Poppins-Regular', size: size - 1, color: MUTED },
    ...(summary.benchmark ? [
      { text: summary.benchmark.display, font: 'Poppins-Bold', size: size + 2, color: INK, gap: 6 },
      { text: summary.benchmark.label, font: 'Poppins-Regular', size: size - 1, color: MUTED },
    ] : []),
  ];
  const heightOf = (summary) => parts(summary).reduce((total, part) => {
    document.font(part.font).fontSize(part.size);
    return total + (part.gap ?? 0) + document.heightOfString(part.text, { width: cellWidth });
  }, 0);

  for (let start = 0; start < summaries.length; start += perLine) {
    const line = summaries.slice(start, start + perLine);
    const lineHeight = Math.max(...line.map(heightOf));
    ensureSpace(document, lineHeight + 12);
    const top = document.y;
    line.forEach((summary, index) => {
      let y = top;
      for (const part of parts(summary)) {
        y += part.gap ?? 0;
        document.font(part.font).fontSize(part.size).fillColor(part.color);
        document.text(part.text, MARGIN + index * (cellWidth + gap), y, { width: cellWidth });
        y = document.y;
      }
    });
    document.x = MARGIN;
    document.y = top + lineHeight + 12;
  }
  document.moveDown(0.4);
}

/** Keep a short introduction on the same page as the chart that follows it. */
function keepWithChart(document, nodes) {
  const textHeight = measureText(document, nodes);
  const bodyHeight = document.page.height - document.page.margins.top - document.page.margins.bottom;

  if (textHeight < bodyHeight / 3) {
    ensureSpace(document, textHeight + LEGEND_HEIGHT + CHART_HEIGHT + 24);
  }
}

function plainText(runs) {
  return runs.map((run) => run.text).join('');
}

/** Estimate text height using the fonts and widths used by drawText. */
function measureText(document, nodes) {
  const width = contentWidth(document);
  let height = 0;

  for (const node of nodes) {
    if (node.type === 'heading') {
      document.font('Poppins-Bold');
      document.fontSize(HEADING_SIZES[node.level]);
      height += document.heightOfString(plainText(node.runs), { width, lineGap: 2 });
    } else if (node.type === 'paragraph') {
      document.font('Poppins-Regular');
      document.fontSize(bodySize(document));
      height += document.heightOfString(plainText(node.runs), { width, lineGap: 2 });
    } else if (node.type === 'list') {
      document.font('Poppins-Regular');
      document.fontSize(bodySize(document));

      for (const runs of node.items) {
        height += document.heightOfString(plainText(runs), { width: width - 18, lineGap: 2 }) + 3;
      }
    }

    // Round up the half-line gap between text nodes.
    height += bodySize(document);
  }

  return height;
}

/** Draw headings, paragraphs, and lists parsed by services/markup.js. */
function drawText(document, nodes) {
  const width = contentWidth(document);

  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex];
    if (nodeIndex > 0) {
      document.moveDown(0.5);
    }

    if (node.type === 'heading') {
      const size = HEADING_SIZES[node.level];
      // Keep a heading with the first lines that follow it.
      ensureSpace(document, size * 1.4 + 40);
      drawRuns(document, node.runs, { x: MARGIN, width, size, bold: true, color: document.reportStyle.headingColor });
    } else if (node.type === 'paragraph') {
      ensureSpace(document, 30);
      drawRuns(document, node.runs, { x: MARGIN, width, size: bodySize(document) });
    } else if (node.type === 'list') {
      drawList(document, node, width);
    }
  }
}

function drawList(document, node, width) {
  const indent = 18;

  for (let itemIndex = 0; itemIndex < node.items.length; itemIndex++) {
    ensureSpace(document, 18);
    if (itemIndex > 0) {
      document.moveDown(0.15);
    }

    const y = document.y;
    const marker = node.ordered ? `${node.start + itemIndex}.` : '\u2022';
    document.font('Poppins-Regular');
    document.fontSize(bodySize(document));
    document.fillColor(INK);
    document.text(marker, MARGIN, y, {
      width: indent - 4,
      align: 'right',
      lineBreak: false,
    });
    document.y = y;
    drawRuns(document, node.items[itemIndex], {
      x: MARGIN + indent,
      width: width - indent,
      size: bodySize(document),
    });
  }
}

/** Draw one wrapped paragraph; PDFKit keeps options between continued runs. */
function drawRuns(document, runs, { x, width, size, bold = false, color = INK }) {
  const visibleRuns = runs.filter((run) => run.text !== '');
  document.fillColor(INK);
  document.fontSize(size);

  for (let runIndex = 0; runIndex < visibleRuns.length; runIndex++) {
    const run = visibleRuns[runIndex];
    document.font(fontFor(bold || run.bold, run.italic));
    document.fillColor(run.href ? document.reportStyle.headingColor : color);

    const options = {
      continued: runIndex < visibleRuns.length - 1,
      link: run.href ?? null,
      underline: Boolean(run.href),
      lineGap: 2,
    };

    if (runIndex === 0) {
      document.text(run.text, x, document.y, { ...options, width });
    } else {
      document.text(run.text, options);
    }
  }

  document.fillColor(INK);
}

function fontFor(bold, italic) {
  if (bold && italic) {
    return 'Poppins-BoldItalic';
  }
  if (bold) {
    return 'Poppins-Bold';
  }
  if (italic) {
    return 'Poppins-Italic';
  }
  return 'Poppins-Regular';
}

/** A color chosen for this series in the builder wins over the report palette. */
function seriesColor(document, seriesIndex, series) {
  if (series?.color) {
    return series.color;
  }
  const palette = document.reportStyle.palette;
  return palette[seriesIndex % palette.length];
}

function chartY(plot, value, scale) {
  return plot.y + plot.height - (plot.height * (value - scale.minimum)) / (scale.maximum - scale.minimum);
}

function drawChart(document, chart, includeLabelKey) {
  let minimum = 0;
  let maximum = 0;
  for (const series of chart.series) {
    for (const value of series.values) {
      if (value == null) {
        continue;
      }
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  const scale = {
    minimum: minimum < 0 ? -niceCeiling(-minimum) : 0,
    maximum: maximum > 0 || minimum === 0 ? niceCeiling(maximum) : 0,
  };
  const labelReferences = [];
  const isLong = chart.labels.length > CHART_PLACES_PER_PART;

  if (isLong && chart.type !== 'line') {
    // Many rows read best as a ranked-style list: one line per row, bars running across.
    labelReferences.push(...drawBarList(document, chart, scale));
  }
  const perPart = isLong ? LINE_POINTS_PER_PART : CHART_PLACES_PER_PART;

  // Use the same scale for every part so pages can be compared fairly.
  for (let start = 0; start < chart.labels.length && (!isLong || chart.type === 'line'); start += perPart) {
    const end = Math.min(start + perPart, chart.labels.length);
    const part = {
      ...chart,
      labels: chart.labels.slice(start, end),
      benchmarkIndex: chart.benchmarkIndex - start,
      series: chart.series.map((series) => ({ ...series, values: series.values.slice(start, end) })),
    };
    const range = isLong ? `${document.rowWords.plural} ${start + 1}-${end} of ${chart.labels.length}` : '';
    const shortenedLabels = drawChartPart(document, part, scale, range);
    for (const labelIndex of shortenedLabels) {
      labelReferences.push({ number: start + labelIndex + 1, label: part.labels[labelIndex] });
    }
    document.moveDown(1);
  }

  if (includeLabelKey && labelReferences.length > 0) {
    drawChartLabelKey(document, labelReferences);
  }
}

function chartLegendLayout(document, chart, width) {
  const columnWidth = width / 2;
  const rows = [];
  document.font('Poppins-Regular');
  document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
  // One series is already named by the chart title (or the line beneath a custom title).
  const seriesCount = chart.series.length > 1 ? chart.series.length : 0;
  for (let start = 0; start < seriesCount; start += 2) {
    const series = chart.series.slice(start, start + 2);
    const height = Math.max(...series.map((item) => document.heightOfString(item.label, { width: columnWidth - 26 }))) + 8;
    rows.push({ series, height, start });
  }
  return { rows, columnWidth, height: rows.reduce((total, row) => total + row.height, 0) };
}

function drawChartPart(document, chart, scale, range) {
  const width = contentWidth(document);
  const title = chart.title || chart.series.map((series) => series.label).join(', ');
  document.font('Poppins-Bold');
  document.fontSize(12);
  const titleHeight = document.heightOfString(title, { width }) + 8;
  // A custom chart title keeps the plotted fields visible as a muted line beneath it.
  const detail = [chart.subtitle, range].filter(Boolean).join(' · ');
  document.font('Poppins-Regular');
  document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
  const detailHeight = detail ? document.heightOfString(detail, { width }) + 6 : 0;
  const legend = chartLegendLayout(document, chart, width);
  const axisWidth = 50;
  const groupWidth = (width - axisWidth) / chart.labels.length;
  document.fontSize(8.5);
  const maximumLabelHeight = document.currentLineHeight(true) * CHART_LABEL_LINES;
  const labelHeights = chart.labels.map((label) => document.heightOfString(label, { width: groupWidth - 4 }));
  const labelHeight = Math.min(maximumLabelHeight, Math.max(20, ...labelHeights)) + 10;
  const shortenedLabels = [];
  for (let labelIndex = 0; labelIndex < labelHeights.length; labelIndex++) {
    if (labelHeights[labelIndex] > maximumLabelHeight) {
      shortenedLabels.push(labelIndex);
    }
  }
  const headingHeight = titleHeight + detailHeight + legend.height + 20;
  // The subtitle line comes out of the plot, so a chart takes the same page space either way.
  const plotHeight = CHART_HEIGHT - 30 - detailHeight;
  ensureSpace(document, headingHeight + plotHeight + labelHeight + 12);
  const top = document.y;
  document.font('Poppins-Bold');
  document.fontSize(12);
  document.fillColor(document.reportStyle.headingColor);
  document.text(title, MARGIN, top, { width });
  let headingY = top + titleHeight;
  if (detail) {
    document.font('Poppins-Regular');
    document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
    document.fillColor(MUTED);
    document.text(detail, MARGIN, headingY - 4, { width });
    headingY += detailHeight;
  }
  drawChartLegend(document, legend, headingY);
  headingY += legend.height;
  document.font('Poppins-Regular');
  document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
  document.fillColor(MUTED);
  document.text(unitLabel(chart.unit), MARGIN + axisWidth, headingY, { width: width - axisWidth });
  const plot = {
    x: MARGIN + axisWidth,
    y: top + headingHeight,
    width: width - axisWidth,
    height: plotHeight,
  };
  const tickCount = 5;
  document.fontSize(8);

  for (let tickIndex = 0; tickIndex <= tickCount; tickIndex++) {
    const value = scale.minimum + ((scale.maximum - scale.minimum) / tickCount) * tickIndex;
    const y = chartY(plot, value, scale);
    document.moveTo(plot.x, y);
    document.lineTo(plot.x + plot.width, y);
    document.lineWidth(0.5);
    document.strokeColor(RULE);
    document.stroke();
    document.fillColor(MUTED);
    document.text(formatAxisValue(value, chart), MARGIN, y - 4, {
      width: axisWidth - 6,
      align: 'right',
      lineBreak: false,
    });
  }

  if (scale.minimum < 0 && scale.maximum > 0) {
    const baselineY = chartY(plot, 0, scale);
    document.moveTo(plot.x, baselineY);
    document.lineTo(plot.x + plot.width, baselineY);
    document.lineWidth(1);
    document.strokeColor(MUTED);
    document.stroke();
  }

  if (chart.type === 'line') {
    drawChartLines(document, chart, plot, groupWidth, scale);
  } else {
    drawChartBars(document, chart, plot, groupWidth, scale);
  }

  // Draw the baseline and place labels after the chart data.
  document.moveTo(plot.x, plot.y + plot.height);
  document.lineTo(plot.x + plot.width, plot.y + plot.height);
  document.lineWidth(1);
  document.strokeColor(MUTED);
  document.stroke();
  document.fontSize(8.5);
  document.fillColor(INK);

  for (let labelIndex = 0; labelIndex < chart.labels.length; labelIndex++) {
    document.text(chart.labels[labelIndex], plot.x + groupWidth * labelIndex + 2, plot.y + plot.height + 5, {
      width: groupWidth - 4,
      height: labelHeight - 10,
      ellipsis: true,
      align: 'center',
    });
  }

  document.x = MARGIN;
  document.y = plot.y + plot.height + labelHeight;
  return shortenedLabels;
}

/**
 * A chart of many rows: one line per row with its bars running left to right and the
 * value written at the end, continued over as many pages as it needs. Every page repeats
 * the title, the scale and which rows it shows.
 * @returns {{ number: number, label: string }[]} rows whose name had to be shortened
 */
function drawBarList(document, chart, scale) {
  const width = contentWidth(document);
  const small = document.reportStyle.textSize === 'large' ? 10.5 : 9;
  const title = chart.title || chart.series.map((series) => series.label).join(', ');
  const total = chart.labels.length;
  const seriesCount = chart.series.length;
  const barHeight = seriesCount === 1 ? 8 : 6;
  const rowHeight = Math.max(15, seriesCount * (barHeight + 1) + 6);
  const labelWidth = Math.min(160, width * 0.32);
  const valueWidth = 52;
  const plot = { x: MARGIN + labelWidth, width: width - labelWidth - valueWidth };
  const xOf = (value) => plot.x + (plot.width * (value - scale.minimum)) / (scale.maximum - scale.minimum);
  const legend = chartLegendLayout(document, chart, width);
  const shortened = [];
  const tickCount = 4;
  const axisHeight = 14;

  document.font('Poppins-Bold').fontSize(12);
  const titleHeight = document.heightOfString(title, { width }) + 8;

  let start = 0;
  while (start < total) {
    document.font('Poppins-Regular').fontSize(small);
    // The range line is at most as tall as its longest form, so measure that.
    const detailOf = (from, to) => {
      // A chart that fits in one piece does not need to say which rows it shows.
      const range = to - from + 1 < total ? `${document.rowWords.plural} ${from}-${to} of ${total}` : '';
      return [chart.subtitle, unitLabel(chart.unit), range].filter(Boolean).join(' · ');
    };
    const detailHeight = document.heightOfString(detailOf(total, total), { width }) + 6;
    const headingHeight = titleHeight + detailHeight + legend.height + axisHeight + 4;
    const bottom = document.page.height - document.page.margins.bottom;
    let fitting = Math.floor((bottom - document.y - headingHeight - 6) / rowHeight);
    if (fitting < Math.min(5, total - start)) {
      document.addPage();
      fitting = Math.floor((bottom - document.y - headingHeight - 6) / rowHeight);
    }
    const end = Math.min(total, start + Math.max(1, fitting));
    const top = document.y;

    document.font('Poppins-Bold').fontSize(12).fillColor(document.reportStyle.headingColor);
    document.text(title, MARGIN, top, { width });
    document.font('Poppins-Regular').fontSize(small).fillColor(MUTED);
    document.text(detailOf(start + 1, end), MARGIN, top + titleHeight - 4, { width });
    drawChartLegend(document, legend, top + titleHeight + detailHeight);

    const axisY = top + titleHeight + detailHeight + legend.height;
    const rowsTop = axisY + axisHeight + 4;
    const rowsBottom = rowsTop + (end - start) * rowHeight;
    document.fontSize(8);
    for (let tickIndex = 0; tickIndex <= tickCount; tickIndex++) {
      const value = scale.minimum + ((scale.maximum - scale.minimum) / tickCount) * tickIndex;
      const x = xOf(value);
      document.moveTo(x, rowsTop - 2).lineTo(x, rowsBottom).lineWidth(0.5).strokeColor(RULE).stroke();
      let align = 'center';
      if (tickIndex === 0) align = 'left';
      if (tickIndex === tickCount) align = 'right';
      const offsets = { left: 0, center: -30, right: -60 };
      document.fillColor(MUTED);
      document.text(formatAxisValue(value, chart), x + offsets[align], axisY, { width: 60, align, lineBreak: false });
    }

    for (let index = start; index < end; index++) {
      const y = rowsTop + (index - start) * rowHeight;
      const label = chart.labels[index];
      document.font('Poppins-Regular').fontSize(8.5).fillColor(INK);
      const lineHeight = document.currentLineHeight(true);
      if (document.widthOfString(label) > labelWidth - 8) {
        shortened.push({ number: index + 1, label });
      }
      document.text(label, MARGIN, y + (rowHeight - lineHeight) / 2, {
        width: labelWidth - 8,
        height: lineHeight,
        ellipsis: true,
      });

      for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex++) {
        const series = chart.series[seriesIndex];
        const value = series.values[index];
        const barY = y + (rowHeight - seriesCount * (barHeight + 1) + 1) / 2 + seriesIndex * (barHeight + 1);
        const zeroX = xOf(0);
        document.font('Poppins-Regular').fontSize(seriesCount === 1 ? 8 : 6.5).fillColor(value == null ? MUTED : INK);
        const textY = barY + (barHeight - document.currentLineHeight(true)) / 2;
        if (value == null) {
          document.text('N/A', zeroX + 4, textY, { width: valueWidth, lineBreak: false });
          continue;
        }
        let color = seriesColor(document, seriesIndex, series);
        if (chart.type === 'bar' && index === chart.benchmarkIndex) {
          color = document.reportStyle.benchmarkColor;
        }
        const valueX = xOf(value);
        document.rect(Math.min(zeroX, valueX), barY, Math.max(Math.abs(valueX - zeroX), 0.75), barHeight).fill(color);
        document.fillColor(INK);
        const adaptive = chart.decimals == null || chart.decimals >= 9;
        const decimals = adaptive ? (Math.abs(value) >= 1 || value === 0 ? 2 : 4) : chart.decimals;
        document.text(formatValue(value, { unit: chart.unit, decimals }), Math.max(zeroX, valueX) + 4, textY, {
          width: valueWidth + plot.x + plot.width - Math.max(zeroX, valueX) - 4,
          lineBreak: false,
        });
      }
    }

    const zeroX = xOf(0);
    document.moveTo(zeroX, rowsTop - 2).lineTo(zeroX, rowsBottom).lineWidth(1).strokeColor(MUTED).stroke();
    document.x = MARGIN;
    document.y = rowsBottom + 6;
    start = end;
    if (start < total) {
      document.addPage();
    }
  }
  document.moveDown(1);
  return shortened;
}

/** Keep full category names available when a chart has no accompanying table. */
function drawChartLabelKey(document, labelReferences) {
  ensureSpace(document, 60);
  document.font('Poppins-SemiBold');
  document.fontSize(10);
  document.fillColor(INK);
  document.text(`Full ${document.rowWords.singular.toLowerCase()} labels`, MARGIN, document.y, { width: contentWidth(document) });
  for (const reference of labelReferences) {
    document.moveDown(0.4);
    ensureSpace(document, 30);
    document.font('Poppins-Regular');
    document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
    document.fillColor(INK);
    document.text(`${reference.number}. ${reference.label}`, MARGIN, document.y, { width: contentWidth(document) });
  }
}

function drawChartLegend(document, legend, top) {
  document.font('Poppins-Regular');
  document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
  for (const row of legend.rows) {
    for (let column = 0; column < row.series.length; column++) {
      const x = MARGIN + column * legend.columnWidth;
      document.rect(x, top + 3, 9, 9);
      document.fill(seriesColor(document, row.start + column, row.series[column]));
      document.fillColor(INK);
      document.text(row.series[column].label, x + 13, top + 2, { width: legend.columnWidth - 26 });
    }
    top += row.height;
  }
}

function drawChartLines(document, chart, plot, groupWidth, scale) {
  for (let seriesIndex = 0; seriesIndex < chart.series.length; seriesIndex++) {
    const series = chart.series[seriesIndex];
    const points = [];

    for (let valueIndex = 0; valueIndex < series.values.length; valueIndex++) {
      const value = series.values[valueIndex];
      if (value == null) {
        points.push(null);
      } else {
        const x = plot.x + groupWidth * (valueIndex + 0.5);
        points.push([x, chartY(plot, value, scale)]);
      }
    }

    let drawingLine = false;
    for (const point of points) {
      if (!point) {
        drawingLine = false;
      } else if (drawingLine) {
        document.lineTo(...point);
      } else {
        document.moveTo(...point);
        drawingLine = true;
      }
    }

    document.lineWidth(2);
    document.strokeColor(seriesColor(document, seriesIndex, series));
    document.stroke();

    for (const point of points) {
      if (point) {
        document.circle(point[0], point[1], 2.5);
        document.fill(seriesColor(document, seriesIndex, series));
      }
    }
  }
}

function drawChartBars(document, chart, plot, groupWidth, scale) {
  const groupInnerWidth = groupWidth * 0.7;
  const barWidth = groupInnerWidth / chart.series.length;

  for (let seriesIndex = 0; seriesIndex < chart.series.length; seriesIndex++) {
    const series = chart.series[seriesIndex];

    for (let valueIndex = 0; valueIndex < series.values.length; valueIndex++) {
      const value = series.values[valueIndex];
      if (value == null) {
        continue;
      }

      let color = seriesColor(document, seriesIndex, series);
      if (chart.type === 'bar' && valueIndex === chart.benchmarkIndex) {
        color = document.reportStyle.benchmarkColor;
      }

      const x = plot.x + groupWidth * valueIndex + (groupWidth - groupInnerWidth) / 2 + barWidth * seriesIndex;
      const valueY = chartY(plot, value, scale);
      const baselineY = chartY(plot, 0, scale);
      document.rect(x, Math.min(valueY, baselineY), Math.max(barWidth - 1, 1), Math.abs(baselineY - valueY));
      document.fill(color);
    }
  }
}

function drawTable(document, places, rows) {
  if (places.length > TABLE_PLACES_PER_PART) {
    drawLongTable(document, places, rows);
    return;
  }
  const header = ['Field', ...places.map((place) => place.label)];
  const lines = rows.map((row) => [row.displayLabel, ...row.cells.map((cell) => cell.display)]);
  drawTablePart(document, header, lines, '');
  document.moveDown(0.6);
}

/**
 * A table of many rows: one line per row and one column per field, so it reads down the
 * page like a spreadsheet. More fields than fit across are continued in further tables
 * that repeat the row names.
 */
function drawLongTable(document, places, rows) {
  for (let start = 0; start < rows.length; start += TABLE_FIELDS_PER_PART) {
    const fields = rows.slice(start, start + TABLE_FIELDS_PER_PART);
    const header = [document.rowWords.singular, ...fields.map((row) => row.displayLabel)];
    const lines = places.map((place, placeIndex) => [place.label, ...fields.map((row) => row.cells[placeIndex].display)]);
    const heading = rows.length > TABLE_FIELDS_PER_PART
      ? `Fields ${start + 1}-${start + fields.length} of ${rows.length}`
      : '';
    drawTablePart(document, header, lines, heading);
    document.moveDown(0.6);
  }
}

/** Draw one table, repeating its header row at the top of every page it continues onto. */
function drawTablePart(document, header, lines, heading) {
  const width = contentWidth(document);
  const firstColumnWidth = Math.min(200, width * 0.36);
  const layout = {
    width,
    firstColumnWidth,
    valueColumnWidth: (width - firstColumnWidth) / Math.max(1, header.length - 1),
    padding: document.reportStyle.spacing === 'compact' ? 3 : 5,
  };
  const headerStyle = { bold: true, fill: document.reportStyle.tableHeaderColor };

  const headerHeight = tableRowHeight(document, header, layout, true);
  const rowHeights = lines.map((cells) => tableRowHeight(document, cells, layout));
  const headingHeight = heading ? 26 : 0;
  const groupHeight = headingHeight + headerHeight + rowHeights.reduce((total, height) => total + height, 0);
  const bodyHeight = document.page.height - document.page.margins.top - document.page.margins.bottom;
  // Keep a short table together; long tables still flow over pages.
  const requiredHeight = groupHeight <= bodyHeight ? groupHeight : headingHeight + headerHeight + (rowHeights[0] ?? 0);
  ensureSpace(document, requiredHeight);
  if (heading) {
    const top = document.y;
    document.font('Poppins-SemiBold');
    document.fontSize(10);
    document.fillColor(INK);
    document.text(heading, MARGIN, top);
    document.y = top + headingHeight;
  }
  drawTableRow(document, header, layout, headerStyle);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (ensureSpace(document, rowHeights[lineIndex])) {
      drawTableRow(document, header, layout, headerStyle);
    }
    drawTableRow(document, lines[lineIndex], layout);
  }
}

function tableCellWidth(layout, columnIndex) {
  const width = columnIndex === 0 ? layout.firstColumnWidth : layout.valueColumnWidth;
  return width - 8;
}

function tableRowHeight(document, cells, layout, bold = false) {
  document.font(bold ? 'Poppins-Bold' : 'Poppins-Regular');
  document.fontSize(document.reportStyle.textSize === 'large' ? 11 : 9.5);
  const cellHeights = cells.map((text, columnIndex) => {
    return document.heightOfString(text, { width: tableCellWidth(layout, columnIndex) });
  });
  return Math.max(...cellHeights) + layout.padding * 2;
}

function drawTableRow(document, cells, layout, { bold = false, fill = null } = {}) {
  const height = tableRowHeight(document, cells, layout, bold);
  const y = document.y;

  if (fill) {
    document.rect(MARGIN, y, layout.width, height);
    document.fill(fill);
  }

  for (let columnIndex = 0; columnIndex < cells.length; columnIndex++) {
    let x = MARGIN;
    if (columnIndex > 0) {
      x = MARGIN + layout.firstColumnWidth + layout.valueColumnWidth * (columnIndex - 1);
    }

    document.fillColor(INK);
    document.text(cells[columnIndex], x + 4, y + layout.padding, {
      width: tableCellWidth(layout, columnIndex),
      align: columnIndex === 0 ? 'left' : 'right',
    });
  }

  document.moveTo(MARGIN, y + height);
  document.lineTo(MARGIN + layout.width, y + height);
  document.lineWidth(0.5);
  document.strokeColor(RULE);
  document.stroke();
  document.x = MARGIN;
  document.y = y + height;
}

/** Split wide source data into smaller tables, repeating Town in each part. */
function drawRecordTables(document, block) {
  const repeatedColumns = block.repeatColumns ?? [0];
  const otherColumns = [];
  for (let columnIndex = 0; columnIndex < block.columns.length; columnIndex++) {
    if (!repeatedColumns.includes(columnIndex)) {
      otherColumns.push(columnIndex);
    }
  }

  const columnsPerPart = 4 - repeatedColumns.length;
  for (let start = 0; start < otherColumns.length; start += columnsPerPart) {
    const columnIndices = [...repeatedColumns, ...otherColumns.slice(start, start + columnsPerPart)];
    const cellWidth = contentWidth(document) / columnIndices.length;
    const header = columnIndices.map((columnIndex) => block.columns[columnIndex].label);

    document.font('Poppins-Bold');
    document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
    const headerHeight = recordRowHeight(document, header, cellWidth) + 10;
    ensureSpace(document, headerHeight + 35);
    drawRecordRow(document, header, cellWidth, true);

    for (const record of block.records) {
      let remainingValues = columnIndices.map((columnIndex) => record.values[columnIndex]);

      while (remainingValues.some((value) => value.length > 0)) {
        document.font('Poppins-Regular');
        document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
        let availableHeight = document.page.height - document.page.margins.bottom - document.y - 10;

        if (availableHeight < 25) {
          document.addPage();
          drawRecordRow(document, header, cellWidth, true);
          document.font('Poppins-Regular');
          document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
          availableHeight = document.page.height - document.page.margins.bottom - document.y - 10;
        }

        const fullHeight = recordRowHeight(document, remainingValues, cellWidth);
        const pageBodyHeight = document.page.height - document.page.margins.top - document.page.margins.bottom;
        const pageCapacity = pageBodyHeight - headerHeight - 10;
        if (fullHeight > availableHeight && fullHeight <= pageCapacity) {
          document.addPage();
          drawRecordRow(document, header, cellWidth, true);
          continue;
        }

        const visibleValues = remainingValues.map((text) => {
          return recordTextThatFits(document, text, cellWidth, availableHeight);
        });
        drawRecordRow(document, visibleValues, cellWidth);
        remainingValues = remainingValues.map((text, columnIndex) => {
          return text.slice(visibleValues[columnIndex].length);
        });
      }
    }

    document.moveDown(1);
  }
}

function recordPadding(document) {
  return document.reportStyle.spacing === 'compact' ? 3 : 5;
}

function recordCellHeight(document, text, cellWidth) {
  return document.heightOfString(text || ' ', { width: cellWidth - recordPadding(document) * 2 });
}

function recordRowHeight(document, values, cellWidth) {
  const cellHeights = values.map((text) => recordCellHeight(document, text, cellWidth));
  return Math.max(...cellHeights);
}

function drawRecordRow(document, values, cellWidth, bold = false) {
  document.font(bold ? 'Poppins-Bold' : 'Poppins-Regular');
  document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
  const height = recordRowHeight(document, values, cellWidth) + recordPadding(document) * 2;
  const top = document.y;

  if (bold) {
    document.rect(MARGIN, top, contentWidth(document), height);
    document.fill(document.reportStyle.tableHeaderColor);
  }

  for (let columnIndex = 0; columnIndex < values.length; columnIndex++) {
    document.fillColor(INK);
    document.text(values[columnIndex], MARGIN + columnIndex * cellWidth + recordPadding(document), top + recordPadding(document), {
      width: cellWidth - recordPadding(document) * 2,
    });
  }

  document.moveTo(MARGIN, top + height);
  document.lineTo(MARGIN + contentWidth(document), top + height);
  document.strokeColor(RULE);
  document.stroke();
  document.x = MARGIN;
  document.y = top + height;
}

/** Find the longest prefix that fits on the page using a binary search. */
function recordTextThatFits(document, text, cellWidth, availableHeight) {
  if (recordCellHeight(document, text, cellWidth) <= availableHeight) {
    return text;
  }

  let minimumLength = 0;
  let maximumLength = text.length;

  while (minimumLength < maximumLength) {
    const middleLength = Math.ceil((minimumLength + maximumLength) / 2);
    const prefixHeight = recordCellHeight(document, text.slice(0, middleLength), cellWidth);
    if (prefixHeight <= availableHeight) {
      minimumLength = middleLength;
    } else {
      maximumLength = middleLength - 1;
    }
  }

  return text.slice(0, Math.max(1, minimumLength));
}

/** Draw the source attribution and page number on every page. */
function drawFooters(document, report) {
  const pageRange = document.bufferedPageRange();

  for (let pageIndex = pageRange.start; pageIndex < pageRange.start + pageRange.count; pageIndex++) {
    document.switchToPage(pageIndex);
    const bottomMargin = document.page.margins.bottom;
    // Writing inside the footer margin must not trigger a page break.
    document.page.margins.bottom = 0;
    const y = document.page.height - MARGIN - FOOTER_HEIGHT + 12;
    const width = contentWidth(document);

    document.moveTo(MARGIN, y - 6);
    document.lineTo(MARGIN + width, y - 6);
    document.lineWidth(0.5);
    document.strokeColor(RULE);
    document.stroke();
    document.font('Poppins-Regular');
    document.fontSize(8);
    document.fillColor(MUTED);
    document.text(report.sourceLine, MARGIN, y, { width: width - 70 });
    document.text(`Page ${pageIndex + 1} of ${pageRange.count}`, MARGIN + width - 60, y, {
      width: 60,
      align: 'right',
    });

    document.page.margins.bottom = bottomMargin;
  }
}

function contentWidth(document) {
  return document.page.width - document.page.margins.left - document.page.margins.right;
}

/** Start a new page if the next block would cross the bottom margin. */
function ensureSpace(document, height) {
  if (document.y + height <= document.page.height - document.page.margins.bottom) {
    return false;
  }

  document.addPage();
  return true;
}

/** Round up to 1, 2, 2.5, or 5 times a power of ten for readable axis ticks. */
function niceCeiling(value) {
  if (value <= 0) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const niceFraction = [1, 2, 2.5, 5, 10].find((step) => fraction <= step);
  return niceFraction * magnitude;
}
