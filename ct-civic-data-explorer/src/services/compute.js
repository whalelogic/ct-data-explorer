/**
 * Derived-value computation. Rates are computed here on the server from the stored
 * components named in the indicators table. They are never stored precomputed and
 * never computed in the browser, so a denominator cannot drift between screens (SRS Risk T1).
 */

/**
 * @param {{ key: string, unit: string, derivation: string, numerator_key?: string | null, denominator_key?: string | null }} indicator
 * @param {Map<string, number> | undefined} values raw observation values for one place, keyed by indicator key
 * @returns {number | null} null when the value, or a component of it, is unavailable
 */
export function computeValue(indicator, values) {
  if (!values) return null;
  if (indicator.derivation === 'ratio') {
    const numerator = values.get(indicator.numerator_key);
    const denominator = values.get(indicator.denominator_key);
    if (numerator == null || denominator == null || denominator === 0) return null;
    const ratio = numerator / denominator;
    return indicator.unit === 'percent' ? ratio * 100 : ratio;
  }
  return values.get(indicator.key) ?? null;
}
