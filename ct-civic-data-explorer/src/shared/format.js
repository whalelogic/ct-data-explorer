/**
 * Number presentation rules shared by the server (PDF) and the browser (preview),
 * so a figure is formatted identically everywhere. Dependency-free: this file is
 * served to the browser as-is at /shared/format.js.
 */

const formatters = new Map();

function numberFormat(options) {
  const key = JSON.stringify(options);
  if (!formatters.has(key)) formatters.set(key, new Intl.NumberFormat('en-US', options));
  return formatters.get(key);
}

/**
 * Format a value for display. Counts and currency get thousands separators; rates,
 * density and area use the indicator's configured decimals.
 * @param {number | null | undefined} value
 * @param {{ unit: string, decimals: number }} indicator
 */
export function formatValue(value, { unit, decimals }) {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  const digits = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  switch (unit) {
    case 'currency':
      return numberFormat({ style: 'currency', currency: 'USD', ...digits }).format(value);
    case 'percent':
      return `${numberFormat(digits).format(value)}%`;
    default:
      return numberFormat(digits).format(value);
  }
}

/** Short axis tick label, e.g. $130K, 2.9K, 9.3%. */
export function formatAxisValue(value, { unit }) {
  const compact = numberFormat({ notation: 'compact', maximumFractionDigits: 1 }).format(value);
  if (unit === 'currency') return `$${compact}`;
  if (unit === 'percent') return `${compact}%`;
  return compact;
}

/** Axis title for a unit. */
export function unitLabel(unit) {
  return (
    { count: 'Count', currency: 'US dollars', percent: 'Percent', density: 'People per square mile', area: 'Square miles' }[
      unit
    ] ?? unit
  );
}

/** Indicator label with its unit where the unit is not obvious from the value, e.g. "Land Area (sq mi)". */
export function indicatorLabel({ label, unit }) {
  const suffix = { density: 'per sq mi', area: 'sq mi' }[unit];
  return suffix ? `${label} (${suffix})` : label;
}
