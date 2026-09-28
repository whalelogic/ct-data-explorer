/** Fetch wrapper for the JSON API: sends the CSRF token, turns error responses into ApiError. */

let csrfToken = '';

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
 * @param {string} path API path after /api, e.g. '/cards'
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

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/auth/')) redirectToSignIn();
    throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.details);
  }
  if (expect === 'blob') return { blob: await res.blob(), filename: filenameFrom(res) };
  return res.status === 204 ? null : res.json();
}

/** Load the signed-in user, feature flags and CSRF token; sends the browser to sign-in if there is no session. */
export async function loadSession() {
  try {
    const session = await api('/auth/me');
    setCsrfToken(session.csrfToken);
    return session;
  } catch (err) {
    if (err.status === 401) redirectToSignIn();
    throw err;
  }
}

function redirectToSignIn() {
  location.assign(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
}

function filenameFrom(res) {
  return /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'card.pdf';
}
