/**
 * Cross-check the figures in AI-drafted text against the report's computed values
 * (SRS US009, Risk T4). A number in the draft matches when it equals some report
 * value rounded to the precision the draft states: "9.3%" matches 9.2949 and
 * "$130 thousand" matches 129,890. Anything else is flagged for the user.
 */

const FIGURE =
  /(?<![\w.])(-?)\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*(%|percent\b|thousand\b|million\b|billion\b))?/gi;
const MULTIPLIER = { thousand: 1e3, million: 1e6, billion: 1e9 };

/** @returns {{ raw: string, value: number, tolerance: number }[]} */
export function extractFigures(text) {
  return [...text.matchAll(FIGURE)].map(([raw, sign, whole, fraction = '', suffix = '']) => {
    const multiplier = MULTIPLIER[suffix.toLowerCase()] ?? 1;
    const value = Number(`${sign}${whole.replaceAll(',', '')}.${fraction || '0'}`) * multiplier;
    return { raw: raw.trim(), value, tolerance: 0.5 * 10 ** -fraction.length * multiplier };
  });
}

/**
 * @param {string} text drafted summary
 * @param {{ dataset: { name: string, vintage: string }, indicators: { cells: { value: number | null }[] }[] }} report
 * @returns {{ figure: string, message: string }[]} figures that match nothing on the report
 */
export function crossCheckFigures(text, report) {
  const allowed = [
    ...report.indicators.flatMap((row) => row.cells.map((cell) => cell.value)).filter((v) => v != null),
    // Numbers that legitimately appear in prose about the dataset, e.g. "2024" or "5-Year".
    ...`${report.dataset.name} ${report.dataset.vintage}`.match(/\d+/g)?.map(Number) ?? [],
  ];
  return extractFigures(text)
    .filter((figure) => !allowed.some((value) => Math.abs(value - figure.value) <= figure.tolerance + 1e-9))
    .map((figure) => ({ figure: figure.raw, message: `"${figure.raw}" does not match any figure on this report` }));
}
