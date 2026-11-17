/** Bridge Chat Completions providers to the content blocks used by the assistant. */
export function createCompatibleProvider({ name, apiKey, endpoint, model, timeoutMs, fetcher = fetch }) {
  const replies = new WeakMap();
  return {
    name,
    async complete({ system, messages, tools = [], maxTokens = 4096 }) {
      const allMessages = [{ role: 'system', content: system }, ...messages.flatMap(toMessages)];
      const response = await fetcher(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          messages: allMessages,
          [name === 'openai' ? 'max_completion_tokens' : 'max_tokens']: maxTokens,
          ...(tools.length ? { tools: tools.map(toFunction), tool_choice: 'auto' } : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error('Provider request failed'), { status: response.status });
      }
      const choice = (await response.json()).choices?.[0];
      if (!choice?.message) throw new Error('Empty provider response');
      const { message } = choice;
      const content = [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...(message.tool_calls ?? []).filter((call) => call.type === 'function').map((call) => ({
          type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments),
        })),
      ];
      // Replay the original message to keep provider-specific tool metadata, including Gemini thought signatures.
      replies.set(content, message);
      const stopReason = message.refusal || choice.finish_reason === 'content_filter'
        ? 'refusal'
        : content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
      return { content, stop_reason: stopReason };
    },
  };

  function toMessages({ role, content }) {
    if (typeof content === 'string') return [{ role, content }];
    if (replies.has(content)) return [replies.get(content)];
    const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n');
    const results = content.filter((block) => block.type === 'tool_result').map((block) => ({
      role: 'tool', tool_call_id: block.tool_use_id, content: block.content,
    }));
    return [...(text ? [{ role, content: text }] : []), ...results];
  }
}

function toFunction({ name, description, input_schema }) {
  return { type: 'function', function: { name, description, parameters: input_schema } };
}

function parseArguments(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
