/**
 * The data assistant: a chat that answers questions about published data and, for staff
 * and administrators, sets up reports in the builder.
 *
 * Claude runs on the server with read-only tools that call the same services as the rest
 * of the app, as the signed-in user, so it can never see more than they can:
 *   list_datasets, describe_dataset   published datasets and their approved fields
 *   get_figures                       values and summaries, from town (indicator) datasets only
 *   propose_report                    a validated report setup the user can apply (staff/admin)
 *
 * Privacy matches AI summary drafting: values from uploaded record datasets (names, notes,
 * any row-level content) never leave the server. Only field metadata and Connecticut place
 * names do. Credentials resolve from the environment and never reach the browser.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { HttpError } from '../../lib/http-error.js';
import * as datasets from '../../repositories/datasets.js';
import { getReportOptions, listDatasets } from '../datasets.service.js';
import { presentDataset } from '../presenters.js';
import { buildReport } from '../reports.service.js';
import { CALCULATIONS, selectionSchema } from '../selection.js';

const MAX_TOOL_ROUNDS = 8;
/** Tool results are capped so one large answer cannot crowd out the conversation. */
const MAX_TOOL_RESULT_CHARS = 60_000;
const SUMMARY_CALCULATIONS = CALCULATIONS.filter((calculation) => calculation !== 'ratio' && calculation !== 'average_filled');

/** Who may have the assistant set up reports. One place to change when roles grow. */
export function canGenerateReports(user) {
  return user.role === 'staff' || user.role === 'admin';
}

export function isAssistantAvailable() {
  return config.ai.provider === 'anthropic' || Boolean(client);
}

const SYSTEM_PROMPT = `You are the data assistant inside CT Civic Data Explorer, a tool from CTData Collaborative (a Connecticut nonprofit) for exploring published public data and building reports about Connecticut towns and other topics.

How the app works, in the words people see:
- A dataset has rows (the things being compared: towns, counties, planning regions, or something else such as programs) and fields (what is shown for each row, such as Population).
- The report builder has four steps: Compare (pick the dataset, what to compare and which ones), Show (tick fields, optionally add calculated fields such as an average per town), Layout (charts, tables and text) and Finish (title, Save report, Export PDF).
- Calculated fields can give one number for the whole report (average, median, highest, lowest or total), shown beside the same figure for all of Connecticut.

How to help:
- Answer questions about the data only from your tools. Never estimate, recall or invent a figure; if a tool cannot provide it, say so plainly.
- Quote figures exactly as the tools format them. Do not calculate new numbers yourself. To get an average, median, highest, lowest or total, ask get_figures for a summary instead.
- Use describe_dataset to find exact field keys and names before calling get_figures or propose_report.
- Values from record datasets are private and the tools will not return them. You can still explain those datasets' fields and help set up reports with them.
- When the person asks you to build, fill in, set up or change a report, call propose_report. They will see an Apply button; tell them in one sentence what you set up. If propose_report says they are not allowed, explain that report generation is limited to staff and administrators, and offer to answer questions instead.
- If the request is unclear, ask one short question rather than guessing.

Style: brief, friendly and plain. Two to five short sentences, or a short list using "- " bullets. Use the dataset's field names and say "towns", not "rows", when the rows are towns. No headings, tables or code.`;

/** Tool definitions are fixed, so the prompt cache prefix (tools, then system) stays stable. */
const TOOLS = [
  {
    name: 'list_datasets',
    description: 'List the published datasets: id, name, reporting period, source and whether values can be read with get_figures.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'describe_dataset',
    description: 'Describe one dataset: its fields (key, name, unit, type, description), what its rows can be compared by (with Connecticut place names when the rows are places), and whether a statewide total exists.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { dataset_id: { type: 'integer', description: 'Dataset id from list_datasets.' } },
      required: ['dataset_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_figures',
    description: 'Read values from a town (indicator) dataset for chosen places and fields, and optionally summaries across those places (average, median, highest, lowest, total) with the same figure for all of Connecticut. Leave places empty to use every place of the chosen kind.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        dataset_id: { type: 'integer' },
        compare_by: { type: 'string', enum: ['town', 'county', 'region'], description: 'Kind of place. Usually town.' },
        places: { type: 'array', items: { type: 'string' }, description: 'Place names exactly as describe_dataset lists them. Empty means all.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Field keys to read for each place.' },
        include_statewide: { type: 'boolean', description: 'Also return the Connecticut statewide row.' },
        summaries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', description: 'Field key to summarize.' },
              calculation: { type: 'string', enum: SUMMARY_CALCULATIONS },
            },
            required: ['field', 'calculation'],
            additionalProperties: false,
          },
        },
      },
      required: ['dataset_id', 'compare_by', 'places', 'fields', 'include_statewide', 'summaries'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_report',
    description: 'Set up a report for the person to review and apply in the report builder. Checks that it builds. Use field keys and compare ids from describe_dataset.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        dataset_id: { type: 'integer' },
        compare_by: { type: 'string', description: 'A compare id from describe_dataset, e.g. "town", "county" or a column key such as "c1".' },
        rows: { type: 'array', items: { type: 'string' }, description: 'Names of the rows to include, e.g. town names. Empty means every row.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Field keys to show, in order.' },
        summaries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              calculation: { type: 'string', enum: SUMMARY_CALCULATIONS },
              name: { type: 'string', description: 'Short name, e.g. "Average population per town".' },
            },
            required: ['field', 'calculation', 'name'],
            additionalProperties: false,
          },
        },
        include_statewide: { type: 'boolean', description: 'Add the Connecticut statewide row beside places.' },
        title: { type: 'string', description: 'Report title, or empty for the default.' },
      },
      required: ['dataset_id', 'compare_by', 'rows', 'fields', 'summaries', 'include_statewide', 'title'],
      additionalProperties: false,
    },
  },
];

