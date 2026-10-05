import { HttpError } from '../lib/http-error.js';

/**
 * Validate req[source] against a zod schema. The parsed result (defaults applied,
 * unknown keys stripped) is placed on req.valid[source]; handlers read only that.
 * @param {import('zod').ZodType} schema
 * @param {'body' | 'query' | 'params'} [source]
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return next(new HttpError(400, details[0]?.message ?? 'Invalid request', details));
    }
    req.valid = { ...req.valid, [source]: result.data };
    next();
  };
}
