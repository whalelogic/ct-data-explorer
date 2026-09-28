import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { idParams } from '../lib/schemas.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { listDatasets, setDatasetActive, uploadDataset } from '../services/datasets.service.js';
import { presentDataset } from '../services/presenters.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 10 },
});

const uploadFields = z.object({
  name: z.string().trim().min(1, 'Dataset name is required').max(200),
  source: z.string().trim().min(1, 'Source is required').max(300),
  vintage: z.string().trim().min(1, 'Vintage is required').max(50),
  activate: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export const datasetsRouter = Router();

/** Staff see active versions (what cards can use); admins see every version. */
datasetsRouter.get('/', async (req, res) => {
  const rows = await listDatasets({ activeOnly: req.user.role !== 'admin' });
  res.json(rows.map(presentDataset));
});

datasetsRouter.post('/', requireRole('admin'), upload.single('file'), validate(uploadFields), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a CSV file to upload');
  const dataset = await uploadDataset({ file: req.file.buffer, ...req.valid.body }, req.user);
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
