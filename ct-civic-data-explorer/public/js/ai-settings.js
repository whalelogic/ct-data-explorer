import { api, loadSession } from './api.js';
import { h } from './dom.js';
import { boot, renderAdminNav, renderHeader, showStatus } from './layout.js';

boot(async () => {
  const loading = document.getElementById('settings-loading');
  try {
    const { user } = await loadSession();
    if (user.role !== 'admin') {
      location.assign('/');
      return;
    }

    renderHeader(user);
    renderAdminNav(document.getElementById('admin-nav'));
    mountSettings(await api('/ai-settings'));
  } finally {
    loading.hidden = true;
  }
});

function mountSettings(initialSettings) {
  const form = document.getElementById('ai-settings-form');
  const fields = document.getElementById('ai-settings-fields');
  const provider = document.getElementById('ai-provider');
  const modelField = document.getElementById('ai-model-field');
  const model = document.getElementById('ai-model');
  const save = document.getElementById('save-ai-settings');
  const providerStatus = document.getElementById('ai-provider-status');
  const saveStatus = document.getElementById('ai-settings-status');
  let settings = initialSettings;

  function updateModelField() {
    const selected = settings.providers.find(({ id }) => id === provider.value);
    const disabled = selected.id === 'none';
    modelField.hidden = disabled;
    model.disabled = disabled;
    model.required = !disabled && !selected.defaultModel;
    model.placeholder = selected.defaultModel || 'Enter a model ID';
    model.value = selected.id === settings.provider && settings.model !== selected.defaultModel ? settings.model ?? '' : '';
    save.disabled = !selected.configured && !disabled;

    if (save.disabled) providerStatus.textContent = 'Provider setup is required in the deployment.';
    else if (disabled) providerStatus.textContent = 'Turns off chat and AI summaries.';
    else providerStatus.textContent = 'Credentials are managed in the deployment.';
  }

  function showSettings() {
    provider.replaceChildren(...settings.providers.map(({ id, label, configured }) => (
      h('option', { value: id }, configured || id === 'none' ? label : `${label} (setup required)`)
    )));
    provider.value = settings.provider;
    updateModelField();
  }

  provider.addEventListener('change', () => {
    showStatus(saveStatus, '');
    updateModelField();
  });
  model.addEventListener('input', () => showStatus(saveStatus, ''));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const json = { provider: provider.value, model: model.value.trim() || undefined };
    fields.disabled = true;
    showStatus(saveStatus, 'Saving settings…');
    try {
      settings = await api('/ai-settings', { method: 'PUT', json });
      showSettings();
      showStatus(saveStatus, 'AI settings saved.', 'ok');
    } catch (error) {
      showStatus(saveStatus, error.message, 'error');
    } finally {
      fields.disabled = false;
    }
  });

  showSettings();
  form.hidden = false;
}
