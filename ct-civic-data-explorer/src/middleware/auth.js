import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import * as users from '../repositories/users.js';

/**
 * Require a signed-in, active user. The user is loaded fresh on every request so
 * role changes and deactivation take effect immediately. Enforces the 8-hour
 * absolute session lifetime; the 30-minute idle timeout is the rolling cookie maxAge.
 */
export async function requireAuth(req, _res, next) {
  const { session } = req;
  if (!session?.userId) throw new HttpError(401, 'Please sign in');

  if (Date.now() - (session.createdAt ?? 0) > config.session.absoluteTimeoutMs) {
    await destroySession(req);
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }

  const user = await users.findById(session.userId);
  if (!user?.is_active) {
    await destroySession(req);
    throw new HttpError(401, 'Please sign in');
  }
  req.user = user;
  next();
}

/** Allow only the given roles. Hiding a button in the UI is never the only control. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.user?.role)) return next(new HttpError(403, 'You do not have permission to do that'));
    next();
  };
}

/** Replace the session with a fresh one (new id), e.g. on sign-in, to prevent session fixation. */
export function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

export function destroySession(req) {
  return new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
}
