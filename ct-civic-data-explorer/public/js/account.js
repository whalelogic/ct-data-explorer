/** Your account: who you are signed in as, and changing your own password. */
import { api, loadSession, setCsrfToken } from './api.js';
import { boot, renderHeader, showStatus } from './layout.js';

const ROLE_NAMES = { admin: 'Administrator', staff: 'Staff' };
const MIN_PASSWORD_LENGTH = 12;

const passwordForm = document.getElementById('password-form');
const passwordStatus = document.getElementById('password-status');

async function initializeAccountPage() {
  const { user } = await loadSession();
  renderHeader(user);
  document.getElementById('account-name').textContent = `${user.firstName} ${user.lastName}`;
  document.getElementById('account-email').textContent = user.email;
  document.getElementById('account-role').textContent = ROLE_NAMES[user.role] ?? user.role;
  document.getElementById('account-username').value = user.email;
  passwordForm.addEventListener('submit', handlePasswordChange);
  document.getElementById('show-passwords').addEventListener('change', togglePasswordVisibility);
}

function togglePasswordVisibility(event) {
  const type = event.target.checked ? 'text' : 'password';
  for (const name of ['currentPassword', 'newPassword', 'confirmPassword']) {
    passwordForm.elements[name].type = type;
  }
}

/** The first problem with the form, and the field to return to; null when it is ready to send. */
function findPasswordProblem() {
  const { currentPassword, newPassword, confirmPassword } = passwordForm.elements;
  if (!currentPassword.value) {
    return { message: 'Enter your current password.', field: currentPassword };
  }
  if (newPassword.value.length < MIN_PASSWORD_LENGTH) {
    return { message: `Your new password needs at least ${MIN_PASSWORD_LENGTH} characters.`, field: newPassword };
  }
  if (newPassword.value !== confirmPassword.value) {
    return { message: 'The new passwords do not match.', field: confirmPassword };
  }
  return null;
}

async function handlePasswordChange(event) {
  event.preventDefault();
  const problem = findPasswordProblem();
  if (problem) {
    showStatus(passwordStatus, problem.message, 'error');
    problem.field.focus();
    return;
  }

  const submitButton = passwordForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  showStatus(passwordStatus, '');
  try {
    const session = await api('/auth/password', {
      method: 'POST',
      json: {
        currentPassword: passwordForm.elements.currentPassword.value,
        newPassword: passwordForm.elements.newPassword.value,
      },
    });
    // The server starts a fresh session, so later requests need its new token.
    setCsrfToken(session.csrfToken);
    passwordForm.reset();
    togglePasswordVisibility({ target: { checked: false } });
    showStatus(passwordStatus, 'Your password has been changed. Other devices have been signed out.', 'ok');
  } catch (error) {
    showStatus(passwordStatus, error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
}

boot(initializeAccountPage);
