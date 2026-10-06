/** Minimal access log. Never logs bodies, cookies or query strings, which can carry credentials. */
export function requestLog(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const path = req.originalUrl.split('?')[0];
    console.log(`${req.method} ${path} ${res.statusCode} ${ms.toFixed(1)}ms user=${req.user?.id ?? '-'}`);
  });
  next();
}
