/** Group picker choices without changing saved report order or field identity. */
import { unitLabel } from './format.js';

export function fieldUnitLabel(field) {
  if (field.type === 'text') return 'Text / category';
  if (!field.unit || field.unit === 'number') return 'Number';
  return unitLabel(field.unit);
}

/** Filter option labels follow display units while option values retain source identity. */
export function fieldValueLabel(field, value) {
  if (field.type !== 'number' || !Number.isFinite(Number(value))) return String(value);
  const scaled = Number(value) * (field.scale ?? 1);
  const formatted = scaled.toLocaleString('en-US', {
    minimumFractionDigits: field.unit === 'percent' ? field.decimals ?? 1 : 0,
    maximumFractionDigits: field.decimals ?? 9,
  });
  if (field.unit === 'percent') return `${formatted}%`;
  return field.unit === 'currency' ? `$${formatted}` : formatted;
}

export function groupFieldsByUnit(fields) {
  const groups = new Map();
  for (const field of fields) {
    const key = field.type === 'text' ? 'text' : field.unit || 'number';
    if (!groups.has(key)) groups.set(key, { key, label: fieldUnitLabel(field), fields: [] });
    groups.get(key).fields.push(field);
  }
  return [...groups.values()];
}
