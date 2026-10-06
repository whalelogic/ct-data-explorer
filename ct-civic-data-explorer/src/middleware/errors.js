import { HttpError } from '../lib/http-error.js';

export function apiNotFound(_req, _res, next) {
  next(new HttpError(404, 'Not found'));
}

/** Central error handler: logs unexpected errors with context and returns a safe message, never a stack trace. */
export function errorHandler(err, req, res, next) {
  let status = 500;
  let body = { error: 'Something went wrong on our side. Please try again.' };

  if (err instanceof HttpError) {
    status = err.status;
    body = err.details === undefined ? { error: err.message } : { error: err.message, details: err.details };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    body = { error: 'Request body is not valid JSON' };
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    body = { error: 'Request body is too large' };
  } else if (err?.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    body = { error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (10 MB maximum)' : `Upload error: ${err.message}` };
  }

  if (status >= 500) {
    const context = `${req.method} ${req.originalUrl.split('?')[0]} user=${req.user?.id ?? '-'}`;
    // Expected server-side conditions (e.g. an unconfigured AI provider) get one line; anything unexpected gets the stack.
    if (err instanceof HttpError) console.error(`[error] ${context} ${status} ${err.message}`);
    else console.error(`[error] ${context}`, err);
  }
  if (res.headersSent) return next(err);
  res.status(status).json(body);
}
