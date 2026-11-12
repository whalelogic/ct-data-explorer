import { Router } from 'express';
import { z } from 'zod';
import { idParams } from '../lib/schemas.js';
import { pdfLimiter, summaryLimiter } from '../middleware/rate-limits.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import { draftSummary } from '../services/ai/index.js';
import {
  buildReport,
  createReport,
  deleteReport,
  duplicateReport,
  getReport,
  getReportView,
  listReports,
  savedSelection,
  updateReport,
} from '../services/reports.service.js';
import { reportFilename, renderReportPdf } from '../services/pdf/index.js';
import { presentReport } from '../services/presenters.js';
import { selectionSchema } from '../services/selection.js';
import { SLUG_PATTERN } from '../services/slugs.js';

const reportTitle = z.string().trim().min(1, 'Give the report a name').max(200);
const createSchema = z.object({ title: reportTitle, selection: selectionSchema });
const updateSchema = z.object({ title: reportTitle.optional(), selection: selectionSchema.optional() });
const listQuery = z.object({ q: z.string().trim().max(100).optional() });
const slugParams = z.object({ slug: z.string().regex(SLUG_PATTERN, 'Report not found').max(80) });

export const reportsRouter = Router();

// Working with an unsaved selection.

reportsRouter.post('/preview', validate(selectionSchema), async (req, res) => {
  res.json(await buildReport(req.valid.body));
});

reportsRouter.post('/pdf', pdfLimiter, validate(selectionSchema), async (req, res) => {
  await sendPdf(res, await buildReport(req.valid.body));
});

reportsRouter.post('/summary', summaryLimiter, validate(selectionSchema), async (req, res) => {
  res.json(await draftSummary(await buildReport(req.valid.body)));
});

// Saved report library.

reportsRouter.get('/', validate(listQuery, 'query'), async (req, res) => {
  res.json((await listReports(req.valid.query.q)).map(presentReport));
});

reportsRouter.post('/', validate(createSchema), async (req, res) => {
  const report = await createReport(req.valid.body, req.user);
  await recordAudit(req, 'report.created', { target: reportTarget(report) });
  res.status(201).json(presentReport(report));
});

/** The interactive viewer: the saved report and its current figures. */
reportsRouter.get('/by-slug/:slug', validate(slugParams, 'params'), async (req, res) => {
  const { report, data } = await getReportView(req.valid.params.slug);
  res.json({ report: presentReport(report), data });
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
  const report = await deleteReport(req.valid.params.id, req.user);
  await recordAudit(req, 'report.deleted', { target: reportTarget(report) });
  res.status(204).end();
});

/** Re-render a saved report against current data. */
reportsRouter.get('/:id/pdf', pdfLimiter, validate(idParams, 'params'), async (req, res) => {
  const report = await getReport(req.valid.params.id);
  await sendPdf(res, await buildReport(savedSelection(report)));
});

function reportTarget(report) {
  return { type: 'report', id: report.id, label: report.title };
}

async function sendPdf(res, report) {
  // Render fully before sending headers, so a failure returns an error, never an empty file.
  const pdf = await renderReportPdf(report);
  res.attachment(reportFilename(report)).set('Cache-Control', 'no-store').send(pdf);
}
