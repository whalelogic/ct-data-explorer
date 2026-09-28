/**
 * Summary provider backed by the Claude API. Called server-side only; credentials
 * resolve from the environment (ANTHROPIC_API_KEY) and never reach the browser.
 */
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `You write the notes paragraph for a data card published by CTData Collaborative, a Connecticut nonprofit that makes public data usable for towns, nonprofits and journalists.

The user message is JSON describing the dataset, the places on the card, and each indicator's formatted value for each place. Write two to four sentences of plain, neutral prose that a non-specialist can follow.

When you mention a figure, copy it exactly as it appears in the data. Compare places in words, such as "higher than the statewide figure", rather than calculating differences, ratios or percentage-point gaps: every number in the paragraph is automatically checked against the card, and a calculated number will be flagged as unverified. Describe only what the figures show, without speculating about causes or adding outside information. A value of N/A means the figure is unavailable.

Reply with the paragraph only.`;

/**
 * @param {{ model: string, effort: string, timeoutMs: number }} options
 * @returns {{ name: string, draft: (facts: object) => Promise<string> }}
 */
export function createAnthropicProvider({ model, effort, timeoutMs }) {
  // No automatic retries: a retry would push the request past the 15-second budget.
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 0 });

  return {
    name: 'anthropic',
    async draft(facts) {
      let response;
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          // If the model declines, the API re-runs the request on Anthropic's recommended fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort },
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: JSON.stringify(facts, null, 2) }],
        });
      } catch (err) {
        throw new Error(describeApiError(err), { cause: err });
      }

      if (response.stop_reason === 'refusal') {
        throw new Error(`model declined the request (${response.stop_details?.category ?? 'no category'})`);
      }
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();
      if (!text) throw new Error(`empty response (stop_reason: ${response.stop_reason})`);
      return text;
    },
  };
}

function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'authentication failed; check ANTHROPIC_API_KEY';
  if (err instanceof Anthropic.RateLimitError) return 'rate limited by the Claude API';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'the Claude API timed out';
  if (err instanceof Anthropic.APIConnectionError) return 'could not reach the Claude API';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
