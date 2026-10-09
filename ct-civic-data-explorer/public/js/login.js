import { api, setCsrfToken } from './api.js';
import { renderFooter, showStatus } from './layout.js';

renderFooter();

const form = document.getElementById('login-form');
const status = document.getElementById('status');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showStatus(status, '');
  try {
    const session = await api('/auth/login', {
      method: 'POST',
      json: { email: form.email.value, password: form.password.value },
    });
    setCsrfToken(session.csrfToken);
    location.assign(safeNextPath());
  } catch (err) {
    showStatus(status, err.message, 'error');
    button.disabled = false;
  }
});

/** Only follow same-origin paths, so ?next= cannot redirect off-site. */
function safeNextPath() {
  const next = new URLSearchParams(location.search).get('next');
  return next && next.startsWith('/') && !/^\/[/\\]/.test(next) ? next : '/';
}
