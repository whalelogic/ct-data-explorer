/** Report styling shared by HTML and PDF; each render resolves its own settings. */
import { BENCHMARK_COLOR, INK, LINK_COLOR, SERIES_COLORS, TABLE_HEADER_FILL } from './theme.js';

export const DEFAULT_REPORT_STYLE = Object.freeze({
  palette: SERIES_COLORS,
  benchmarkColor: BENCHMARK_COLOR,
  headingColor: LINK_COLOR,
  tableHeaderColor: TABLE_HEADER_FILL,
  textSize: 'standard',
  spacing: 'comfortable',
});

export function resolveReportStyle(shared = {}, overrides = {}) {
  return { ...DEFAULT_REPORT_STYLE, ...(shared ?? {}), ...(overrides ?? {}) };
}

export function contrastRatio(first, second) {
  const luminance = (hex) => {
    const rgb = hex.slice(1).match(/../g).map((pair) => {
      const value = parseInt(pair, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export const REPORT_TEXT_COLOR = INK;
