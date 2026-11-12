/** The audit trail, for administrators. Read-only: entries are written by services/audit.js. */
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AUDIT_CATEGORIES, listAudit } from '../services/audit.js';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
});

export const auditRouter = Router();
auditRouter.use(requireRole('admin'));

auditRouter.get('/', validate(listQuery, 'query'), async (req, res) => {
  res.json(await listAudit(req.valid.query));
});
