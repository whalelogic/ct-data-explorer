/** Administrators' activity log: sign-ins and changes to people, datasets and reports. */
import { api, loadSession } from './api.js';
import { h as createElement } from './dom.js';
import { boot, renderAdminNav, renderHeader, showStatus } from './layout.js';

const PAGE_SIZE = 50;

/** What each recorded action means, in the words the rest of the app uses. */
const ACTION_TEXT = {
  'auth.signed_in': () => 'Signed in',
  'auth.signed_out': () => 'Signed out',
  'auth.sign_in_failed': () => 'Sign-in failed: wrong email or password',
  'auth.sign_in_locked': () => 'Sign-in refused: the account is locked after too many failed attempts',
  'auth.password_changed': () => 'Changed their password',
  'auth.password_set_from_link': () => 'Set a password from an invite or reset link',
  'user.invited': (entry) => `Invited ${label(entry)} as ${roleName(entry.details?.role)}`,
  'user.role_changed': (entry) => `Changed ${label(entry)} from ${roleName(entry.details?.from)} to ${roleName(entry.details?.to)}`,
  'user.deactivated': (entry) => `Deactivated ${label(entry)}`,
  'user.reactivated': (entry) => `Reactivated ${label(entry)}`,
  'user.password_link_issued': (entry) => `Created a password link for ${label(entry)}`,
  'dataset.uploaded': (entry) => `Uploaded ${label(entry)}${entry.details?.rows == null ? '' : ` (${Number(entry.details.rows).toLocaleString('en-US')} rows)`}`,
  'dataset.fields_approved': (entry) => `Chose ${entry.details?.approvedFields ?? 'the'} field${entry.details?.approvedFields === 1 ? '' : 's'} people can use in ${label(entry)}`,
  'dataset.published': (entry) => `Published ${label(entry)}`,
  'dataset.unpublished': (entry) => `Unpublished ${label(entry)}`,
  'dataset.row_label_changed': (entry) => `Changed which column names the rows of ${label(entry)}`,
  'report.created': (entry) => `Saved the report “${label(entry)}”`,
  'report.deleted': (entry) => `Deleted the report “${label(entry)}”`,
};

const dateTimeFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

const activityBody = document.getElementById('activity-body');
const activityStatus = document.getElementById('activity-status');
const categorySelect = document.getElementById('activity-category');
const moreButton = document.getElementById('activity-more');

let oldestEntryId = null;
let requestNumber = 0;

async function initializeActivityPage() {
  const { user } = await loadSession();
  if (user.role !== 'admin') {
    location.assign('/');
    return;
  }
  renderHeader(user);
  renderAdminNav(document.getElementById('admin-nav'));
  categorySelect.addEventListener('change', () => loadActivity({ reset: true }));
  moreButton.addEventListener('click', () => loadActivity({ reset: false }));
  await loadActivity({ reset: true });
}

async function loadActivity({ reset }) {
  const thisRequest = ++requestNumber;
  if (reset) {
    oldestEntryId = null;
    activityBody.replaceChildren();
    showStatus(activityStatus, 'Loading activity…');
  }
  moreButton.disabled = true;

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (categorySelect.value) {
    query.set('category', categorySelect.value);
  }
  if (oldestEntryId) {
    query.set('before', String(oldestEntryId));
  }

  try {
    const { entries, hasMore } = await api(`/audit?${query}`);
    // A newer filter choice may finish first; never mix its rows with an older response.
    if (thisRequest !== requestNumber) {
      return;
    }
    for (const entry of entries) {
      activityBody.append(createActivityRow(entry));
    }
    if (entries.length > 0) {
      oldestEntryId = entries.at(-1).id;
    }
    moreButton.hidden = !hasMore;
    const isEmpty = activityBody.children.length === 0;
    showStatus(activityStatus, isEmpty ? 'Nothing has been recorded here yet.' : '');
  } catch (error) {
    if (thisRequest === requestNumber) {
      showStatus(activityStatus, error.message, 'error');
    }
  } finally {
    if (thisRequest === requestNumber) {
      moreButton.disabled = false;
    }
  }
}

function createActivityRow(entry) {
  const occurredAt = new Date(entry.occurredAt);
  const when = createElement('time', { datetime: occurredAt.toISOString() }, dateTimeFormat.format(occurredAt));

  const who = createElement('td', {});
  if (entry.actor?.name) {
    who.append(entry.actor.name, createElement('span', { class: 'activity-detail' }, entry.actor.email));
  } else {
    // Failed sign-ins have no account, only the address that was typed.
    who.append(entry.actor?.email ?? 'Unknown');
  }

  const describe = ACTION_TEXT[entry.action];
  const what = createElement('td', {}, describe ? describe(entry) : entry.action);
  if (entry.ip) {
    what.append(createElement('span', { class: 'activity-detail' }, `From ${entry.ip}`));
  }

  return createElement('tr', {}, createElement('td', { class: 'activity-when' }, when), who, what);
}

function label(entry) {
  return entry.target?.label ?? `${entry.target?.type ?? 'item'} ${entry.target?.id ?? ''}`.trim();
}

function roleName(role) {
  if (role === 'admin') {
    return 'administrator';
  }
  return role ?? 'unknown role';
}

boot(initializeActivityPage);
