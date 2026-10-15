import { api, setCsrfToken } from './api.js';
import { showStatus } from './layout.js';

const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('status');

async function handleLogin(event) {
  event.preventDefault();
  const submitButton = loginForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  showStatus(loginStatus, '');

  try {
    const session = await api('/auth/login', {
      method: 'POST',
      json: {
        email: loginForm.email.value,
        password: loginForm.password.value,
      },
    });
    setCsrfToken(session.csrfToken);
    location.assign(getNextPage());
  } catch (error) {
    showStatus(loginStatus, error.message, 'error');
    submitButton.disabled = false;
  }
}

/** Only allow local paths, so the next parameter cannot redirect off-site. */
function getNextPage() {
  const nextPath = new URLSearchParams(location.search).get('next');
  if (nextPath && nextPath.startsWith('/') && !/^\/[/\\]/.test(nextPath)) {
    return nextPath;
  }
  return '/explore.html';
}

loginForm.addEventListener('submit', handleLogin);
