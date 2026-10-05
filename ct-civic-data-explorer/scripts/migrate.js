#!/usr/bin/env node
/** Apply pending migrations from migrations/. Usage: npm run migrate */
import { pool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

try {
  await runMigrations();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
