import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const LOCK_ID = 7_431_001; // arbitrary constant so concurrent runners wait for each other

/**
 * Apply pending forward-only migrations (migrations/NNN_name.sql) in filename order.
 * Each file runs in its own transaction and is recorded in schema_migrations.
 * @param {import('pg').Pool} pool
 * @returns {Promise<string[]>} filenames applied by this run
 */
export async function runMigrations(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
    const pending = files.filter((f) => !applied.has(f));

    for (const file of pending) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
      }
    }
    if (pending.length === 0) log('database is up to date');
    return pending;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}
