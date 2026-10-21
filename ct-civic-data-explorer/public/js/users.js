import { api, loadSession } from './api.js';
import { h } from './dom.js';
import { boot, renderHeader, showStatus } from './layout.js';
import { revealTab } from './tabs.js';

const $ = (id) => document.getElementById(id);

boot(async () => {
  const { user } = await loadSession();
  if (user.role !== 'admin') {
    location.assign('/');
    return;
  }
  renderHeader(user);

  async function run(statusEl, container, pendingMessage, fn) {
    if (container.getAttribute('aria-busy') === 'true') return;
    revealTab(statusEl);
    showStatus(statusEl, pendingMessage);
    container.setAttribute('aria-busy', 'true');
    const controls = [...container.querySelectorAll('button, input, select')];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    try {
      await fn();
      revealTab(statusEl);
    } catch (err) {
      revealTab(statusEl);
      showStatus(statusEl, err.message, 'error');
    } finally {
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      container.removeAttribute('aria-busy');
    }
  }

  function showLink(target, person, link) {
    for (const result of [$('user-link'), $('invite-link')]) {
      if (result.dataset.personId === String(person.id)) result.hidden = true;
    }
    const isReset = person.hasPassword;
    const linkName = isReset ? 'Password reset link' : 'Invite link';
    const copyLabel = isReset ? 'Copy reset link' : 'Copy invite link';
    const input = h('input', { type: 'text', readonly: true, value: link, 'aria-label': `${linkName} for ${person.email}` });
    const copyButton = h('button', { type: 'button', onClick: async () => {
      try {
        await navigator.clipboard.writeText(link);
        copyButton.textContent = 'Copied';
        copyStatus.textContent = 'Link copied.';
      } catch {
        input.focus();
        input.select();
        copyStatus.textContent = 'Link selected. Copy to share.';
      }
    } }, copyLabel);
    const copyStatus = h('span', { class: 'muted small', role: 'status' });
    target.replaceChildren(
      h('p', {}, h('strong', {}, `${linkName} · ${person.email}`)),
      h('div', { class: 'link-box' }, input, copyButton),
      h('p', { class: 'muted small' }, `No email sent · Expires in ${isReset ? '1 hour' : '7 days'}`),
      copyStatus,
    );
    target.dataset.personId = person.id;
    target.hidden = false;
    revealTab(target);
    copyButton.focus();
  }

  async function loadUsers() {
    const rows = await api('/users');
    $('users-body').replaceChildren(...rows.map(createPersonRow));
    if (!rows.length) {
      $('users-body').append(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'No people yet.')));
    }
  }

  function createPersonRow(person) {
    const self = person.id === user.id;
    const row = h('tr');
    const update = (json) => run($('users-status'), row, 'Updating…', async () => {
      await api(`/users/${person.id}`, { method: 'PATCH', json });
      await loadUsers();
      showStatus($('users-status'), json.role ? 'Role updated.' : json.isActive ? 'Person reactivated.' : 'Person deactivated.', 'ok');
    });
    const role = h('select', {
      'aria-label': `Role for ${person.email}`,
      disabled: self,
      title: self ? 'Your admin access' : null,
      onChange: async (event) => {
        await update({ role: event.target.value });
        if (role.isConnected) role.value = person.role;
      },
    }, h('option', { value: 'staff' }, 'Staff'), h('option', { value: 'admin' }, 'Admin'));
    role.value = person.role;
    const linkButton = h('button', {
      type: 'button',
      class: 'secondary',
      disabled: !person.isActive,
      onClick: () => run($('users-status'), row, 'Creating link…', async () => {
        const { link } = await api(`/users/${person.id}/password-link`, { method: 'POST' });
        showStatus($('users-status'), '');
        showLink($('user-link'), person, link);
      }),
    }, person.hasPassword ? 'Create reset link' : 'Create invite link');
    const accessButton = self ? null : h('button', {
      type: 'button',
      class: person.isActive ? 'danger' : 'secondary',
      onClick: () => update({ isActive: !person.isActive }),
    }, person.isActive ? 'Deactivate' : 'Reactivate');
    const status = !person.isActive ? 'Deactivated' : person.hasPassword ? 'Active' : 'Invite pending';
    row.append(
      h('th', { scope: 'row' }, `${person.firstName} ${person.lastName}${self ? ' (you)' : ''}`),
      h('td', {}, person.email),
      h('td', {}, role),
      h('td', {}, h('span', { class: person.isActive && person.hasPassword ? 'tag active' : 'tag' }, status)),
      h('td', { class: 'actions' }, h('details', {}, h('summary', { 'aria-label': `Actions for ${person.email}` }, 'Actions'), h('div', { class: 'button-row' }, linkButton, accessButton))),
    );
    return row;
  }

  $('invite-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    revealTab(form);
    if (!form.reportValidity()) return;
    const json = Object.fromEntries(new FormData(form));
    run($('invite-status'), form, 'Creating invite…', async () => {
      const { user: invited, link } = await api('/users', { method: 'POST', json });
      showStatus($('invite-status'), '');
      showLink($('invite-link'), invited, link);
      form.reset();
      await loadUsers();
    });
  });

  try {
    await loadUsers();
  } catch (error) {
    $('users-body').replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'People unavailable.')));
    throw error;
  }
});
