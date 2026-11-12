/** Fetch wrapper for the JSON API: sends the CSRF token, turns error responses into ApiError. */

let csrfToken = '';
let lastSession = null;

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export function setCsrfToken(token) {
  csrfToken = token ?? '';
}

/**
 * @param {string} path API path after /api, e.g. '/reports'
 * @param {{ method?: string, json?: unknown, form?: FormData, expect?: 'json' | 'blob' }} [options]
 */
export async function api(path, { method = 'GET', json, form, expect = 'json' } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }

  if (!res.ok) throw await failure(res, path);
  if (expect === 'blob') return { blob: await res.blob(), filename: filenameFrom(res) };
  return res.status === 204 ? null : res.json();
}

/** Load the signed-in user, feature flags and CSRF token; sends the browser to sign-in if there is no session. */
export async function loadSession() {
  try {
    const session = await api('/auth/me');
    setCsrfToken(session.csrfToken);
    lastSession = session;
    return session;
  } catch (err) {
    if (err.status === 401) redirectToSignIn();
    throw err;
  }
}

/** The session loaded by this page, for shared widgets such as the assistant. */
export function currentSession() {
  return lastSession;
}

function redirectToSignIn() {
  location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
}

function filenameFrom(res) {
  return /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'report.pdf';
}

async function failure(res, path) {
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) redirectToSignIn();
  let message = data.error ?? `Request failed (${res.status})`;
  // Server-side failures carry a reference that leads an administrator to the log line.
  if (data.requestId) message += ` (Reference: ${data.requestId})`;
  return new ApiError(message, res.status, data.details);
}

/**
 * POST JSON and read the answer as it arrives: the server writes one JSON object per line.
 * @param {string} path API path after /api
 * @param {unknown} json request body
 * @param {(event: object) => void} onEvent called for each line
 */
export async function apiEvents(path, json, onEvent) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }
  if (!res.ok) throw await failure(res, path);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw new ApiError('The connection dropped before the answer finished. Try again.', 0);
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) onEvent(JSON.parse(line));
      end = buffer.indexOf('\n');
    }
  }
}
