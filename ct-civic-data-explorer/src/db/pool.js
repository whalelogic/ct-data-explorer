/**
 * MySQL connection pool and transactions.
 *
 * Repositories call `db.query(sql, params)` with `?` placeholders and get back
 * `{ rows, rowCount, insertId }`: rows for SELECTs, rowCount (rows matched) and
 * insertId for writes. `db` is either `pool` or the client withTransaction() passes in.
 *
 * Every connection runs in UTC with READ COMMITTED isolation, so timestamps and
 * concurrent-transaction visibility behave the same as they did on PostgreSQL.
 */
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { config } from '../config.js';

/** Connection options shared by the pool and the migration runner. */
export const connectionOptions = Object.freeze({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  charset: 'utf8mb4',
  timezone: 'Z', // DATETIME values are UTC on both sides
  decimalNumbers: true, // DECIMAL columns hold town-level aggregates that fit in a double
  typeCast(field, next) {
    // BOOLEAN is TINYINT(1) in MySQL; return true/false like PostgreSQL did.
    if (field.type === 'TINY' && field.length === 1) {
      const value = field.string();
      return value === null ? null : value !== '0';
    }
    return next();
  },
});

/** Run on every new connection, so no query ever sees server-default settings. */
export const SESSION_SETUP = "SET time_zone = '+00:00', SESSION transaction_isolation = 'READ-COMMITTED'";

const mysqlPool = mysql.createPool({
  ...connectionOptions,
  connectionLimit: config.db.max,
  enableKeepAlive: true,
});
mysqlPool.pool.on('connection', (connection) => {
  connection.query(SESSION_SETUP, (err) => {
    if (err) console.error('Could not configure a MySQL connection', err);
  });
});

async function run(executor, sql, params = []) {
  const [result] = await executor.query(sql, params);
  if (Array.isArray(result)) return { rows: result, rowCount: result.length };
  return { rows: [], rowCount: result.affectedRows, insertId: result.insertId };
}

export const pool = Object.freeze({
  query: (sql, params) => run(mysqlPool, sql, params),
  end: () => mysqlPool.end(),
});

/**
 * Run fn inside a transaction on a dedicated connection; rolls back if fn throws.
 * The client passed to fn also offers lock(key): a named lock held until the
 * transaction ends, used to serialize work such as dataset version numbering.
 * @template T
 * @param {(client: { query: typeof pool.query, lock: (key: string) => Promise<void> }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const connection = await mysqlPool.getConnection();
  const locks = [];
  const client = {
    query: (sql, params) => run(connection, sql, params),
    async lock(key, timeoutSeconds = 10) {
      // GET_LOCK names are limited to 64 characters, so lock on a hash of the key.
      const name = `ctde:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 48)}`;
      const [[row]] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [name, timeoutSeconds]);
      if (row.acquired !== 1) throw new Error(`Timed out waiting for lock "${key}"`);
      locks.push(name);
    },
  };

  let healthy = true;
  try {
    await connection.beginTransaction();
    const result = await fn(client);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback().catch(() => {
      healthy = false;
    });
    throw err;
  } finally {
    for (const name of locks) {
      await connection.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => {
        healthy = false;
      });
    }
    // A connection that may still hold a lock or an open transaction is closed, not reused.
    if (healthy) connection.release();
    else connection.destroy();
  }
}
