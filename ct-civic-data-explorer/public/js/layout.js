/** Page chrome and small UI helpers shared by every signed-in page. */
import { api } from './api.js';
import { h } from './dom.js';

export function renderHeader(user) {
  const links = [
    ['/', 'Dashboard'],
    ['/builder.html', 'New card'],
  ];
  if (user.role === 'admin') links.push(['/admin.html', 'Admin']);

  const nav = h(
    'nav',
    { 'aria-label': 'Main' },
    ...links.map(([href, text]) => h('a', { href, 'aria-current': isCurrent(href) ? 'page' : null }, text)),
    h('span', { class: 'who' }, `${user.firstName} ${user.lastName}`),
    h('button', { type: 'button', class: 'link', onClick: signOut }, 'Sign out'),
  );
  document.querySelector('header.site').append(nav);
}

/** Show a message in a status element; an empty message hides it. */
export function showStatus(el, message, kind = 'info') {
  el.textContent = message ?? '';
  el.dataset.kind = kind;
  el.hidden = !message;
}

export function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Run a page's async setup and show failures in #page-status instead of leaving a blank page. */
export function boot(main) {
  main().catch((err) => {
    console.error(err);
    const status = document.getElementById('page-status');
    if (status) showStatus(status, err.message, 'error');
  });
}

function isCurrent(href) {
  return href === '/' ? ['/', '/index.html'].includes(location.pathname) : location.pathname === href;
}

async function signOut() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.assign('/login.html');
}
