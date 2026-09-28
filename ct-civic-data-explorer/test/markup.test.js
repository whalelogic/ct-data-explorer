import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkup } from '../src/services/markup.js';

test('headings, paragraphs and lists', () => {
  const nodes = parseMarkup('# Income\n\nFirst line\nsecond line.\n\n- one\n- two\ncontinued\n\n3. three\n4) four\n\n#### deep');
  assert.deepEqual(nodes, [
    { type: 'heading', level: 1, runs: [{ text: 'Income' }] },
    { type: 'paragraph', runs: [{ text: 'First line second line.' }] },
    { type: 'list', ordered: false, start: 1, items: [[{ text: 'one' }], [{ text: 'two continued' }]] },
    { type: 'list', ordered: true, start: 3, items: [[{ text: 'three' }], [{ text: 'four' }]] },
    { type: 'heading', level: 3, runs: [{ text: 'deep' }] },
  ]);
});

test('a heading or list marker ends the paragraph before it', () => {
  assert.deepEqual(parseMarkup('Intro\n## Next\n- item').map((n) => n.type), ['paragraph', 'heading', 'list']);
  assert.deepEqual(parseMarkup('- a\n1. b').map((n) => n.ordered), [false, true]);
});

test('bold, italic and links', () => {
  assert.deepEqual(parseInline('Rates are **much *lower*** in _West Hartford_, see [Census](https://data.census.gov).'), [
    { text: 'Rates are ' },
    { text: 'much ', bold: true },
    { text: 'lower', bold: true, italic: true },
    { text: ' in ' },
    { text: 'West Hartford', italic: true },
    { text: ', see ' },
    { text: 'Census', href: 'https://data.census.gov' },
    { text: '.' },
  ]);
});

test('stray or intraword markers, escapes and unsafe links stay literal', () => {
  assert.deepEqual(parseInline('5 * 3 = 15, snake_case_name, \\*not italic\\*'), [{ text: '5 * 3 = 15, snake_case_name, *not italic*' }]);
  assert.deepEqual(parseInline('[x](javascript:alert(1)) <b>hi</b>'), [{ text: '[x](javascript:alert(1)) <b>hi</b>' }]);
  assert.deepEqual(parseInline('**unclosed bold'), [{ text: '**unclosed bold' }]);
});

test('blank input has no nodes', () => {
  assert.deepEqual(parseMarkup('  \n\n '), []);
});
