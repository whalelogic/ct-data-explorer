/**
 * Audit trail: a durable record of sign-ins and of changes to accounts, datasets and
 * reports, readable by administrators under Datasets › Activity.
 *
 * Recording is best-effort by design. The action has already happened by the time it is
 * recorded, so a failure to write the entry is logged and never turns a successful
 * request into an error.
 */
import * as audit from '../repositories/audit.js';

export const AUDIT_CATEGORIES = Object.freeze(['auth', 'user', 'dataset', 'report']);
/** Entries older than this are removed by pruneAudit(). */
export const AUDIT_RETENTION_DAYS = 730;

/**
 * @param {import('express').Request} req supplies the signed-in user and address
 * @param {string} action '<category>.<what happened>', e.g. 'dataset.published'
 * @param {{
 *   actor?: { id: number, email: string } | null,
 *   target?: { type: 'user' | 'dataset' | 'report', id?: number, label?: string },
 *   details?: Record<string, unknown>,
 * }} [entry] `actor` overrides req.user, for sign-in itself
 */
export async function recordAudit(req, action, { actor, target, details } = {}) {
  const who = actor === undefined ? req.user : actor;
  const entry = {
    actorId: who?.id ?? null,
    actorEmail: who?.email ?? null,
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    targetLabel: target?.label ? String(target.label).slice(0, 300) : null,
    details: details ?? null,
    ip: clientAddress(req),
  };
  try {
    await audit.insert(entry);
  } catch (err) {
    // Keep the event in the server log so it is not lost entirely.
    console.error(`[audit] could not record ${action} by ${entry.actorEmail ?? 'nobody'}: ${err.message}`);
  }
}

export async function listAudit({ limit, before, category }) {
  // One extra row tells the caller whether there is another page.
  const rows = await audit.list({ limit: limit + 1, before, category });
  return { entries: rows.slice(0, limit).map(presentEntry), hasMore: rows.length > limit };
}

export function pruneAudit() {
  return audit.removeOlderThan(AUDIT_RETENTION_DAYS);
}

/** IPv4 addresses arrive as "::ffff:203.0.113.7" on a dual-stack socket; store the plain form. */
function clientAddress(req) {
  if (!req.ip) return null;
  return String(req.ip).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '').slice(0, 45);
}

function presentEntry(row) {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actor: row.actor_id || row.actor_email
      ? { id: row.actor_id, email: row.actor_email, name: row.actor_name ?? null }
      : null,
    action: row.action,
    target: row.target_type ? { type: row.target_type, id: row.target_id, label: row.target_label } : null,
    details: row.details ?? null,
    ip: row.ip,
  };
}
