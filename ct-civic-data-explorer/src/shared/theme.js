/**
 * CTData brand tokens (docs/CTData_Brandguideline.pdf), shared by the browser
 * (Chart.js) and the PDF renderer (pdfkit). This module is the single source of
 * truth: the custom properties at the top of public/css/app.css must match
 * CSS_TOKENS, and test/theme.test.js fails if they drift apart.
 *
 * Contrast notes (WCAG 2.1 on white): Dark Blue 14.1, Teal 5.2, Charcoal 12.1 and
 * Plum 6.3 pass for body text. Green (4.3) and Orange (3.2) are for large text,
 * rules, icons and fills only. Lilac Gray (3.0) is for borders and the benchmark.
 */

/** The named brand palette. */
export const BRAND = Object.freeze({
  darkBlue: '#262558', // primary: logo, body copy, primary buttons
  teal: '#39738c', // accent: headlines, sub-heads, links
  green: '#008881', // accent: never alongside teal in a chart
  orange: '#de6f59', // accent: use sparingly (separators, icons, highlights)
  lightYellow: '#f9de8d', // text on Dark Blue only; color blocks
  charcoal: '#363635', // captions and quotes
  lilacGray: '#9194a2', // backgrounds, borders
  lightGray: '#f4f4f6', // page background
  white: '#ffffff',
  limeGreen: '#6aa343', // chart-only
  brightBlue: '#00a3bd', // chart-only
  plumPurple: '#9a3890', // chart-only
});

/**
 * Chart series order. Per the guideline, teal and green never share a chart, so
 * green is left out and the chart-only colors fill the remaining slots.
 */
export const SERIES_COLORS = Object.freeze([
  BRAND.darkBlue,
  BRAND.orange,
  BRAND.teal,
  BRAND.plumPurple,
  BRAND.limeGreen,
  BRAND.brightBlue,
]);
export const BENCHMARK_COLOR = BRAND.lilacGray;

export const INK = BRAND.darkBlue; // body copy
export const HEADING = BRAND.teal; // headlines and sub-heads
export const MUTED = BRAND.charcoal; // captions, axis labels, footers
export const ACCENT = BRAND.orange; // separator rules
export const RULE = '#d3d4dc'; // hairlines: Lilac Gray at ~40% on white
export const TABLE_HEADER_FILL = BRAND.lightGray;
export const LINK_COLOR = BRAND.teal;

/** Poppins everywhere; Arial is the guideline's named substitute. */
export const FONT_FAMILY = '"Poppins", Arial, Helvetica, sans-serif';

/**
 * Color custom properties declared in public/css/app.css, keyed by property name.
 * Status colors (danger/ok/warn) are functional, not brand colors.
 */
export const CSS_TOKENS = Object.freeze({
  '--brand': BRAND.darkBlue,
  '--brand-dark': '#1a1940',
  '--teal': BRAND.teal,
  '--green': BRAND.green,
  '--orange': BRAND.orange,
  '--yellow': BRAND.lightYellow,
  '--lilac': BRAND.lilacGray,
  '--ink': INK,
  '--heading': HEADING,
  '--muted': MUTED,
  '--rule': RULE,
  '--surface': BRAND.white,
  '--ground': BRAND.lightGray,
  '--tint': '#e9e9ef',
  '--link': LINK_COLOR,
  '--danger': '#b42318',
  '--danger-bg': '#fdecea',
  '--ok': '#1e6b44',
  '--ok-bg': '#e8f5ee',
  '--warn-bg': '#fdf3d6',
  '--focus': BRAND.darkBlue,
});
