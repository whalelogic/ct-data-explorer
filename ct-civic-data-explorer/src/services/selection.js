/**
 * The report selection: the single JSON object the builder produces, reports.selection
 * stores, the preview renders, and the PDF generator consumes (SRS §5.4). Because
 * every consumer reads the same object, an exported PDF cannot disagree with the preview.
 *
 * The report body is `layout`, an ordered list of blocks: text (a Markdown subset, see
 * markup.js), chart and table. A report may hold any number of each.
 */
import { z } from 'zod';
import { fieldPresentationSchema, reportStyleSchema } from './presentation.js';

export const BLOCK_TYPES = Object.freeze(['text', 'chart', 'table']);
export const CHART_TYPES = Object.freeze(['bar', 'grouped_bar', 'line']);
export const MAX_LAYOUT_BLOCKS = 30;
export const MAX_TEXT_LENGTH = 4000;
/** Listing more rows than this by name is what "all rows" is for; it keeps requests small. */
export const MAX_NAMED_ROWS = 2000;
export const MAX_CUSTOM_INDICATORS = 10;
/** A custom ratio's multiplier decides its unit, so a percentage is never charted beside a ratio. */
export const RATIO_FORMATS = Object.freeze({
  ratio: { multiplier: 1, unit: 'ratio' },
  percent: { multiplier: 100, unit: 'percent' },
  per_1000: { multiplier: 1000, unit: 'per_1000' },
});

const requiredText = (label, max) => z.string().trim().min(1, `${label} is required`).max(max);

const textBlock = z.object({
  type: z.literal('text'),
  text: z.string().trim().max(MAX_TEXT_LENGTH, `A text block can hold at most ${MAX_TEXT_LENGTH} characters`).default(''),
});
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Choose a six-digit hex color, such as #39738C');
const chartBlock = z.object({
  type: z.literal('chart'),
  title: z.string().trim().max(120).optional(),
  chartType: z.enum(CHART_TYPES).default('grouped_bar'),
  indicators: z.array(z.string()).max(25).default([]), // empty: chart every selected numeric indicator
  colors: z.record(z.string().min(1).max(100), colorSchema).optional(), // field key: series color
});
const tableBlock = z.object({
  type: z.literal('table'),
  indicators: z.array(z.string()).max(25).default([]), // empty: every indicator on the report
});

export const blockSchema = z.discriminatedUnion('type', [textBlock, chartBlock, tableBlock], {
  error: `Each block must be one of: ${BLOCK_TYPES.join(', ')}`,
});

/**
 * What a calculated field works out.
 *   ratio           numerator ÷ denominator for each row (clients per staff member)
 *   average         total ÷ number of rows: one value for the report (average population per town)
 *   average_filled  total ÷ rows with a value in the denominator column
 *   median, highest, lowest, total   of the numerator across the report's rows
 * Everything but ratio is a summary: one value for the whole report, never charted per row.
 */
export const CALCULATIONS = Object.freeze(['ratio', 'average', 'average_filled', 'median', 'highest', 'lowest', 'total']);
/** Calculations that need a second field. */
const NEEDS_DENOMINATOR = new Set(['ratio', 'average_filled']);

/** A new indicator computed on the server: numerator ÷ denominator × the format's multiplier. */
export const customIndicatorSchema = z.object({
  key: z.string().regex(/^ratio_\d{1,3}$/, 'Custom indicator keys look like ratio_1'),
  label: requiredText('Custom indicator name', 120),
  numerator: requiredText('Numerator field', 100),
  calculation: z.enum(CALCULATIONS).default('ratio'),
  // Summaries also show the same figure for every row of the dataset (all Connecticut towns).
  benchmark: z.boolean().default(true),
  denominator: z.string().trim().max(100).optional(),
  format: z.enum(Object.keys(RATIO_FORMATS)).default('ratio'),
  decimals: z.number().int().min(0).max(4).default(2),
}).strict();

export const DEFAULT_LAYOUT = Object.freeze([
  { type: 'chart', chartType: 'grouped_bar', indicators: [] },
  { type: 'table', indicators: [] },
]);

