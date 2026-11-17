import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import * as users from '../repositories/users.js';

/**
 * Load the active user when a request has an account session. Load it fresh so
 * role changes and deactivation take effect immediately. Enforces the 8-hour
 * absolute session lifetime; the 30-minute idle timeout is the rolling cookie maxAge.
 */
export async function optionalAuth(req, _res, next) {
  const { session } = req;
  req.user = null;
  if (session?.userId) {
    const expired = Date.now() - (session.createdAt ?? 0) > config.session.absoluteTimeoutMs;
    const user = expired ? null : await users.findById(session.userId);
    if (user?.is_active) {
      req.user = user;
    } else {
      await regenerateSession(req);
      req.sessionExpired = expired;
    }
  }
  next();
}

export function requireSignedIn(req, _res, next) {
  if (!req.user) {
    const message = req.sessionExpired ? 'Your session has expired. Please sign in again.' : 'Please sign in';
    return next(new HttpError(401, message));
  }
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
