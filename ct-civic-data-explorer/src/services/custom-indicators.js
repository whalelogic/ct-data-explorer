/**
 * Calculated fields defined in a report, computed on the server and never stored.
 *
 * Row by row (calculation 'ratio'): numerator ÷ denominator × multiplier for each row, like
 * the registered ratio indicators in compute.js. Both parts must be approved numeric fields.
 *
 * Summaries (every other calculation): one value for the whole report from the numerator's
 * values across the report's rows: average (total ÷ rows), average over rows with a value in
 * another column, median, highest, lowest or total. The statewide row is a benchmark, so it
 * is never part of a summary.
 */
import { HttpError } from '../lib/http-error.js';
import { formatValue } from '../shared/format.js';
import { RATIO_FORMATS } from './selection.js';

export function isSummaryIndicator(custom) {
  return (custom.calculation ?? 'ratio') !== 'ratio';
}

/** The selection without summary keys: summaries are not charted or tabulated per row. */
export function withoutSummaryIndicators(selection) {
  const summaryKeys = new Set((selection.customIndicators ?? []).filter(isSummaryIndicator).map((custom) => custom.key));
  if (summaryKeys.size === 0) {
    return selection;
  }
  return {
    ...selection,
    indicators: selection.indicators.filter((key) => !summaryKeys.has(key)),
    customIndicators: selection.customIndicators.filter((custom) => !summaryKeys.has(custom.key)),
    layout: selection.layout.map((block) => (block.indicators
      ? { ...block, indicators: block.indicators.filter((key) => !summaryKeys.has(key)) }
      : block)),
  };
}

/**
 * One value per summary field the report uses, plus, when asked, the same figure for every
 * row of the dataset (all Connecticut towns) so the report's value has something to compare to.
 * @param {object} selection the full selection, including summary fields
 * @param {object[]} approvedFields fields the report may read, already presented
 * @param {object[]} rows the report's rows, without the statewide benchmark
 * @param {{ readValue: (row: object, field: object) => (number|string|null), nameOf: (row: object) => string, rowNoun: string }} access
 * @param {{ rows: object[], label: string, rowNoun: string } | null} [benchmark] every comparable row
 *   in the dataset; skipped when the report already covers all of them
 */
export function computeSummaries(selection, approvedFields, rows, { readValue, nameOf, rowNoun }, benchmark = null) {
  const fieldsByKey = new Map(approvedFields.map((field) => [field.key, field]));
  const summaries = [];
  for (const custom of selection.customIndicators ?? []) {
    if (!isSummaryIndicator(custom) || !selection.indicators.includes(custom.key)) {
      continue;
    }
    const numerator = fieldsByKey.get(custom.numerator);
    if (!numerator) {
      throw new HttpError(400, `${custom.label}: the field "${custom.numerator}" is not approved for this dataset.`);
    }
    if (numerator.type === 'text') {
      throw new HttpError(400, `${custom.label}: choose a number field to summarize.`);
    }
    let counted = null;
    if (custom.calculation === 'average_filled') {
      counted = fieldsByKey.get(custom.denominator);
      if (!counted) {
        throw new HttpError(400, `${custom.label}: the field "${custom.denominator}" is not approved for this dataset.`);
      }
    }

    const valued = rows
      .map((row) => ({ row, value: readValue(row, numerator) }))
      .filter((entry) => typeof entry.value === 'number');
    const result = summarize(custom, valued, { rows, counted, readValue, nameOf, rowNoun, numerator });
    const format = RATIO_FORMATS[custom.format] ?? RATIO_FORMATS.ratio;
    // Only averages are divisions, so only they can be shown as a percentage or per 1,000.
    const isAverage = custom.calculation === 'average' || custom.calculation === 'average_filled';
    const unit = isAverage && format.unit !== 'ratio' ? format.unit : numerator.unit;
    // detail is the plain line shown under the number; explanation is the working, for tooltips and the AI.
    const summary = {
      key: custom.key,
      label: selection.fieldOverrides?.[custom.key]?.label || custom.label,
      calculation: custom.calculation,
      value: result.value,
      display: formatValue(result.value, { unit, decimals: custom.decimals }),
      detail: valued.length ? reportDetail(custom.calculation, result, rows.length, rowNoun) : 'No values',
      explanation: valued.length ? result.explanation : `No ${numerator.label} values in this report.`,
    };
    if (custom.benchmark !== false && benchmark && benchmark.rows.length > rows.length) {
      const allValued = benchmark.rows
        .map((row) => ({ row, value: readValue(row, numerator) }))
        .filter((entry) => typeof entry.value === 'number');
      const overall = summarize(custom, allValued, {
        rows: benchmark.rows, counted, readValue, nameOf, rowNoun: benchmark.rowNoun, numerator,
      });
      summary.benchmark = {
        label: benchmarkLabel(custom.calculation, overall, benchmark),
        scope: benchmark.label,
        value: overall.value,
        display: formatValue(overall.value, { unit, decimals: custom.decimals }),
        explanation: allValued.length ? `${benchmark.label}: ${overall.explanation}` : `No ${numerator.label} values.`,
      };
    }
    summaries.push(summary);
  }
  return summaries;
}

