/** Page header and UI helpers shared by site pages. */
import { api } from './api.js';
import { h as createElement } from './dom.js';
import { clearPendingProposal } from './chat-proposal.js';

// Restored pages must recheck the session before showing account data.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});

export function renderHeader(user) {
  const navigation = createElement('nav', { 'aria-label': 'Main' },
    navigationLink('/', 'Dashboard'),
    renderReportsNavigation(),
    user ? navigationLink('/datasets/mine', 'My datasets') : null,
    navigationLink('/chat', 'AI chat'),
  );
  if (user?.role === 'admin') {
    navigation.append(navigationLink('/admin', 'Admin'));
  }

  const account = createElement('div', { class: 'site-account' });
  if (user) {
    account.append(
      createElement('span', { class: 'who' }, `${user.firstName} ${user.lastName}`),
      createElement('button', { type: 'button', class: 'link', onClick: signOut }, 'Sign out'),
    );
  } else {
    const next = encodeURIComponent(location.pathname + location.search);
    account.append(createElement('a', { href: `/login?next=${next}` }, 'Sign in'));
  }
  const header = document.querySelector('header.site');
  const brandLink = header.querySelector('.brand');
  brandLink.replaceChildren(
    createElement('strong', {}, 'CTData'),
    createElement('span', {}, 'Civic Data Explorer'),
  );
  brandLink.href = '/';
  header.append(navigation, account);
}

function navigationLink(url, label) {
  const current = isCurrentPage(url) ? (location.pathname === url ? 'page' : 'location') : null;
  return createElement('a', { href: url, 'aria-current': current }, label);
}

function renderReportsNavigation() {
  const reportLinks = [
    ['/explore', 'Explore reports'],
    ['/builder', 'Report builder'],
  ];
  const summary = createElement('summary', {
    'data-current': reportLinks.some(([url]) => isCurrentPage(url)) ? 'true' : null,
  }, 'Reports', createElement('span', { class: 'site-nav-caret', 'aria-hidden': 'true' }, '▾'));
  const links = createElement('div', { class: 'site-nav-links' },
    ...reportLinks.map(([url, label]) => navigationLink(url, label)),
  );
  const group = createElement('details', { class: 'site-nav-group' }, summary, links);
  group.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && group.open) {
      event.preventDefault();
      group.open = false;
      summary.focus();
    }
  });
  group.addEventListener('focusout', (event) => {
    if (!group.contains(event.relatedTarget)) group.open = false;
  });
  document.addEventListener('pointerdown', (event) => {
    if (group.open && !group.contains(event.target)) group.open = false;
  });
  return group;
}

/** Administrator-only pages share a section navigation. */
const ADMIN_LINKS = [
  ['/admin', 'Datasets'],
  ['/admin/datasets/new', 'Add dataset'],
  ['/users', 'People'],
  ['/admin/usage', 'Usage'],
  ['/ai-settings', 'AI settings'],
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
  if (url === '/datasets/mine' && location.pathname === '/datasets/new') return true;
  if (url === '/admin' && ['/users', '/ai-settings'].includes(location.pathname)) return true;
  if (url === '/') {
    return location.pathname === '/';
  }
  // Report viewer pages live under /explore/ and the upload page under /admin/.
  return location.pathname === url || location.pathname.startsWith(`${url}/`);
}

async function signOut() {
  clearPendingProposal();
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    // Return to the login page even if the session has already expired.
  }
  location.assign('/');
}
