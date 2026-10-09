import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BENCHMARK_COLOR, BRAND, CSS_TOKENS, SERIES_COLORS } from '../src/shared/theme.js';

const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
const rootBlock = css.match(/:root\s*\{([^}]*)\}/)[1];
const cssVars = Object.fromEntries([...rootBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));

/** WCAG 2.1 relative luminance and contrast ratio. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('every color token in app.css matches src/shared/theme.js', () => {
  for (const [name, value] of Object.entries(CSS_TOKENS)) {
    assert.equal(cssVars[name]?.toLowerCase(), value.toLowerCase(), `${name} in app.css`);
  }
});

test('app.css declares no color token that theme.js does not know about', () => {
  const colorVars = Object.entries(cssVars).filter(([, value]) => value.startsWith('#')).map(([name]) => name);
  for (const name of colorVars) assert.ok(name in CSS_TOKENS, `${name} is missing from CSS_TOKENS`);
});

test('text color pairs meet WCAG AA (4.5:1)', () => {
  const t = CSS_TOKENS;
  const pairs = [
    ['--ink', '--surface'], ['--ink', '--ground'], ['--ink', '--tint'], ['--ink', '--warn-bg'],
    ['--heading', '--surface'], ['--heading', '--ground'],
    ['--link', '--surface'], ['--link', '--ground'],
    ['--muted', '--surface'], ['--muted', '--ground'],
    ['--surface', '--brand'], ['--surface', '--brand-dark'], ['--yellow', '--brand'],
    ['--danger', '--danger-bg'], ['--ok', '--ok-bg'],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(t[fg], t[bg]);
    assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test('the focus ring and chart colors meet the 3:1 non-text minimum on white', () => {
  assert.ok(contrast(CSS_TOKENS['--focus'], '#ffffff') >= 3);
  for (const color of [...SERIES_COLORS, BENCHMARK_COLOR]) assert.ok(contrast(color, '#ffffff') >= 3, color);
});

test('charts never pair teal with green (brand guideline p. 8)', () => {
  assert.ok(!(SERIES_COLORS.includes(BRAND.teal) && SERIES_COLORS.includes(BRAND.green)));
});