function summarize(custom, valued, { rows, counted, readValue, nameOf, rowNoun, numerator }) {
  const values = valued.map((entry) => entry.value);
  const show = (value) => formatValue(value, { unit: numerator.unit, decimals: Number.isInteger(value) ? 0 : Math.min(numerator.decimals ?? 0, 2) });
  const total = values.reduce((sum, value) => sum + value, 0);
  const ofRows = `of ${values.length.toLocaleString('en-US')} ${values.length === 1 ? rowNoun : pluralNoun(rowNoun)}`;
  if (!values.length) {
    return { value: null, explanation: '' };
  }

  switch (custom.calculation) {
    case 'average':
    case 'average_filled': {
      const format = RATIO_FORMATS[custom.format] ?? RATIO_FORMATS.ratio;
      let count = rows.length;
      let countLabel = `${count.toLocaleString('en-US')} ${count === 1 ? rowNoun : pluralNoun(rowNoun)}`;
      if (counted) {
        count = rows.filter((row) => isPresent(readValue(row, counted))).length;
        countLabel = `${count.toLocaleString('en-US')} ${count === 1 ? 'row' : 'rows'} with a ${counted.label} value`;
      }
      const multiplier = format.multiplier === 1 ? '' : ` × ${format.multiplier.toLocaleString('en-US')}`;
      return {
        value: computeRatio(total, count, format.multiplier),
        explanation: `${show(total)} total ${numerator.label} ÷ ${countLabel}${multiplier}`,
      };
    }
    case 'median': {
      const sorted = [...values].sort((first, second) => first - second);
      const middle = Math.floor(sorted.length / 2);
      const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      return { value, explanation: `Middle ${numerator.label} value ${ofRows}` };
    }
    case 'highest':
    case 'lowest': {
      const value = custom.calculation === 'highest' ? Math.max(...values) : Math.min(...values);
      const names = valued.filter((entry) => entry.value === value).map((entry) => nameOf(entry.row));
      const who = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : joinNames(names);
      const holder = `${who}${names.length > 1 ? ' (tied)' : ''}`;
      return { value, who: holder, explanation: `${holder}, ${custom.calculation} ${ofRows}` };
    }
    case 'total':
      return { value: total, explanation: `${numerator.label} added up ${ofRows}` };
    default:
      throw new HttpError(400, `${custom.label}: unknown calculation.`);
  }
}

/** "Across these 4 towns", or who holds the highest or lowest value. */
function reportDetail(calculation, result, count, rowNoun) {
  if (calculation === 'highest' || calculation === 'lowest') {
    return result.who;
  }
  return count === 1 ? `For this ${rowNoun}` : `Across these ${count.toLocaleString('en-US')} ${pluralNoun(rowNoun)}`;
}

/** "Average for a Connecticut town", "Highest in Connecticut: Bridgeport", "Whole dataset total". */
function benchmarkLabel(calculation, result, { isPlace, rowNoun }) {
  const where = isPlace ? 'Connecticut' : 'the whole dataset';
  switch (calculation) {
    case 'average':
    case 'average_filled':
      return isPlace ? `Average for a Connecticut ${rowNoun}` : 'Average for the whole dataset';
    case 'median':
      return isPlace ? `Median Connecticut ${rowNoun}` : 'Median for the whole dataset';
    case 'highest':
      return `Highest in ${where}: ${result.who}`;
    case 'lowest':
      return `Lowest in ${where}: ${result.who}`;
    default:
      return isPlace ? 'Connecticut total' : 'Whole dataset total';
  }
}

function joinNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
}

function isPresent(value) {
  return value != null && String(value).trim() !== '';
}

function pluralNoun(noun) {
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return /s$/i.test(noun) ? noun : `${noun}s`;
}

export function customIndicatorKeys(selection) {
  return new Set((selection.customIndicators ?? []).map((custom) => custom.key));
}

/** The selection without custom keys, for checks that apply to dataset fields only. */
export function withoutCustomIndicators(selection) {
  const customKeys = customIndicatorKeys(selection);
  const fieldOverrides = Object.fromEntries(
    Object.entries(selection.fieldOverrides ?? {}).filter(([key]) => !customKeys.has(key)),
  );
  return {
    ...selection,
    indicators: selection.indicators.filter((key) => !customKeys.has(key)),
    fieldOverrides,
  };
}

/**
 * Field definitions for the custom indicators the report uses, checked against the
 * dataset's approved numeric fields.
 * @param {{ key: string, label: string, type?: string }[]} approvedFields
 */
export function buildCustomFields(selection, approvedFields) {
  const fieldsByKey = new Map(approvedFields.map((field) => [field.key, field]));
  const customFields = [];
  for (const custom of selection.customIndicators ?? []) {
    if (!selection.indicators.includes(custom.key) || isSummaryIndicator(custom)) {
      continue;
    }
    const numerator = fieldsByKey.get(custom.numerator);
    const denominator = fieldsByKey.get(custom.denominator);
    for (const [part, field, key] of [['numerator', numerator, custom.numerator], ['denominator', denominator, custom.denominator]]) {
      if (!field) {
        throw new HttpError(400, `${custom.label}: the ${part} field "${key}" is not approved for this dataset.`);
      }
      if (field.type === 'text') {
        throw new HttpError(400, `${custom.label}: the ${part} must be a numeric field.`);
      }
    }
    const format = RATIO_FORMATS[custom.format] ?? RATIO_FORMATS.ratio;
    customFields.push({
      key: custom.key,
      label: custom.label,
      description: `Calculated for this report: ${numerator.label} ÷ ${denominator.label}${format.multiplier === 1 ? '' : ` × ${format.multiplier.toLocaleString('en-US')}`}.`,
      type: 'number',
      role: 'measure',
      unit: format.unit,
      decimals: custom.decimals,
      derivation: 'custom',
      numerator,
      denominator,
      multiplier: format.multiplier,
    });
  }
  return customFields;
}

/** null when either part is missing or the denominator is zero, never Infinity. */
export function computeRatio(numeratorValue, denominatorValue, multiplier) {
  if (numeratorValue == null || denominatorValue == null || denominatorValue === 0) {
    return null;
  }
  const value = (numeratorValue / denominatorValue) * multiplier;
  return Number.isFinite(value) ? value : null;
}
