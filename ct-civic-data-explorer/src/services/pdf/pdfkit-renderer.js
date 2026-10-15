/**
 * Draw report titles, text, charts, tables, and source footers with PDFKit.
 * Rendering uses local fonts and report data, so the same report produces the
 * same PDF without a browser or network request.
 */
import PDFDocument from 'pdfkit';
import { resolveReportStyle } from '../../shared/report-style.js';
import { fileURLToPath } from 'node:url';
import { formatAxisValue, unitLabel } from '../../shared/format.js';
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
const CHART_PLACES_PER_PART = 6;
const TABLE_PLACES_PER_PART = 4;
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

    try {
      for (const style of FONT_STYLES) {
        const fontName = `Poppins-${style}`;
        const fontUrl = new URL(`../../../public/fonts/${fontName}.ttf`, import.meta.url);
        document.registerFont(fontName, fileURLToPath(fontUrl));
      }

      document.reportStyle = resolveReportStyle(report.style);
      document.font('Poppins-Regular');
      drawBody(document, report);
      drawFooters(document, report);
      document.end();
    } catch (error) {
      reject(error);
    }
  });
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

function seriesColor(document, seriesIndex) {
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

  // Use the same scale for every part so pages can be compared fairly.
  for (let start = 0; start < chart.labels.length; start += CHART_PLACES_PER_PART) {
    const end = Math.min(start + CHART_PLACES_PER_PART, chart.labels.length);
    const part = {
      ...chart,
      labels: chart.labels.slice(start, end),
      benchmarkIndex: chart.benchmarkIndex - start,
      series: chart.series.map((series) => ({ ...series, values: series.values.slice(start, end) })),
    };
    const range = chart.labels.length > CHART_PLACES_PER_PART ? `Locations ${start + 1}-${end} of ${chart.labels.length}` : '';
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
  for (let start = 0; start < chart.series.length; start += 2) {
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
  const headingHeight = titleHeight + (range ? 18 : 0) + legend.height + 20;
  const plotHeight = CHART_HEIGHT - 30;
  ensureSpace(document, headingHeight + plotHeight + labelHeight + 12);
  const top = document.y;
  document.font('Poppins-Bold');
  document.fontSize(12);
  document.fillColor(document.reportStyle.headingColor);
  document.text(title, MARGIN, top, { width });
  let headingY = top + titleHeight;
  if (range) {
    document.font('Poppins-Regular');
    document.fontSize(document.reportStyle.textSize === 'large' ? 10.5 : 9);
    document.fillColor(MUTED);
    document.text(range, MARGIN, headingY, { width });
    headingY += 18;
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

/** Keep full category names available when a chart has no accompanying table. */
function drawChartLabelKey(document, labelReferences) {
  ensureSpace(document, 60);
  document.font('Poppins-SemiBold');
  document.fontSize(10);
  document.fillColor(INK);
  document.text('Full location labels', MARGIN, document.y, { width: contentWidth(document) });
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
      document.fill(seriesColor(document, row.start + column));
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
    document.strokeColor(seriesColor(document, seriesIndex));
    document.stroke();

    for (const point of points) {
      if (point) {
        document.circle(point[0], point[1], 2.5);
        document.fill(seriesColor(document, seriesIndex));
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

      let color = seriesColor(document, seriesIndex);
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
  for (let start = 0; start < places.length; start += TABLE_PLACES_PER_PART) {
    const end = Math.min(start + TABLE_PLACES_PER_PART, places.length);
    const partRows = rows.map((row) => ({ ...row, cells: row.cells.slice(start, end) }));
    const heading = places.length > TABLE_PLACES_PER_PART ? `Indicator values: locations ${start + 1}-${end} of ${places.length}` : '';
    drawTablePart(document, places.slice(start, end), partRows, heading);
    document.moveDown(0.6);
  }
}

function drawTablePart(document, places, rows, heading) {
  const width = contentWidth(document);
  const firstColumnWidth = Math.min(200, width * 0.36);
  const layout = {
    width,
    firstColumnWidth,
    valueColumnWidth: (width - firstColumnWidth) / places.length,
    padding: document.reportStyle.spacing === 'compact' ? 3 : 5,
  };
  const header = ['Indicator', ...places.map((place) => place.label)];
  const headerStyle = { bold: true, fill: document.reportStyle.tableHeaderColor };

  const headerHeight = tableRowHeight(document, header, layout, true);
  const rowHeights = rows.map((row) => tableRowHeight(document, [row.displayLabel, ...row.cells.map((cell) => cell.display)], layout));
  const headingHeight = heading ? 26 : 0;
  const groupHeight = headingHeight + headerHeight + rowHeights.reduce((total, height) => total + height, 0);
  const bodyHeight = document.page.height - document.page.margins.top - document.page.margins.bottom;
  // Keep a short location group together; long tables still flow over pages.
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

  for (const row of rows) {
    const cells = [row.displayLabel, ...row.cells.map((cell) => cell.display)];
    if (ensureSpace(document, tableRowHeight(document, cells, layout))) {
      drawTableRow(document, header, layout, headerStyle);
    }
    drawTableRow(document, cells, layout);
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
