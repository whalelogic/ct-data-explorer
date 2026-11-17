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
  getReportView,
  listReports,
  parseStoredSelection,
  updateReport,
} from '../services/reports.service.js';
import { reportFilename, renderReportPdf } from '../services/pdf/index.js';
import { presentReport } from '../services/presenters.js';
import { getComparisonOptions } from '../services/dataset-comparison.js';
import { trackDatasetAccess, trackReportUsage } from '../services/dataset-usage.js';
import { comparisonOptionsSchema, selectionSchema } from '../services/selection.js';
import { SLUG_PATTERN } from '../services/slugs.js';

const reportTitle = z.string().trim().min(1, 'Give the report a name').max(200);
const createSchema = z.object({ title: reportTitle, selection: selectionSchema });
const updateSchema = z.object({ title: reportTitle.optional(), selection: selectionSchema.optional() });
const listQuery = z.object({ q: z.string().trim().max(100).optional() });
const slugParams = z.object({ slug: z.string().regex(SLUG_PATTERN, 'Report not found').max(80) });

export const reportsRouter = Router();

// Working with an unsaved selection.

reportsRouter.post('/comparison-options', validate(comparisonOptionsSchema), async (req, res) => {
  const { datasetIds } = req.valid.body;
  const options = await getComparisonOptions(datasetIds, req.user);
  await trackDatasetAccess(datasetIds);
  res.json(options);
});

reportsRouter.post('/preview', validate(selectionSchema), async (req, res) => {
  const report = await buildReport(req.valid.body, { user: req.user });
  await trackReportUsage('report_preview', report, req.valid.body);
  res.json(report);
});

reportsRouter.post('/pdf', validate(selectionSchema), async (req, res) => {
  await sendPdf(res, await buildReport(req.valid.body, { user: req.user }));
});

reportsRouter.post('/summary', validate(selectionSchema), async (req, res) => {
  const report = await buildReport(req.valid.body, { user: req.user });
  const draft = await draftSummary(report);
  await trackReportUsage('report_summary', report);
  res.json(draft);
});

// Saved report library.

reportsRouter.get('/', validate(listQuery, 'query'), async (req, res) => {
  res.json((await listReports(req.valid.query.q, req.user)).map(presentReport));
});

reportsRouter.post('/', validate(createSchema), async (req, res) => {
  res.status(201).json(presentReport(await createReport(req.valid.body, req.user)));
});

/** The interactive viewer: the saved report and its current figures. */
reportsRouter.get('/by-slug/:slug', validate(slugParams, 'params'), async (req, res) => {
  const { report, data } = await getReportView(req.valid.params.slug, req.user);
  await trackReportUsage('report_view', data);
  res.json({ report: presentReport(report), data });
});

reportsRouter.get('/:id', validate(idParams, 'params'), async (req, res) => {
  res.json(presentReport(await getReport(req.valid.params.id, req.user)));
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
  const report = await getReport(req.valid.params.id, req.user);
  await sendPdf(res, await buildReport(parseStoredSelection(report.selection), { user: req.user }));
});

async function sendPdf(res, report) {
  // Render fully before sending headers, so a failure returns an error, never an empty file.
  const pdf = await renderReportPdf(report);
  await trackReportUsage('report_export', report);
  res.attachment(reportFilename(report)).set('Cache-Control', 'no-store').send(pdf);
}
