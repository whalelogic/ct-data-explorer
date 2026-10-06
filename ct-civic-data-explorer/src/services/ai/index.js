/**
 * AI-drafted report summaries (SRS US009). This step sits outside the render path:
 * it only proposes text, which the user can add to the report as a text block. Every number, table and
 * chart on a report comes from the database, and reports build and export with no
 * provider configured at all.
 *
 * A provider is any object with `draft(facts) => Promise<string>`; add one and
 * select it with AI_PROVIDER.
 */
import { config } from '../../config.js';
import { HttpError } from '../../lib/http-error.js';
import { createAnthropicProvider } from './anthropic-provider.js';
import { crossCheckFigures } from './crosscheck.js';

let provider;

function getProvider() {
  if (provider !== undefined) return provider;
  switch (config.ai.provider) {
    case 'anthropic':
      provider = createAnthropicProvider(config.ai);
      break;
    case 'none':
      provider = null;
      break;
    default:
      console.error(`[ai] unknown AI_PROVIDER "${config.ai.provider}"; summary drafting is disabled`);
      provider = null;
  }
  return provider;
}

export function isSummaryAvailable() {
  return getProvider() !== null;
}

/** Only already-public aggregate figures and labels leave the server; never accounts or uploaded files. */
export function summaryFacts(report) {
  return {
    dataset: { name: report.dataset.name, source: report.dataset.source, vintage: report.dataset.vintage },
    places: report.places.map((p) => ({ name: report.rowBased ? p.label : p.name, type: p.geoType === 'state' ? 'statewide' : 'town' })),
    indicators: report.indicators.map((row) => ({
      label: row.displayLabel,
      values: Object.fromEntries(row.cells.map((cell, i) => [report.rowBased ? report.places[i].label : report.places[i].name, cell.display])),
    })),
  };
}

/** @returns {Promise<{ text: string, mismatches: { figure: string, message: string }[] }>} */
export async function draftSummary(report) {
  const active = getProvider();
  if (!active) throw new HttpError(503, 'AI summary drafting is not configured. You can write the text by hand.');
  // Row-based reports show the uploaded file's own rows (names, notes), not public
  // aggregates, so they stay on the server.
  if (report.rowBased) {
    throw new HttpError(422, 'AI summaries are not available for record-based datasets. You can write the text by hand.');
  }

  let text;
  try {
    text = await active.draft(summaryFacts(report));
  } catch (err) {
    console.error(`[ai] ${active.name} draft failed: ${err.message}`);
    throw new HttpError(502, 'A summary could not be drafted right now. Try again, or write the text by hand.');
  }
  return { text, mismatches: crossCheckFigures(text, report) };
}
