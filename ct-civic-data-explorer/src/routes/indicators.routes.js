import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createIndicator, listIndicators } from '../services/indicators.service.js';
import { presentIndicator } from '../services/presenters.js';

const indicatorKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]+$/, 'Keys may contain only letters, digits and underscores')
  .max(60);

const indicatorSchema = z
  .object({
    key: indicatorKeySchema,
    label: z.string().trim().min(1, 'Label is required').max(120),
    unit: z.enum(['count', 'currency', 'percent', 'density', 'area']),
    decimals: z.coerce.number().int().min(0).max(4).default(0),
    derivation: z.enum(['direct', 'ratio']).default('direct'),
    numeratorKey: indicatorKeySchema.optional(),
    denominatorKey: indicatorKeySchema.optional(),
  })
  .refine(
    hasRequiredRatioKeys,
    { message: 'A ratio needs a numerator key and a denominator key', path: ['numeratorKey'] },
  );

export const indicatorsRouter = Router();

indicatorsRouter.get('/', requireRole('admin'), listIndicatorsHandler);
indicatorsRouter.post('/', requireRole('admin'), validate(indicatorSchema), createIndicatorHandler);

function hasRequiredRatioKeys(indicator) {
  return indicator.derivation === 'direct' || (indicator.numeratorKey && indicator.denominatorKey);
}

async function listIndicatorsHandler(_request, response) {
  const indicators = await listIndicators();
  response.json(indicators.map(presentIndicator));
}

async function createIndicatorHandler(request, response) {
  const indicator = await createIndicator(request.valid.body);
  response.status(201).json(presentIndicator(indicator));
}
