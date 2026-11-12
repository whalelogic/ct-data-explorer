/**
 * Public, read-only versions of saved reports for placing on other websites:
 *
 *   GET /embed/<report>.html   a page holding only the report, which any site may frame
 *   GET /embed/<report>.json   the report's current figures, for that page
 *
 * No sign-in, session or CSRF token is involved, and nothing here can change data.
 * The response leaves out who saved the report.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { getReportView } from '../services/reports.service.js';

const PUBLIC_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const EMBED_PATH = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)\.(html|json)$/;

/** Visitors have no account, so this limit is per address. */
const embedLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'This report is being loaded too often. Wait a minute and try again.' },
});

/** Every other page refuses to be framed by another site; embed pages allow it. */
function allowFraming(_req, res, next) {
  const ancestors = config.embed.frameAncestors.join(' ');
  const policy = String(res.getHeader('Content-Security-Policy') ?? '');
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', policy.replace(/frame-ancestors[^;]*/, `frame-ancestors ${ancestors}`));
  next();
}

export const embedRouter = Router();

embedRouter.get(EMBED_PATH, allowFraming, embedLimiter, async (req, res) => {
  const [slug, kind] = [req.params[0], req.params[1]];
  if (kind === 'html') {
    res.sendFile('embed.html', { root: PUBLIC_DIRECTORY });
    return;
  }
  const { report, data } = await getReportView(slug);
  res.set('Cache-Control', 'no-store');
  res.json({ title: report.title, updatedAt: report.updated_at, data });
});
