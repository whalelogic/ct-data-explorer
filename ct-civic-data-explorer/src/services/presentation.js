/** Display-only settings never change keys, source values, units or calculations. */
import { z } from 'zod';
import { indicatorLabel } from '../shared/format.js';

export const fieldPresentationSchema = z.object({
  label: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
  decimals: z.number().int().min(0).max(4).optional(),
}).strict();

export const datasetPresentationSchema = z.object({
  revision: z.number().int().min(0),
  displayName: z.string().trim().max(200).default(''),
  description: z.string().trim().max(2000).default(''),
  defaultChartType: z.enum(['grouped_bar', 'bar', 'line']).default('grouped_bar'),
  fieldOrder: z.array(z.string().min(1).max(100)).max(250).default([]),
  fields: z.record(z.string().min(1).max(100), fieldPresentationSchema).default({}),
}).strict();

export function applyFieldPresentation(fields, presentation = {}, overrides = {}) {
  const settings = presentation ?? {};
  const order = new Map((settings.fieldOrder ?? []).map((key, index) => [key, index]));
  const result = fields.map((field) => {
    const shared = settings.fields?.[field.key] ?? {};
    const local = overrides?.[field.key] ?? {};
    const label = local.label || shared.label || field.label;
    const customized = {
      ...field,
      label,
      description: local.description ?? shared.description ?? field.description ?? '',
      decimals: field.type === 'text' ? field.decimals : local.decimals ?? shared.decimals ?? field.decimals,
    };
    customized.displayLabel = field.derivation ? indicatorLabel(customized) : label;
    return customized;
  });
  // Geography stays first. Unordered fields keep their original relative order.
  result.sort((first, second) => {
    if (first.role === 'town') return second.role === 'town' ? 0 : -1;
    if (second.role === 'town') return 1;
    return (order.get(first.key) ?? Infinity) - (order.get(second.key) ?? Infinity);
  });
  return result;
}


export function appendFieldNotes(blocks, fields) {
  const described = fields.filter((field) => field.description);
  if (!described.length) return;
  const nodes = [{ type: 'heading', level: 2, runs: [{ text: 'Field notes' }] }];
  for (const field of described) {
    nodes.push({ type: 'paragraph', runs: [{ text: `${field.label}: `, bold: true }, { text: field.description }] });
  }
  blocks.push({ type: 'text', nodes });
}
