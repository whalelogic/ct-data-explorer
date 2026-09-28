import pg from 'pg';
import { config } from '../config.js';

const NUMERIC_OID = 1700;

// NUMERIC columns arrive as strings by default. Values here are town-level
// aggregates that fit comfortably in a double, so parse them as numbers.
pg.types.setTypeParser(NUMERIC_OID, (value) => Number.parseFloat(value));

export const pool = new pg.Pool(config.db);

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

/**
 * Run fn inside a transaction on a dedicated client; rolls back if fn throws.
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
