/**
 * PDF generation boundary (SRS US007). Routes call renderReportPdf(report) with the
 * same report data the preview shows. The implementation behind it can be swapped,
 * e.g. for a headless-browser renderer (SRS OQ-4), without touching routes or services.
 */
import { renderWithPdfkit } from './pdfkit-renderer.js';

/** @returns {Promise<Buffer>} */
export function renderReportPdf(report) {
  return renderWithPdfkit(report);
}

/** Readable filename, e.g. ctdata-report-west-hartford-acs2024.pdf */
export function reportFilename(report) {
  const primary = report.places.find((p) => p.geoType === 'town') ?? report.places[0];
  const datasetWord = report.dataset.name.trim().split(/\s+/)[0] ?? 'data';
  return `ctdata-report-${slug(primary?.name ?? 'connecticut')}-${slug(datasetWord)}${slug(report.dataset.vintage)}.pdf`;
}

function slug(text) {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
