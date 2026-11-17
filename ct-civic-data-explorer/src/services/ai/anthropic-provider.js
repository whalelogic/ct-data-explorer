import Anthropic from '@anthropic-ai/sdk';

export function createAnthropicProvider({ name, apiKey, model, timeoutMs }) {
  const client = new Anthropic({
    apiKey,
    baseURL: 'https://api.anthropic.com',
    timeout: timeoutMs,
    maxRetries: 0,
  });
  return {
    name,
    async complete({ system, messages, tools, maxTokens = 4096 }) {
      return client.messages.create({ model, system, messages, tools, max_tokens: maxTokens });
    },
  };
}
