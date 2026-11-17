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

export function reportFilename(report) {
  const primary = report.places.find((place) => place.geoType !== 'state') ?? report.places[0];
  const datasetWord = report.dataset.name.trim().split(/\s+/)[0] ?? 'data';
  const datasetSlug = slug(datasetWord) || 'data';
  const rowSlug = slug(primary?.name ?? '') || datasetSlug;
  return `ctdata-report-${rowSlug}-${datasetSlug}${slug(report.dataset.vintage)}.pdf`;
}

function slug(text) {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');
}
