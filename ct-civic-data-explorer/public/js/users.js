import { api, loadSession } from './api.js';
import { h } from './dom.js';
import { boot, renderHeader, showStatus } from './layout.js';

const $ = (id) => document.getElementById(id);

boot(async () => {
  const { user } = await loadSession();
  if (user.role !== 'admin') {
    location.assign('/');
    return;
  }
  renderHeader(user);

  /** Run an action, reporting failure in the given status element. */
  async function run(statusEl, fn) {
    showStatus(statusEl, '');
    try {
      await fn();
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  }

  // ---- Users ----

  function showLink(message, link) {
    const input = h('input', { type: 'text', readonly: true, value: link, 'aria-label': 'One-time link' });
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        input.select();
      }
    };
    $('user-link').replaceChildren(h('p', {}, message), h('div', { class: 'link-box' }, input, h('button', { type: 'button', onClick: copy }, 'Copy')));
    $('user-link').hidden = false;
  }

  async function loadUsers() {
    const rows = await api('/users');
    $('users-body').replaceChildren(
      ...rows.map((u) => {
        const self = u.id === user.id;
        const update = (json) =>
          run($('users-status'), async () => {
            await api(`/users/${u.id}`, { method: 'PATCH', json });
            await loadUsers();
          });
        const role = h(
          'select',
          { 'aria-label': `Role for ${u.email}`, disabled: self, onChange: (e) => update({ role: e.target.value }) },
          h('option', { value: 'staff' }, 'Staff'),
          h('option', { value: 'admin' }, 'Admin'),
        );
        role.value = u.role;
        return h(
          'tr',
          {},
          h('td', {}, `${u.firstName} ${u.lastName}`),
          h('td', {}, u.email),
          h('td', {}, role),
          h('td', {}, !u.isActive ? 'Deactivated' : u.hasPassword ? 'Active' : 'Invite pending'),
          h(
            'td',
            { class: 'actions' },
            h(
              'button',
              {
                type: 'button',
                class: 'secondary',
                onClick: () =>
                  run($('users-status'), async () => {
                    const { link } = await api(`/users/${u.id}/password-link`, { method: 'POST' });
                    const expiry = u.hasPassword ? '1 hour' : '7 days';
                    showLink(`One-time link for ${u.email}. It expires in ${expiry}.`, link);
                  }),
              },
              u.hasPassword ? 'Password Reset Link' : 'New Invite Link',
            ),
            self
              ? null
              : h(
                  'button',
                  { type: 'button', class: u.isActive ? 'danger' : 'secondary', onClick: () => update({ isActive: !u.isActive }) },
                  u.isActive ? 'Deactivate' : 'Reactivate',
                ),
          ),
        );
      }),
    );
  }

  $('invite-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    run($('users-status'), async () => {
      const { user: invited, link } = await api('/users', { method: 'POST', json: Object.fromEntries(new FormData(form)) });
      showLink(`Invited ${invited.email}. Send them this one-time link; it expires in 7 days.`, link);
      form.reset();
      await loadUsers();
    });
  });

  await loadUsers();
});
