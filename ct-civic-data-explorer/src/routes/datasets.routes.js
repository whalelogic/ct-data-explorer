import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { idParams } from '../lib/schemas.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  getDatasetCuration,
  getDatasetOverview,
  getReportOptions,
  listDatasets,
  setDatasetActive,
  updateDatasetCuration,
  uploadDataset,
} from '../services/datasets.service.js';
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
  activate: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
});

const previewQuery = z.object({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const curationFields = z.object({
  approvedFields: z.array(z.string().trim().min(1).max(100)).max(250),
});

const publicationFields = z.object({
  isActive: z.boolean(),
});

export const datasetsRouter = Router();

/** Staff see active versions (what cards can use); admins see every version. */
datasetsRouter.get('/', async (request, response) => {
  const activeOnly = request.user.role !== 'admin';
  const datasets = await listDatasets({ activeOnly });
  response.json(datasets.map(presentDataset));
});

datasetsRouter.get(
  '/:id',
  validate(idParams, 'params'),
  validate(previewQuery, 'query'),
  async (request, response) => {
    const overview = await getDatasetOverview(request.valid.params.id, request.valid.query, request.user);
    response.json(overview);
  },
);

datasetsRouter.get(
  '/:id/report-options',
  validate(idParams, 'params'),
  async (request, response) => {
    const options = await getReportOptions(request.valid.params.id, request.user);
    response.json(options);
  },
);

datasetsRouter.get(
  '/:id/curation',
  requireRole('admin'),
  validate(idParams, 'params'),
  async (request, response) => {
    const curation = await getDatasetCuration(request.valid.params.id, request.user);
    response.json(curation);
  },
);

datasetsRouter.put(
  '/:id/curation',
  requireRole('admin'),
  validate(idParams, 'params'),
  validate(curationFields),
  async (request, response) => {
    const datasetId = request.valid.params.id;
    const approvedFields = request.valid.body.approvedFields;
    const curation = await updateDatasetCuration(datasetId, approvedFields, request.user);
    response.json(curation);
  },
);

datasetsRouter.post(
  '/',
  requireRole('admin'),
  upload.single('file'),
  validate(uploadFields),
  async (request, response) => {
    if (!request.file) {
      throw new HttpError(400, 'Choose a CSV or Excel (.xlsx) file to upload');
    }
    const uploadDetails = {
      file: request.file.buffer,
      filename: request.file.originalname,
      ...request.valid.body,
    };
    const dataset = await uploadDataset(uploadDetails, request.user);
    response.status(201).json(presentDataset(dataset));
  },
);

datasetsRouter.patch(
  '/:id',
  requireRole('admin'),
  validate(idParams, 'params'),
  validate(publicationFields),
  async (request, response) => {
    const datasetId = request.valid.params.id;
    const isActive = request.valid.body.isActive;
    const dataset = await setDatasetActive(datasetId, isActive);
    response.json(presentDataset(dataset));
  },
);