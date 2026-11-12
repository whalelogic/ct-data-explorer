/**
 * Process entry point: starts the HTTP server, reports configuration and database
 * problems at startup, and shuts down cleanly when the container is stopped.
 */
import { createApp } from './app.js';
import { config, configWarnings } from './config.js';
import { pendingMigrations } from './db/migrate.js';
import { pool } from './db/pool.js';
import { pruneAudit } from './services/audit.js';

const SHUTDOWN_GRACE_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

for (const warning of configWarnings) {
  console.warn(`[config] ${warning}`);
}

const server = createApp().listen(config.port, () => {
  console.log(`CT Civic Data Explorer (${config.env}) listening on port ${config.port}; links use ${config.baseUrl}`);
  reportDatabaseState();
});

// Longer than a typical reverse proxy's idle timeout (60 s), so the proxy, not this
// server, closes idle connections and no request lands on a socket being torn down.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
// The slowest legitimate requests are a 10 MB upload and an assistant reply.
server.requestTimeout = 120_000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the other process or set PORT in .env.`);
  } else {
    console.error('The server could not start:', err);
  }
  process.exit(1);
});

/**
 * The server starts even when the database is not ready, because /healthz reports it and
 * the pool reconnects on its own. Say so plainly rather than waiting for the first request.
 */
async function reportDatabaseState() {
  try {
    const pending = await pendingMigrations();
    if (pending.length > 0) {
      console.warn(`[startup] ${pending.length} database migration(s) have not been applied (${pending.join(', ')}). Run: npm run migrate`);
    }
  } catch (err) {
    console.error(`[startup] the database is not reachable at ${config.db.host}:${config.db.port}: ${err.message}`);
  }
}

// Old audit entries are removed once a day; the first pass waits so startup stays quick.
const auditPruneTimer = setInterval(() => {
  pruneAudit().catch((err) => console.error(`[audit] could not remove old entries: ${err.message}`));
}, DAY_MS);
auditPruneTimer.unref();

let shuttingDown = false;

function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${reason}; shutting down`);
  // Requests in flight finish; idle keep-alive connections are closed straight away.
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(exitCode);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM received'));
process.on('SIGINT', () => shutdown('SIGINT received'));

// A bug that escapes every handler leaves the process in an unknown state. Log it and
// exit so the container supervisor starts a clean one.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception', err);
  shutdown('Uncaught exception', 1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection', reason);
  shutdown('Unhandled promise rejection', 1);
});
