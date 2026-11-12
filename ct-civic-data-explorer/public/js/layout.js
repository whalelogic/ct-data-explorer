/** Page header and UI helpers shared by signed-in pages. */
import { api } from './api.js';
import { h as createElement } from './dom.js';
import { mountAssistant } from './assistant.js';

export function renderHeader(user) {
  const navigationLinks = [
    ['/', 'Dashboard'],
    ['/explore', 'Explore reports'],
    ['/builder', 'Report builder'],
  ];
  if (user.role === 'admin') {
    navigationLinks.push(['/admin', 'Datasets']);
    navigationLinks.push(['/users', 'People']);
  }

  const navigation = createElement('nav', { 'aria-label': 'Main' });
  for (const [url, label] of navigationLinks) {
    const link = createElement('a', {
      href: url,
      'aria-current': isCurrentPage(url) ? 'page' : null,
    }, label);
    navigation.append(link);
  }

  const userName = createElement('a', {
    class: 'who',
    href: '/account',
    title: 'Your account',
    'aria-current': location.pathname === '/account' ? 'page' : null,
  }, `${user.firstName} ${user.lastName}`);
  const signOutButton = createElement('button', {
    type: 'button',
    class: 'link',
    onClick: signOut,
  }, 'Sign out');
  const account = createElement('div', { class: 'site-account' }, userName, signOutButton);
  const header = document.querySelector('header.site');
  const brandLink = header.querySelector('.brand');
  brandLink.replaceChildren(
    createElement('strong', {}, 'CTData'),
    createElement('span', {}, 'Civic Data Explorer'),
  );
  brandLink.href = '/';
  header.append(navigation, account);
  // On a phone the links sit on one row that scrolls sideways; keep the current page in view.
  const current = navigation.querySelector('[aria-current="page"]');
  if (current && navigation.scrollWidth > navigation.clientWidth) {
    navigation.scrollLeft = Math.max(0, current.offsetLeft - navigation.offsetLeft - 16);
  }
  // The data assistant appears on every signed-in page when the server has AI set up.
  mountAssistant();
}

/**
 * Admin pages share one sub-navigation for the places the header does not reach.
 * Datasets and People are already in the header, so they are not repeated here.
 */
const ADMIN_LINKS = [
  ['/admin/datasets/new', 'Add dataset'],
  ['/admin/activity', 'Activity'],
];

export function renderAdminNav(container) {
  container.replaceChildren();
  for (const [url, label] of ADMIN_LINKS) {
    container.append(createElement('a', {
      href: url,
      'aria-current': location.pathname === url ? 'page' : null,
    }, label));
  }
}

/** An empty message hides the status element. */
export function showStatus(statusElement, message, kind = 'info') {
  statusElement.textContent = message ?? '';
  statusElement.dataset.kind = kind;
  statusElement.hidden = !message;
}

export function formatDate(isoDate) {
  return new Date(isoDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Wait until calls stop for the requested delay before running the callback. */
export function debounce(callback, delayMilliseconds) {
  let timeoutId;
  return function scheduleCallback(...argumentsToPass) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => callback(...argumentsToPass), delayMilliseconds);
  };
}

export function downloadBlob(blob, filename) {
  const downloadUrl = URL.createObjectURL(blob);
  const downloadLink = createElement('a', { href: downloadUrl, download: filename });
  document.body.append(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 10_000);
}

/** Show setup failures in #page-status instead of leaving the page blank. */
export function boot(initializePage) {
  initializePage().catch(showPageSetupError);
}

function showPageSetupError(error) {
  console.error(error);
  const pageStatus = document.getElementById('page-status');
  if (pageStatus) {
    showStatus(pageStatus, error.message, 'error');
  }
}

function isCurrentPage(url) {
  if (url === '/') {
    return location.pathname === '/';
  }
  // Report viewer pages live under /explore/ and the upload page under /admin/.
  return location.pathname === url || location.pathname.startsWith(`${url}/`);
}

async function signOut() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    // Return to the login page even if the session has already expired.
  }
  try {
    // Drafts and assistant conversations kept in this tab belong to the person signing out.
    window.dispatchEvent(new Event('ctde:signout'));
    sessionStorage.clear();
  } catch {
    // Storage may be unavailable; signing out still works.
  }
  location.assign('/login');
}
