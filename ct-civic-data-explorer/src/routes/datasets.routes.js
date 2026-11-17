import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { idParams } from '../lib/schemas.js';
import { requireRole, requireSignedIn } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import {
  getDatasetCuration,
  getDatasetPresentation,
  getDatasetRowLabel,
  inspectUpload,
  setDatasetRowLabel,
  updateDatasetPresentation,
  getDatasetOverview,
  getReportOptions,
  listDatasets,
  setDatasetActive,
  updateDatasetCuration,
  uploadDataset,
} from '../services/datasets.service.js';
import { presentDataset } from '../services/presenters.js';
import { datasetPresentationSchema } from '../services/presentation.js';
import { trackDatasetUsage } from '../services/dataset-usage.js';

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
  // The column that identifies each row; without it a single "Town" column is required.
  labelColumn: z.string().trim().max(200).optional().transform((value) => value || undefined),
  labelIsTown: z.enum(['true', 'false']).optional().transform((value) => (value === undefined ? undefined : value === 'true')),
});

const inspectFields = z.object({
  worksheet: z.string().trim().max(100).optional(),
});

const rowLabelFields = z.object({
  rowLabelKey: z.string().regex(/^c\d{1,3}$/, 'Choose a column from this dataset'),
});

const reportOptionsQuery = z.object({ compareBy: rowLabelFields.shape.rowLabelKey.optional() });

const previewQuery = z.object({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const listQuery = z.object({ scope: z.enum(['public', 'private']).optional() });

const curationFields = z.object({
  approvedFields: z.array(z.string().trim().min(1).max(100)).max(250),
});

const publicationFields = z.object({
  isActive: z.boolean(),
});

export const datasetsRouter = Router();

/** Administrators also see public drafts. Private uploads belong to the current user. */
datasetsRouter.get('/', validate(listQuery, 'query'), async (request, response) => {
  const user = request.user;
  if (!user && request.valid.query.scope === 'private') throw new HttpError(401, 'Please sign in');
  const datasets = await listDatasets({
    activeOnly: user?.role !== 'admin',
    scope: request.valid.query.scope,
    user,
  });
  response.json(datasets.map((dataset) => presentDataset(dataset, { includeUploadDetails: Boolean(user) })));
});

datasetsRouter.get(
  '/:id',
  validate(idParams, 'params'),
  validate(previewQuery, 'query'),
  async (request, response) => {
    const overview = await getDatasetOverview(request.valid.params.id, request.valid.query, request.user);
    if (request.valid.query.offset === 0) await trackDatasetUsage('view', overview.dataset.id);
    response.json(overview);
  },
);

datasetsRouter.get(
  '/:id/report-options',
  validate(idParams, 'params'),
  validate(reportOptionsQuery, 'query'),
  async (request, response) => {
    const options = await getReportOptions(request.valid.params.id, request.user, request.valid.query);
    await trackDatasetUsage('access', request.valid.params.id);
    response.json(options);
  },
);

datasetsRouter.use(requireSignedIn, csrfProtection);

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
  '/inspect',
  requireRole('admin'),
  upload.single('file'),
  validate(inspectFields),
  sendInspection,
);

datasetsRouter.post('/private/inspect', upload.single('file'), validate(inspectFields), sendInspection);

datasetsRouter.post(
  '/',
  requireRole('admin'),
  upload.single('file'),
  validate(uploadFields),
  (request, response) => sendUpload(request, response),
);

datasetsRouter.post('/private', upload.single('file'), validate(uploadFields), (request, response) => (
  sendUpload(request, response, { privateUpload: true })
));

function uploadedFile(request) {
  if (!request.file) throw new HttpError(400, 'Choose a CSV or Excel (.xlsx) file to upload');
  return { file: request.file.buffer, filename: request.file.originalname };
}

async function sendInspection(request, response) {
  const inspection = await inspectUpload({ ...uploadedFile(request), ...request.valid.body });
  response.json(inspection);
}

async function sendUpload(request, response, options) {
  const dataset = await uploadDataset({ ...uploadedFile(request), ...request.valid.body }, request.user, options);
  response.status(201).json(presentDataset(dataset));
}

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

datasetsRouter.get('/:id/presentation', validate(idParams, 'params'), async (request, response) => {
  response.json(await getDatasetPresentation(request.valid.params.id, request.user));
});

datasetsRouter.put('/:id/presentation', validate(idParams, 'params'), validate(datasetPresentationSchema), async (request, response) => {
  response.json(await updateDatasetPresentation(request.valid.params.id, request.valid.body, request.user));
});

/** Staff and administrators choose which column labels a source-row dataset's rows. */
datasetsRouter.get('/:id/row-label', validate(idParams, 'params'), async (request, response) => {
  response.json(await getDatasetRowLabel(request.valid.params.id, request.user));
});

datasetsRouter.put('/:id/row-label', validate(idParams, 'params'), validate(rowLabelFields), async (request, response) => {
  response.json(await setDatasetRowLabel(request.valid.params.id, request.valid.body.rowLabelKey, request.user));
});
