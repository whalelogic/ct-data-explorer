import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AI_PROVIDER_IDS, readAiSettings, updateAiSettings } from '../services/ai/providers.js';

const settingsSchema = z.object({
  provider: z.enum(AI_PROVIDER_IDS),
  model: z.string().trim().max(200).regex(/^(?:[A-Za-z0-9][A-Za-z0-9._/:@+-]*)?$/, 'Enter a valid model ID').optional(),
});

export const aiSettingsRouter = Router();
aiSettingsRouter.use(requireRole('admin'));

aiSettingsRouter.get('/', async (_req, res) => {
  res.json(await readAiSettings());
});

aiSettingsRouter.put('/', validate(settingsSchema), async (req, res) => {
  const { provider, model } = req.valid.body;
  res.json(await updateAiSettings(provider, model));
});
