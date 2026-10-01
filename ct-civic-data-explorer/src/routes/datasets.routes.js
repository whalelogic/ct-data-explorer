import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { idParams } from '../lib/schemas.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getDatasetOverview, getReportOptions, listDatasets, setDatasetActive, uploadDataset } from '../services/datasets.service.js';
import { presentDataset } from '../services/presenters.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 10 },
});

const uploadFields = z.object({
  name: z.string().trim().min(1, 'Dataset name is required').max(200),
  source: z.string().trim().min(1, 'Source is required').max(300),
  vintage: z.string().trim().min(1, 'Vintage is required').max(50),
  worksheet: z.string().trim().max(100).optional(),
  activate: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export const datasetsRouter = Router();

/** Staff see active versions (what cards can use); admins see every version. */
datasetsRouter.get('/', async (req, res) => {
  const rows = await listDatasets({ activeOnly: req.user.role !== 'admin' });
  res.json(rows.map(presentDataset));
});

datasetsRouter.get('/:id', validate(idParams, 'params'), validate(z.object({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}), 'query'), async (req, res) => {
  res.json(await getDatasetOverview(req.valid.params.id, req.valid.query, req.user));
});

datasetsRouter.get('/:id/report-options', validate(idParams, 'params'), async (req, res) => {
  res.json(await getReportOptions(req.valid.params.id, req.user));
});

datasetsRouter.post('/', requireRole('admin'), upload.single('file'), validate(uploadFields), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a CSV or Excel (.xlsx) file to upload');
  const dataset = await uploadDataset({ file: req.file.buffer, filename: req.file.originalname, ...req.valid.body }, req.user);
  res.status(201).json(presentDataset(dataset));
});

datasetsRouter.patch(
  '/:id',
  requireRole('admin'),
  validate(idParams, 'params'),
  validate(z.object({ isActive: z.boolean() })),
  async (req, res) => {
    res.json(presentDataset(await setDatasetActive(req.valid.params.id, req.valid.body.isActive)));
  },
);
