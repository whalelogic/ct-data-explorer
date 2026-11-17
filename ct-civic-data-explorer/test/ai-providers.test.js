import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompatibleProvider } from '../src/services/ai/compatible-provider.js';
import { draftSummary } from '../src/services/ai/index.js';

test('Gemini tool calls retain thought signatures when sending results', async () => {
  const toolCall = {
    id: 'call-1',
    type: 'function',
    function: { name: 'lookup', arguments: '{"id":1}' },
    extra_content: { google: { thought_signature: 'signature' } },
  };
  const assistantMessage = { role: 'assistant', content: null, tool_calls: [toolCall] };
  const requests = [];
  const provider = createCompatibleProvider({
    name: 'google', apiKey: 'testing-key', endpoint: 'https://example.invalid/chat/completions',
    model: 'example-model', timeoutMs: 1000,
    fetcher: async (url, options) => {
      assert.equal(url, 'https://example.invalid/chat/completions');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer testing-key');
      requests.push(JSON.parse(options.body));
      return Response.json({
        choices: [{ message: requests.length === 1 ? assistantMessage : { role: 'assistant', content: 'Found it.' } }],
      });
    },
  });
  const tools = [{ name: 'lookup', description: 'Find a row', input_schema: { type: 'object' } }];
  const messages = [{
    role: 'user', content: [{ type: 'text', text: 'Find this row.' }, { type: 'text', text: 'ID 1' }],
  }];
  const first = await provider.complete({ system: 'Test', messages, tools });
  assert.equal(first.stop_reason, 'tool_use');
  assert.deepEqual(first.content, [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { id: 1 } }]);
  assert.deepEqual(requests[0].tools, [{
    type: 'function', function: { name: 'lookup', description: 'Find a row', parameters: { type: 'object' } },
  }]);
  assert.equal(requests[0].messages[1].content, 'Find this row.\n\nID 1');

  messages.push(
    { role: 'assistant', content: first.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"id":1}' }] },
  );
  const second = await provider.complete({ system: 'Test', messages, tools });
  assert.deepEqual(requests[1].messages.slice(-2), [
    assistantMessage,
    { role: 'tool', tool_call_id: 'call-1', content: '{"id":1}' },
  ]);
  assert.deepEqual(second, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Found it.' }] });
});

test('a provider error exposes only an HTTP status', async () => {
  const provider = createCompatibleProvider({
    name: 'openai', apiKey: 'testing-key', endpoint: 'https://example.invalid/chat/completions',
    model: 'example-model', timeoutMs: 1000,
    fetcher: async (_url, { body }) => {
      assert.equal(JSON.parse(body).max_completion_tokens, 2048);
      return Response.json({ error: 'Sensitive provider error body' }, { status: 401 });
    },
  });
  await assert.rejects(provider.complete({ system: 'Test', messages: [], maxTokens: 2048 }), {
    status: 401, message: 'Provider request failed',
  });
});

test('AI summaries keep private and record comparison data on the server', async () => {
  const dataset = { isPrivate: false, dataFormat: 'indicators' };
  for (const comparison of [{ isPrivate: true }, { dataFormat: 'records' }]) {
    await assert.rejects(draftSummary({ dataset, datasets: [dataset, comparison] }), { status: 422 });
  }
});
