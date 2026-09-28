import crypto from 'node:crypto';
import { HttpError } from '../lib/http-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Get or create the per-session synchronizer token the browser echoes in X-CSRF-Token. */
export function csrfTokenFor(session) {
  session.csrfToken ??= crypto.randomBytes(32).toString('hex');
  return session.csrfToken;
}

/** Reject state-changing requests that do not carry the session's CSRF token. */
export function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const expected = req.session?.csrfToken;
  const received = req.get('x-csrf-token');
  if (!expected || !received || !safeEqual(expected, received)) {
    return next(new HttpError(403, 'Your page is out of date. Reload it and try again.'));
  }
  next();
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