export const selectionSchema = z.preprocess(
  upgradeSelection,
  z
    .object({
      dataset: z.object(
        { name: requiredText('Dataset name', 200), vintage: requiredText('Dataset vintage', 50) },
        { error: 'Choose a dataset' },
      ),
      // Row names: towns in town-keyed datasets, otherwise values of the row label column.
      rows: z.array(requiredText('Row', 500)).max(MAX_NAMED_ROWS, `Name at most ${MAX_NAMED_ROWS} rows, or include all rows`).default([]),
      allRows: z.boolean().default(false),
      // What the report compares: a place type (town, county, region) or a text column key.
      compareBy: z.string().regex(/^(?:town|county|region|c\d{1,3})$/, 'Choose what to compare').optional(),
      benchmark: z.boolean().default(true),
      indicators: z.array(requiredText('Indicator', 100)).min(1, 'Select at least one indicator for the report').max(25),
      customIndicators: z.array(customIndicatorSchema).max(MAX_CUSTOM_INDICATORS, `A report can define at most ${MAX_CUSTOM_INDICATORS} custom indicators`).default([]),
      styleOverrides: reportStyleSchema.optional(),
      fieldOverrides: z.record(z.string().min(1).max(100), fieldPresentationSchema).optional(),
      showTitle: z.boolean().default(true),
      title: z.string().trim().max(200).default(''),
      subtitle: z.string().trim().max(300).default(''),
      recordFilters: z.record(z.string().regex(/^c\d+$/), z.string().max(4000)).default({}),
      layout: z
        .array(blockSchema)
        .max(MAX_LAYOUT_BLOCKS, `A report can hold at most ${MAX_LAYOUT_BLOCKS} blocks`)
        .default(() => DEFAULT_LAYOUT.map((block) => ({ ...block, indicators: [] }))),
    })
    .superRefine((s, ctx) => {
      if (!s.allRows && s.rows.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['rows'], message: 'Choose at least one row, or include all rows' });
      }
      const duplicateRow = findDuplicate(s.rows.map((row) => row.toLowerCase()));
      if (duplicateRow) ctx.addIssue({ code: 'custom', path: ['rows'], message: `"${duplicateRow}" is selected more than once` });

      const customKeys = s.customIndicators.map((custom) => custom.key);
      const duplicateCustom = findDuplicate(customKeys);
      if (duplicateCustom) {
        ctx.addIssue({ code: 'custom', path: ['customIndicators'], message: `"${duplicateCustom}" is defined more than once` });
      }
      s.customIndicators.forEach((custom, i) => {
        if (NEEDS_DENOMINATOR.has(custom.calculation) && !custom.denominator) {
          ctx.addIssue({ code: 'custom', path: ['customIndicators', i, 'denominator'], message: `${custom.label}: choose what to divide by` });
        }
        if (custom.calculation === 'ratio' && custom.numerator === custom.denominator) {
          ctx.addIssue({ code: 'custom', path: ['customIndicators', i, 'denominator'], message: `${custom.label}: choose two different fields` });
        }
      });

      const duplicateIndicator = findDuplicate(s.indicators);
      if (duplicateIndicator) {
        ctx.addIssue({ code: 'custom', path: ['indicators'], message: `"${duplicateIndicator}" is selected more than once` });
      }

      for (const key of Object.keys(s.fieldOverrides ?? {})) {
        if (!s.indicators.includes(key)) {
          ctx.addIssue({ code: 'custom', path: ['fieldOverrides', key], message: 'Customize only selected report fields' });
        }
      }

      s.layout.forEach((block, i) => {
        if (block.type === 'text') return;
        const unselected = block.indicators.find((key) => !s.indicators.includes(key));
        if (unselected) {
          const what = block.type === 'chart' ? 'Chart' : 'Table';
          ctx.addIssue({ code: 'custom', path: ['layout', i, 'indicators'], message: `${what} indicator "${unselected}" is not on the report` });
        }
      });

      if (!s.layout.some((block) => block.type !== 'text')) {
        ctx.addIssue({ code: 'custom', path: ['layout'], message: 'Include a chart or a table so the report shows its figures' });
      }
    }),
);

/** Apply every stored-shape upgrade, oldest first. */
export function upgradeSelection(input) {
  return renameTownsToRows(upgradeLegacySelection(input));
}

/** Reports saved before datasets could be keyed by any column stored `towns`. */
export function renameTownsToRows(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !('towns' in input) || 'rows' in input) {
    return input;
  }
  const { towns, ...rest } = input;
  return { ...rest, rows: towns };
}

/**
 * Convert the pre-layout selection shape ({ blocks: ['title', 'chart', 'table',
 * 'notes', 'source'], chart: { type, indicators }, notes }) so saved reports and the
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
