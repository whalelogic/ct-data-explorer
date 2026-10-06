import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createIndicator, listIndicators } from '../services/indicators.service.js';
import { presentIndicator } from '../services/presenters.js';

const key = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]+$/, 'Keys may contain only letters, digits and underscores')
  .max(60);

const indicatorSchema = z
  .object({
    key,
    label: z.string().trim().min(1, 'Label is required').max(120),
    unit: z.enum(['count', 'currency', 'percent', 'density', 'area']),
    decimals: z.coerce.number().int().min(0).max(4).default(0),
    derivation: z.enum(['direct', 'ratio']).default('direct'),
    numeratorKey: key.optional(),
    denominatorKey: key.optional(),
  })
  .refine(
    (v) => v.derivation === 'direct' || (v.numeratorKey && v.denominatorKey),
    { message: 'A ratio needs a numerator key and a denominator key', path: ['numeratorKey'] },
  );

export const indicatorsRouter = Router();

indicatorsRouter.get('/', async (_req, res) => {
  res.json((await listIndicators()).map(presentIndicator));
});

indicatorsRouter.post('/', requireRole('admin'), validate(indicatorSchema), async (req, res) => {
  res.status(201).json(presentIndicator(await createIndicator(req.valid.body)));
});
