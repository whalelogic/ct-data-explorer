import { api, loadSession } from './api.js';
import { cardActionButtons, fetchCards } from './card-library.js';
import { h } from './dom.js';
import { boot, debounce, formatDate, renderHeader, showStatus } from './layout.js';

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

  // ---- Datasets ----

  async function loadDatasets() {
    const rows = await api('/datasets');
    $('datasets-body').replaceChildren(
      ...rows.map((d) =>
        h(
          'tr',
          {},
          h('td', {}, d.name),
          h('td', {}, d.vintage),
          h('td', { class: 'num' }, d.version),
          h('td', { class: 'num' }, d.rowCount.toLocaleString('en-US')),
          h('td', {}, d.uploadedBy),
          h('td', {}, formatDate(d.uploadedAt)),
          h('td', {}, h('span', { class: d.isActive ? 'tag active' : 'tag' }, d.isActive ? 'Active' : 'Inactive')),
          h(
            'td',
            {},
            h(
              'button',
              {
                type: 'button',
                class: 'secondary',
                onClick: () =>
                  run($('datasets-status'), async () => {
                    await api(`/datasets/${d.id}`, { method: 'PATCH', json: { isActive: !d.isActive } });
                    await loadDatasets();
                  }),
              },
              d.isActive ? 'Deactivate' : 'Activate',
            ),
          ),
        ),
      ),
    );
    showStatus($('datasets-status'), rows.length ? '' : 'No datasets uploaded yet.');
  }

  $('upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const errors = $('upload-errors');
    errors.replaceChildren();
    errors.hidden = true;

    const data = new FormData(form);
    data.set('activate', form.activate.checked ? 'true' : 'false');
    button.disabled = true;
    showStatus($('upload-status'), 'Uploading and validating…');
    try {
      const dataset = await api('/datasets', { method: 'POST', form: data });
      showStatus(
        $('upload-status'),
        `Saved ${dataset.name}, ${dataset.vintage} as version ${dataset.version} (${dataset.rowCount} rows)${dataset.isActive ? ' and activated it' : ''}.`,
        'ok',
      );
      form.reset();
      await loadDatasets();
    } catch (err) {
      showStatus($('upload-status'), err.message, 'error');
      if (Array.isArray(err.details)) {
        errors.replaceChildren(...err.details.map((d) => h('li', {}, typeof d === 'string' ? d : d.message)));
        errors.hidden = false;
      }
    } finally {
      button.disabled = false;
    }
  });

  // ---- Indicators ----

  async function loadIndicators() {
    const rows = await api('/indicators');
    $('indicators-body').replaceChildren(
      ...rows.map((i) =>
        h(
          'tr',
          {},
          h('td', {}, h('code', {}, i.key)),
          h('td', {}, i.label),
          h('td', {}, i.unit),
          h('td', { class: 'num' }, i.decimals),
          h('td', {}, i.derivation === 'ratio' ? `Computed: ${i.numeratorKey} ÷ ${i.denominatorKey}` : 'Uploaded'),
        ),
      ),
    );
  }

  const derivation = $('ind-derivation');
  derivation.addEventListener('change', () => {
    document.querySelectorAll('.ratio-field').forEach((el) => (el.hidden = derivation.value !== 'ratio'));
  });

  $('indicator-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    run($('indicator-status'), async () => {
      const values = Object.fromEntries(new FormData(form));
      const created = await api('/indicators', {
        method: 'POST',
        json: {
          ...values,
          decimals: Number(values.decimals),
          numeratorKey: values.numeratorKey || undefined,
          denominatorKey: values.denominatorKey || undefined,
        },
      });
      showStatus($('indicator-status'), `Added indicator "${created.key}".`, 'ok');
      form.reset();
      derivation.dispatchEvent(new Event('change'));
      await loadIndicators();
    });
  });

  // ---- Saved cards ----

  const cardSearch = $('card-search');

  async function loadCards() {
    try {
      const query = cardSearch.value.trim();
      const cards = await fetchCards(query);
      $('cards-body').replaceChildren(
        ...cards.map((card) =>
          h(
            'tr',
            {},
            h('td', {}, h('a', { href: `/builder.html?card=${card.id}` }, card.title)),
            h('td', {}, card.towns.join(', ')),
            h('td', {}, `${card.dataset.name}, ${card.dataset.vintage}`),
            h('td', {}, card.createdBy.name),
            h('td', {}, formatDate(card.updatedAt)),
            h('td', { class: 'actions' }, ...cardActionButtons(card, { user, status: $('cards-status'), reload: loadCards })),
          ),
        ),
      );
      showStatus($('cards-status'), cards.length ? '' : query ? 'No saved cards match your search.' : 'No saved cards yet.');
    } catch (err) {
      showStatus($('cards-status'), err.message, 'error');
    }
  }

  cardSearch.addEventListener('input', debounce(loadCards, 250));

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
              u.hasPassword ? 'Password reset link' : 'New invite link',
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

  await Promise.all([loadDatasets(), loadIndicators(), loadCards(), loadUsers()]);
});
