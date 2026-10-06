import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { emailSchema, newPasswordSchema } from '../lib/schemas.js';
import { destroySession, regenerateSession, requireAuth } from '../middleware/auth.js';
import { csrfProtection, csrfTokenFor } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { isSummaryAvailable } from '../services/ai/index.js';
import * as auth from '../services/auth.service.js';
import { presentUser } from '../services/presenters.js';

// Per-IP limit on top of the per-account lockout in auth.service.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts from this network. Try again later.' },
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(1000),
});
const tokenSchema = z.object({ token: z.string().min(20).max(200) });
const setPasswordSchema = tokenSchema.extend({ password: newPasswordSchema });

export const authRouter = Router();

authRouter.post('/login', credentialLimiter, validate(loginSchema), async (req, res) => {
  const user = await auth.authenticate(req.valid.body.email, req.valid.body.password);
  await startSession(req, user);
  res.json(sessionPayload(req, user));
});

authRouter.post('/logout', requireAuth, csrfProtection, async (req, res) => {
  await destroySession(req);
  res.clearCookie(config.session.cookieName);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json(sessionPayload(req, req.user));
});

/** Who a set-password link belongs to, so the page can greet them. */
authRouter.post('/token', credentialLimiter, validate(tokenSchema), async (req, res) => {
  res.json(await auth.describeToken(req.valid.body.token));
});

/** Accept an invite or reset link; signs the user in and lands them on the dashboard. */
authRouter.post('/set-password', credentialLimiter, validate(setPasswordSchema), async (req, res) => {
  const user = await auth.setPasswordWithToken(req.valid.body.token, req.valid.body.password);
  await startSession(req, user);
  res.json(sessionPayload(req, user));
});

async function startSession(req, user) {
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.createdAt = Date.now();
}

function sessionPayload(req, user) {
  return {
    user: presentUser(user),
    csrfToken: csrfTokenFor(req.session),
    features: { aiSummary: isSummaryAvailable() },
  };
}
