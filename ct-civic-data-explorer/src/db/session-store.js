/**
 * express-session store backed by the MySQL `session` table (sid, sess JSON, expire).
 *
 * A row expires with its cookie, so the rolling 30-minute idle timeout applies on
 * the server too. Expired rows are never returned and are pruned every 15 minutes.
 */
import session from 'express-session';
import { pool } from './pool.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // only used when a session has no cookie expiry
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

export class MySqlSessionStore extends session.Store {
  /** @param {{ db?: typeof pool, pruneIntervalMs?: number | false }} [options] */
  constructor({ db = pool, pruneIntervalMs = PRUNE_INTERVAL_MS } = {}) {
    super();
    this.db = db;
    if (pruneIntervalMs) {
      this.pruneTimer = setInterval(() => {
        this.prune().catch((err) => console.error('[session] could not prune expired sessions', err));
      }, pruneIntervalMs);
      this.pruneTimer.unref(); // never keeps the process alive on its own
    }
  }

  get(sid, callback) {
    this.db
      .query('SELECT sess FROM session WHERE sid = ? AND expire > NOW(3)', [sid])
      .then(({ rows }) => callback(null, rows[0]?.sess ?? null), callback);
  }

  set(sid, sess, callback) {
    this.db
      .query(
        `INSERT INTO session (sid, sess, expire) VALUES (?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE sess = new.sess, expire = new.expire`,
        [sid, JSON.stringify(sess), expiryOf(sess)],
      )
      .then(() => callback?.(null), (err) => callback?.(err));
  }

  /** Called on responses that do not change the session (rolling cookies), to extend its expiry. */
  touch(sid, sess, callback) {
    this.db
      .query('UPDATE session SET expire = ? WHERE sid = ?', [expiryOf(sess), sid])
      .then(() => callback?.(null), (err) => callback?.(err));
  }

  destroy(sid, callback) {
    this.db
      .query('DELETE FROM session WHERE sid = ?', [sid])
      .then(() => callback?.(null), (err) => callback?.(err));
  }

  async prune() {
    await this.db.query('DELETE FROM session WHERE expire <= NOW(3)');
  }

  close() {
    clearInterval(this.pruneTimer);
  }
}

function expiryOf(sess) {
  const expires = sess?.cookie?.expires;
  return expires ? new Date(expires) : new Date(Date.now() + DEFAULT_TTL_MS);
}