let client;
/** Tests replace the Claude client with a scripted one; production never calls this. */
export function setAssistantClientForTests(replacement) {
  client = replacement;
}

function getClient() {
  // Tool rounds add up, so the assistant gets a longer budget than summary drafting.
  client ??= new Anthropic({ timeout: 60_000, maxRetries: 1 });
  return client;
}

/**
 * @param {{ role: 'user'|'assistant', content: string }[]} history plain-text turns, last one the user's
 * @param {{ page?: string, datasetId?: number, selection?: object }} context what the person is looking at
 * @param {{ id: number, role: string }} user
 * @returns {Promise<{ reply: string, proposal: object | null }>}
 */
export async function askAssistant(history, context, user) {
  if (!isAssistantAvailable()) {
    throw new HttpError(503, 'The assistant is not set up on this server.');
  }
  const state = { proposal: null };
  const messages = history.map((turn) => ({ role: turn.role, content: turn.content }));
  const last = messages.at(-1);
  last.content = [
    { type: 'text', text: await describeContext(context, user) },
    { type: 'text', text: last.content },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callClaude(messages);
    if (response.stop_reason === 'refusal') {
      return { reply: 'I can’t help with that one. Try asking about the data or your report.', proposal: null };
    }
    messages.push({ role: 'assistant', content: response.content });
    const toolUses = response.content.filter((block) => block.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const reply = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
      return { reply: reply || 'Sorry, I don’t have an answer for that.', proposal: state.proposal };
    }
    // All results go back in one user message, so parallel tool calls keep working.
    const results = [];
    for (const toolUse of toolUses) {
      results.push(await runTool(toolUse, user, state));
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'That took more steps than I can manage at once. Try a narrower question.', proposal: state.proposal };
}

async function callClaude(messages) {
  try {
    return await getClient().beta.messages.create({
      model: config.ai.model,
      max_tokens: 16000,
      // If the model declines, the API re-runs the request on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: config.ai.effort },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
  } catch (err) {
    console.error(`[ai] assistant request failed: ${describeApiError(err)}`);
    throw new HttpError(502, 'The assistant is unavailable right now. Try again in a moment.');
  }
}

function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'authentication failed; check ANTHROPIC_API_KEY';
  if (err instanceof Anthropic.RateLimitError) return 'rate limited by the Claude API';
  if (err instanceof Anthropic.BadRequestError) return `bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'the Claude API timed out';
  if (err instanceof Anthropic.APIConnectionError) return 'could not reach the Claude API';
  if (err instanceof Anthropic.APIError) return `API error ${err.status}`;
  return err.message;
}

/** A short note on what the person is looking at, so "this dataset" and "my report" make sense. */
async function describeContext(context, user) {
  const lines = ['[App context, not written by the person]'];
  lines.push(`Signed-in role: ${user.role}. Can generate reports: ${canGenerateReports(user) ? 'yes' : 'no'}.`);
  if (context.page) {
    lines.push(`Page: ${context.page}.`);
  }
  if (context.datasetId) {
    const dataset = await datasets.findById(context.datasetId);
    if (dataset && (dataset.is_active || user.role === 'admin')) {
      lines.push(`Open dataset: id ${dataset.id}, "${presentDataset(dataset).displayName}" (${dataset.vintage}).`);
    }
  }
  const selection = context.selection;
  if (selection) {
    const rows = selection.allRows ? 'every row' : (selection.rows ?? []).slice(0, 20).join(', ') || 'nothing yet';
    const fields = (selection.indicators ?? []).slice(0, 20).join(', ') || 'nothing yet';
    lines.push(`Report being built: comparing ${selection.compareBy ?? 'the default'}: ${rows}. Field keys shown: ${fields}.`);
  }
  return lines.join('\n');
}

async function runTool(toolUse, user, state) {
  try {
    const output = await TOOL_HANDLERS[toolUse.name](toolUse.input ?? {}, user, state);
    let content = JSON.stringify(output);
    if (content.length > MAX_TOOL_RESULT_CHARS) {
      content = `${content.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated; ask for fewer places or fields]`;
    }
    return { type: 'tool_result', tool_use_id: toolUse.id, content };
  } catch (err) {
    // Expected problems (unknown field, private data) go back to Claude to correct; others are logged.
    if (!(err instanceof HttpError)) {
      console.error(`[ai] assistant tool ${toolUse.name} failed: ${err.message}`);
    }
    const message = err instanceof HttpError ? err.message : 'That lookup failed.';
    return { type: 'tool_result', tool_use_id: toolUse.id, content: message, is_error: true };
  }
}

const TOOL_HANDLERS = {
  async list_datasets() {
    const rows = await listDatasets({ activeOnly: true });
    return rows.map((row) => {
      const dataset = presentDataset(row);
      return {
        id: dataset.id,
        name: dataset.displayName,
        reportingPeriod: dataset.vintage,
        source: dataset.source,
        description: dataset.description || undefined,
        rows: dataset.rowCount,
        valuesReadable: dataset.dataFormat !== 'records',
      };
    });
  },

  async describe_dataset({ dataset_id: datasetId }, user) {
    const dataset = await requireDataset(datasetId, user);
    const options = await getReportOptions(datasetId, user);
    return {
      id: dataset.id,
      name: presentDataset(dataset).displayName,
      reportingPeriod: dataset.vintage,
      valuesReadable: dataset.data_format !== 'records',
      fields: options.columns.map((field) => ({
        key: field.key,
        name: field.displayLabel || field.label,
        type: field.type === 'text' ? 'text' : 'number',
        unit: field.unit,
        description: field.description || undefined,
      })),
      compareBy: (options.compareOptions ?? []).map((option) => ({
        id: option.id,
        name: option.label,
        count: option.values.length,
        // Connecticut place names are public; other row labels come from the uploaded file.
        ...(option.kind === 'place' ? { values: option.values } : {}),
      })),
      defaultCompare: options.defaultCompare,
      hasStatewide: Boolean(options.hasState),
    };
  },

  async get_figures(input, user) {
    const dataset = await requireDataset(input.dataset_id, user);
    if (dataset.data_format === 'records') {
      throw new HttpError(403, 'Values from this record dataset are private and cannot be read by the assistant. Describe its fields instead.');
    }
    const summaries = input.summaries.slice(0, 6).map((summary, index) => ({
      key: `ratio_${index + 1}`,
      label: `${summary.calculation} of ${summary.field}`,
      numerator: summary.field,
      calculation: summary.calculation,
      decimals: 2,
    }));
    const selection = parseSelection({
      dataset: { name: dataset.name, vintage: dataset.vintage },
      compareBy: input.compare_by,
      rows: input.places.slice(0, 200),
      allRows: input.places.length === 0,
      benchmark: input.include_statewide,
      indicators: [...input.fields.slice(0, 25), ...summaries.map((summary) => summary.key)],
      customIndicators: summaries,
      layout: [{ type: 'table' }],
    });
    const report = await buildReport(selection);
    const places = report.places.map((place) => place.label);
    return {
      places,
      values: Object.fromEntries(report.indicators.map((row) => [
        row.displayLabel,
        Object.fromEntries(row.cells.map((cell, index) => [places[index], cell.display])),
      ])),
      summaries: (report.summaries ?? []).map((summary) => ({
        what: summary.label,
        value: summary.display,
        over: summary.detail,
        connecticut: summary.benchmark ? { label: summary.benchmark.label, value: summary.benchmark.display } : undefined,
      })),
    };
  },

  async propose_report(input, user, state) {
    if (!canGenerateReports(user)) {
      throw new HttpError(403, 'Only staff and administrators can have the assistant set up reports.');
    }
    const dataset = await requireDataset(input.dataset_id, user);
    const summaries = input.summaries.slice(0, 6).map((summary, index) => ({
      key: `ratio_${index + 1}`,
      label: summary.name.slice(0, 120) || `${summary.calculation} ${summary.field}`,
      numerator: summary.field,
      calculation: summary.calculation,
      decimals: 0,
    }));
    const selection = parseSelection({
      dataset: { name: dataset.name, vintage: dataset.vintage },
      compareBy: input.compare_by,
      rows: input.rows.slice(0, 200),
      allRows: input.rows.length === 0,
      benchmark: input.include_statewide,
      indicators: [...input.fields.slice(0, 25), ...summaries.map((summary) => summary.key)],
      customIndicators: summaries,
      title: input.title.slice(0, 200),
    });
    // Building it proves every row and field exists and is approved; the figures stay here.
    const report = await buildReport(selection);
    state.proposal = { datasetId: dataset.id, selection };
    const rowCount = report.places.filter((place) => place.geoType !== 'state').length;
    return {
      ok: true,
      title: report.title,
      rows: rowCount,
      fields: report.indicators.map((row) => row.displayLabel),
      summaries: (report.summaries ?? []).map((summary) => summary.label),
      note: 'The person now sees an Apply button for this report.',
    };
  },
};

async function requireDataset(datasetId, user) {
  const dataset = await datasets.findById(datasetId);
  if (!dataset || (!dataset.is_active && user.role !== 'admin')) {
    throw new HttpError(404, `There is no published dataset with id ${datasetId}.`);
  }
  if (!dataset.is_active) {
    throw new HttpError(400, 'That dataset is a draft. Publish it before building reports with it.');
  }
  return dataset;
}

function parseSelection(input) {
  const parsed = selectionSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}
