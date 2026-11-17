import { increment } from '../repositories/dataset-usage.js';

const SELECTION_EVENTS = new Set(['ai_analysis', 'report_preview', 'report_created', 'report_updated']);

/** Call only after a successful, authorized operation. */
export function trackDatasetUsage(event, datasetId, indicators = []) {
  const keys = SELECTION_EVENTS.has(event)
    ? indicators.map((indicator) => typeof indicator === 'string' ? indicator : indicator.key)
    : [];
  return record(event, new Map([[datasetId, new Set(keys)]]));
}

export function trackDatasetAccess(datasetIds) {
  return record('access', new Map(datasetIds.map((id) => [id, new Set()])));
}

/** Count one operation even when it used several datasets. */
export function trackReportUsage(event, report, selection) {
  const datasets = report.datasets ?? [report.dataset];
  const byDataset = new Map(datasets.map(({ id }) => [id, new Set()]));
  if (SELECTION_EVENTS.has(event)) {
    for (const indicator of report.indicators ?? []) {
      byDataset.get(indicator.datasetId ?? report.dataset.id)?.add(indicator.indicatorKey ?? indicator.key);
    }
    const primaryKeys = byDataset.get(report.dataset.id);
    for (const custom of selection?.customIndicators ?? []) {
      if (!selection.indicators.includes(custom.key)) continue;
      primaryKeys.delete(custom.key);
      primaryKeys.add(custom.numerator);
      if (custom.denominator) primaryKeys.add(custom.denominator);
    }
  }
  return record(event, byDataset);
}

async function record(event, selections) {
  try {
    await increment(event, selections);
  } catch (error) {
    // Usage tracking must not turn a completed analysis or saved report into a failure.
    console.error('[usage] Unable to record activity', event, error.code ?? error.name);
  }
}
