import { config } from '../../config.js';
import { HttpError } from '../../lib/http-error.js';
import { getSettings, saveSettings } from '../../repositories/ai-settings.js';
import { createAnthropicProvider } from './anthropic-provider.js';
import { createCompatibleProvider } from './compatible-provider.js';

const providers = {
  google: {
    label: 'Google Gemini',
    defaultModel: 'gemini-3.5-flash-lite',
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5-mini',
    apiKey: process.env.OPENAI_API_KEY,
    endpoint: 'https://api.openai.com/v1/chat/completions',
  },
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-haiku-5-5',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  compatible: {
    label: 'OpenAI-compatible',
    defaultModel: null,
    apiKey: process.env.AI_COMPATIBLE_API_KEY,
    endpoint: compatibleEndpoint(process.env.AI_COMPATIBLE_BASE_URL),
  },
  none: { label: 'Disabled', defaultModel: null },
};

export const AI_PROVIDER_IDS = Object.keys(providers);

function compatibleEndpoint(baseUrl) {
  const url = URL.parse(baseUrl ?? '');
  if (url?.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  return `${url.href.replace(/\/+$/, '')}/chat/completions`;
}

function isConfigured(id) {
  const provider = providers[id];
  if (id === 'none') return true;
  return Boolean(provider?.apiKey && (id === 'anthropic' || provider.endpoint));
}

function presentSettings({ provider, model }) {
  return {
    provider,
    model,
    available: Boolean(model && isConfigured(provider)),
    providers: AI_PROVIDER_IDS.map((id) => ({
      id, label: providers[id].label, defaultModel: providers[id].defaultModel, configured: isConfigured(id),
    })),
  };
}

async function currentSettings() {
  const stored = await getSettings();
  if (stored) return stored;
  const provider = AI_PROVIDER_IDS.includes(config.ai.provider) ? config.ai.provider : 'none';
  const model = provider === 'none' ? null : config.ai.model || providers[provider].defaultModel;
  return { provider, model };
}

export async function readAiSettings() {
  return presentSettings(await currentSettings());
}

export async function updateAiSettings(provider, model) {
  if (!isConfigured(provider)) throw new HttpError(422, 'Configure this provider’s credentials on the server first.');
  const selectedModel = provider === 'none' ? null : model || providers[provider].defaultModel;
  if (provider !== 'none' && !selectedModel) throw new HttpError(422, 'Enter a model name.');
  await saveSettings(provider, selectedModel);
  return presentSettings({ provider, model: selectedModel });
}

export async function isAiAvailable() {
  const { provider, model } = await currentSettings();
  return Boolean(model && isConfigured(provider));
}

export async function getAiProvider({ timeoutMs = 60_000 } = {}) {
  const { provider, model } = await currentSettings();
  if (!model || !isConfigured(provider)) return null;
  const { apiKey, endpoint } = providers[provider];
  const options = { name: provider, apiKey, endpoint, model, timeoutMs };
  return provider === 'anthropic' ? createAnthropicProvider(options) : createCompatibleProvider(options);
}

/** Provider error bodies can contain request data. Log only a status or a fixed reason. */
export function aiFailureReason(error) {
  if (Number.isInteger(error?.status)) return `HTTP ${error.status}`;
  if (error?.name === 'TimeoutError') return 'timeout';
  return 'request failed';
}
