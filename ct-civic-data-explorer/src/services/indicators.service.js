/** Indicator definitions. Adding one lets a new CSV column load without a code change or migration. */
import { HttpError } from '../lib/http-error.js';
import * as indicators from '../repositories/indicators.js';

export function listIndicators() {
  return indicators.list();
}

export async function createIndicator(input) {
  const definition = { ...input };
  if (definition.derivation === 'ratio') {
    const parts = await indicators.findByKeys([definition.numeratorKey, definition.denominatorKey]);
    const direct = new Set(parts.filter((p) => p.derivation === 'direct').map((p) => p.key));
    if (!direct.has(definition.numeratorKey) || !direct.has(definition.denominatorKey)) {
      throw new HttpError(400, 'A ratio needs a numerator and a denominator that are existing, uploaded indicators');
    }
  } else {
    definition.numeratorKey = null;
    definition.denominatorKey = null;
  }

  try {
    return await indicators.create(definition);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `An indicator with key "${definition.key}" already exists`);
    throw err;
  }
}
