/** Group picker choices without changing saved report order or field identity. */
import { unitLabel } from './format.js';

export function fieldUnitLabel(field) {
  if (field.type === 'text') return 'Text / category';
  if (!field.unit || field.unit === 'number') return 'Number';
  return unitLabel(field.unit);
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
