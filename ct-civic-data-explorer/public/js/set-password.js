import { api, setCsrfToken } from './api.js';
import { showStatus } from './layout.js';

const form = document.getElementById('password-form');
const status = document.getElementById('status');

// The token arrives in the URL fragment. Keep it in memory and remove it from the address bar and history.
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);

if (!token) {
  showStatus(status, 'This link is incomplete. Ask an administrator for a new one.', 'error');
} else {
  try {
    const info = await api('/auth/token', { method: 'POST', json: { token } });
    document.getElementById('greeting').textContent =
      info.purpose === 'invite'
        ? `Welcome, ${info.firstName}. Choose a password for ${info.email}.`
        : `Choose a new password for ${info.email}.`;
    form.hidden = false;
    form.password.focus();
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (form.password.value !== form.confirm.value) {
    showStatus(status, 'The passwords do not match.', 'error');
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const session = await api('/auth/set-password', { method: 'POST', json: { token, password: form.password.value } });
    setCsrfToken(session.csrfToken);
    location.assign('/');
  } catch (err) {
    showStatus(status, err.message, 'error');
    button.disabled = false;
  }
});
