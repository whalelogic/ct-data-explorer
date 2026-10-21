/** Page header and UI helpers shared by signed-in pages. */
import { api } from './api.js';
import { h as createElement } from './dom.js';
import { initializeTabs, revealTab } from './tabs.js';

export function renderHeader(user) {
  const navigationLinks = [
    ['/', 'Dashboard'],
    ['/explore', 'Explore'],
    ['/builder', 'Reports'],
  ];
  if (user.role === 'admin') {
    navigationLinks.push(['/admin', 'Data']);
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

  const userName = createElement('span', { class: 'who' }, `${user.firstName} ${user.lastName}`);
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
}

/** An empty message hides the status element. */
export function showStatus(statusElement, message, kind = 'info') {
  statusElement.textContent = message ?? '';
  statusElement.dataset.kind = kind;
  statusElement.hidden = !message;
  if (message && kind === 'error') revealTab(statusElement);
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
  initializeTabs();
  document.addEventListener('pointerdown', closeActionMenus);
  initializePage().then(() => initializeTabs()).catch(showPageSetupError);
}

function closeActionMenus(event) {
  for (const menu of document.querySelectorAll('details.report-more[open], td.actions details[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
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
  if (url === '/admin' && location.pathname === '/dataset') return true;
  if (url === '/explore' && location.pathname === '/town') return true;
  return location.pathname === url;
}

async function signOut() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    // Return to the login page even if the session has already expired.
  }
  location.assign('/login');
}
