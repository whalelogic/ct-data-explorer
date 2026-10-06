import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { connectionOptions, SESSION_SETUP } from './pool.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const LOCK_NAME = 'ctde:migrations'; // concurrent runners wait for each other
const LOCK_TIMEOUT_SECONDS = 60;

/**
 * Apply pending forward-only migrations (migrations/NNN_name.sql) in filename order
 * and record each one in schema_migrations.
 *
 * Each file runs inside a transaction, but MySQL commits schema changes (CREATE,
 * ALTER, DROP) immediately, so only data changes roll back on failure. Keep each
 * file to one logical step, and after a failure check for partly applied changes
 * before running again.
 * @returns {Promise<string[]>} filenames applied by this run
 */
export async function runMigrations({ log = console.log } = {}) {
  // A dedicated connection: migration files hold several statements each.
  const connection = await mysql.createConnection({ ...connectionOptions, multipleStatements: true });
  try {
    await connection.query(SESSION_SETUP);
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    if (lock.acquired !== 1) throw new Error('Another migration run is in progress; try again shortly');

    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs`);
    const [rows] = await connection.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
    const pending = files.filter((f) => !applied.has(f));

    for (const file of pending) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await connection.beginTransaction();
        await connection.query(sql);
        await connection.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
        await connection.commit();
        log(`applied ${file}`);
      } catch (err) {
        await connection.rollback().catch(() => {});
        throw new Error(
          `Migration ${file} failed: ${err.message}. ` +
            'MySQL keeps any schema changes made before the failure; check for them before running again.',
          { cause: err },
        );
      }
    }
    if (pending.length === 0) log('database is up to date');
    return pending;
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    await connection.end();
  }
}
