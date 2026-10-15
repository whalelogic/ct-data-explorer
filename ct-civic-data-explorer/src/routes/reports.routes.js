import { Router } from 'express';
import { z } from 'zod';
import { idParams } from '../lib/schemas.js';
import { validate } from '../middleware/validate.js';
import { draftSummary } from '../services/ai/index.js';
import {
  buildReport,
  createReport,
  deleteReport,
  duplicateReport,
  getReport,
  listReports,
  parseStoredSelection,
  updateReport,
} from '../services/reports.service.js';
import { reportFilename, renderReportPdf } from '../services/pdf/index.js';
import { presentReport } from '../services/presenters.js';
import { selectionSchema } from '../services/selection.js';

const reportTitle = z.string().trim().min(1, 'Give the report a name').max(200);
const createSchema = z.object({ title: reportTitle, selection: selectionSchema });
const updateSchema = z.object({ title: reportTitle.optional(), selection: selectionSchema.optional() });
const listQuery = z.object({ q: z.string().trim().max(100).optional() });

export const reportsRouter = Router();

// Working with an unsaved selection.

reportsRouter.post('/preview', validate(selectionSchema), async (req, res) => {
  res.json(await buildReport(req.valid.body));
});

reportsRouter.post('/pdf', validate(selectionSchema), async (req, res) => {
  await sendPdf(res, await buildReport(req.valid.body));
});

reportsRouter.post('/summary', validate(selectionSchema), async (req, res) => {
  res.json(await draftSummary(await buildReport(req.valid.body)));
});

// Saved report library.

reportsRouter.get('/', validate(listQuery, 'query'), async (req, res) => {
  res.json((await listReports(req.valid.query.q)).map(presentReport));
});

reportsRouter.post('/', validate(createSchema), async (req, res) => {
  res.status(201).json(presentReport(await createReport(req.valid.body, req.user)));
});

reportsRouter.get('/:id', validate(idParams, 'params'), async (req, res) => {
  res.json(presentReport(await getReport(req.valid.params.id)));
});

reportsRouter.put('/:id', validate(idParams, 'params'), validate(updateSchema), async (req, res) => {
  res.json(presentReport(await updateReport(req.valid.params.id, req.valid.body, req.user)));
});

reportsRouter.post('/:id/duplicate', validate(idParams, 'params'), async (req, res) => {
  res.status(201).json(presentReport(await duplicateReport(req.valid.params.id, req.user)));
});

reportsRouter.delete('/:id', validate(idParams, 'params'), async (req, res) => {
  await deleteReport(req.valid.params.id, req.user);
  res.status(204).end();
});

/** Re-render a saved report against current data. */
reportsRouter.get('/:id/pdf', validate(idParams, 'params'), async (req, res) => {
  const report = await getReport(req.valid.params.id);
  await sendPdf(res, await buildReport(parseStoredSelection(report.selection)));
});

async function sendPdf(res, report) {
  // Render fully before sending headers, so a failure returns an error, never an empty file.
  const pdf = await renderReportPdf(report);
  res.attachment(reportFilename(report)).set('Cache-Control', 'no-store').send(pdf);
}
