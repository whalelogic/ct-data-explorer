/**
 * PDF generation boundary (SRS US007). Routes call renderCardPdf(card) with the
 * same card data the preview shows. The implementation behind it can be swapped,
 * e.g. for a headless-browser renderer (SRS OQ-4), without touching routes or services.
 */
import { renderWithPdfkit } from './pdfkit-renderer.js';

/** @returns {Promise<Buffer>} */
export function renderCardPdf(card) {
  return renderWithPdfkit(card);
}

/** Readable filename, e.g. ctdata-card-west-hartford-acs2024.pdf */
export function cardFilename(card) {
  const primary = card.places.find((p) => p.geoType === 'town') ?? card.places[0];
  const datasetWord = card.dataset.name.trim().split(/\s+/)[0] ?? 'data';
  return `ctdata-card-${slug(primary?.name ?? 'connecticut')}-${slug(datasetWord)}${slug(card.dataset.vintage)}.pdf`;
}

function slug(text) {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
