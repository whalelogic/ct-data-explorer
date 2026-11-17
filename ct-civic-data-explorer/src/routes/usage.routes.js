import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { readDashboard } from '../repositories/dataset-usage.js';

export const usageRouter = Router();

usageRouter.get('/', requireRole('admin'), async (_request, response) => {
  response.set('Cache-Control', 'no-store').json(await readDashboard());
});
