/**
 * Minimal access log, one line per request:
 *   2026-11-11T14:03:22.118Z POST /api/auth/login 200 84.2ms user=7 id=3f9c2a71b0de
 * Never logs bodies, cookies or query strings, which can carry credentials.
 * Passing health checks are left out.
 */
export function requestLog(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    // A passing health check every 30 seconds would bury the requests people make.
    if (req.path === '/healthz' && res.statusCode === 200) return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const path = req.originalUrl.split('?')[0];
    console.log(
      `${new Date().toISOString()} ${req.method} ${path} ${res.statusCode} ${ms.toFixed(1)}ms user=${req.user?.id ?? '-'} id=${req.id ?? '-'}`,
    );
  });
  next();
}
