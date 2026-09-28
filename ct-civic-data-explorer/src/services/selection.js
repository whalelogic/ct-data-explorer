/**
 * The card selection: the single JSON object the builder produces, cards.selection
 * stores, the preview renders, and the PDF generator consumes (SRS §5.4). Because
 * every consumer reads the same object, an exported PDF cannot disagree with the preview.
 *
 * The card body is `layout`, an ordered list of blocks: text (a Markdown subset, see
 * markup.js), chart and table. A card may hold any number of each.
 */
import { z } from 'zod';

export const BLOCK_TYPES = Object.freeze(['text', 'chart', 'table']);
export const CHART_TYPES = Object.freeze(['bar', 'grouped_bar', 'line']);
export const MAX_COMPARISON_TOWNS = 3;
export const MAX_LAYOUT_BLOCKS = 30;
export const MAX_TEXT_LENGTH = 4000;

const requiredText = (label, max) => z.string().trim().min(1, `${label} is required`).max(max);

const textBlock = z.object({
  type: z.literal('text'),
  text: z.string().trim().max(MAX_TEXT_LENGTH, `A text block can hold at most ${MAX_TEXT_LENGTH} characters`).default(''),
});
const chartBlock = z.object({
  type: z.literal('chart'),
  chartType: z.enum(CHART_TYPES).default('bar'),
  indicators: z.array(z.string()).max(6).default([]), // empty: chart the indicators sharing the first one's unit
});
const tableBlock = z.object({
  type: z.literal('table'),
  indicators: z.array(z.string()).max(25).default([]), // empty: every indicator on the card
});

export const blockSchema = z.discriminatedUnion('type', [textBlock, chartBlock, tableBlock], {
  error: `Each block must be one of: ${BLOCK_TYPES.join(', ')}`,
});

export const DEFAULT_LAYOUT = Object.freeze([
  { type: 'chart', chartType: 'bar', indicators: [] },
  { type: 'table', indicators: [] },
]);

export const selectionSchema = z.preprocess(
  upgradeLegacySelection,
  z
    .object({
      dataset: z.object(
        { name: requiredText('Dataset name', 200), vintage: requiredText('Dataset vintage', 50) },
        { error: 'Choose a dataset' },
      ),
      towns: z
        .array(requiredText('Town', 100))
        .min(1, 'Choose a town')
        .max(1 + MAX_COMPARISON_TOWNS, `Choose at most ${MAX_COMPARISON_TOWNS} comparison towns`),
      benchmark: z.boolean().default(true),
      indicators: z.array(requiredText('Indicator', 100)).min(1, 'Select at least one indicator for the card').max(25),
      showTitle: z.boolean().default(true),
      title: z.string().trim().max(200).default(''),
      subtitle: z.string().trim().max(300).default(''),
      layout: z
        .array(blockSchema)
        .max(MAX_LAYOUT_BLOCKS, `A card can hold at most ${MAX_LAYOUT_BLOCKS} blocks`)
        .default(() => DEFAULT_LAYOUT.map((block) => ({ ...block, indicators: [] }))),
    })
    .superRefine((s, ctx) => {
      const duplicateTown = findDuplicate(s.towns.map((t) => t.toLowerCase()));
      if (duplicateTown) ctx.addIssue({ code: 'custom', path: ['towns'], message: `"${duplicateTown}" is selected more than once` });

      const duplicateIndicator = findDuplicate(s.indicators);
      if (duplicateIndicator) {
        ctx.addIssue({ code: 'custom', path: ['indicators'], message: `"${duplicateIndicator}" is selected more than once` });
      }

      s.layout.forEach((block, i) => {
        if (block.type === 'text') return;
        const unselected = block.indicators.find((key) => !s.indicators.includes(key));
        if (unselected) {
          const what = block.type === 'chart' ? 'Chart' : 'Table';
          ctx.addIssue({ code: 'custom', path: ['layout', i, 'indicators'], message: `${what} indicator "${unselected}" is not on the card` });
        }
      });

      if (!s.layout.some((block) => block.type !== 'text')) {
        ctx.addIssue({ code: 'custom', path: ['layout'], message: 'Include a chart or a table so the card shows its figures' });
      }
    }),
);

/**
 * Convert the pre-layout selection shape ({ blocks: ['title', 'chart', 'table',
 * 'notes', 'source'], chart: { type, indicators }, notes }) so saved cards and the
 * SRS example keep working. Selections that already have a layout pass through.
 */
export function upgradeLegacySelection(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || 'layout' in input) return input;
  const { blocks, chart, notes, ...rest } = input;
  if (blocks === undefined && chart === undefined && notes === undefined) return input;

  const legacy = Array.isArray(blocks) ? blocks : ['title', 'chart', 'table'];
  const layout = [];
  if (legacy.includes('chart')) layout.push({ type: 'chart', chartType: chart?.type, indicators: chart?.indicators });
  if (legacy.includes('table')) layout.push({ type: 'table' });
  if (legacy.includes('notes') && typeof notes === 'string' && notes.trim() !== '') layout.push({ type: 'text', text: notes });
  return { ...rest, showTitle: legacy.includes('title'), layout };
}

function findDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}
