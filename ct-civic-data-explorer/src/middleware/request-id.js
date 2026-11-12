import crypto from 'node:crypto';

const FORWARDED_ID = /^[\w.-]{8,64}$/;

/**
 * Give every request a short id, returned in X-Request-Id and written to the access
 * and error logs, so a person reporting "something went wrong" can quote a reference
 * that leads straight to the log line. An id from a trusted reverse proxy is kept.
 * @param {{ trustForwarded?: boolean }} [options]
 */
export function requestId({ trustForwarded = false } = {}) {
  return (req, res, next) => {
    const forwarded = trustForwarded ? req.get('x-request-id') : undefined;
    req.id = forwarded && FORWARDED_ID.test(forwarded) ? forwarded : crypto.randomBytes(6).toString('hex');
    res.set('X-Request-Id', req.id);
    next();
  };
}
