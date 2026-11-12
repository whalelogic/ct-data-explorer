/**
 * The data assistant and summary drafting, without a database or the Claude API.
 * A scripted client stands in for Claude; lookups that need data are covered by
 * test/curation-integration.test.js.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { config } from '../src/config.js';
import { askAssistant, canGenerateReports, setAssistantClientForTests } from '../src/services/ai/assistant.js';
import { summaryFacts } from '../src/services/ai/index.js';

const viewer = { id: 7, role: 'viewer' };
const ask = [{ role: 'user', content: 'What data is there?' }];

/** Replies in order. A step is { text }, { tool, input } or { refusal: true }. */
function scriptedClaude(steps, { streaming = false } = {}) {
  const requests = [];
  let id = 0;
  const respond = (params) => {
    requests.push(structuredClone(params));
    const step = steps.shift();
    if (!step) throw new Error('scripted Claude ran out of steps');
    if (step.refusal) return { stop_reason: 'refusal', content: [] };
    if (step.text) return { stop_reason: 'end_turn', content: [{ type: 'text', text: step.text }] };
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tool_${++id}`, name: step.tool, input: step.input }] };
  };
  const messages = { create: async (params) => respond(params) };
  if (streaming) {
    // The shape of the SDK's stream helper: on('text') for each piece, then the whole message.
    messages.stream = (params) => {
      const listeners = [];
      return {
        on(event, listener) {
          if (event === 'text') listeners.push(listener);
          return this;
        },
        async finalMessage() {
          const message = respond(params);
          for (const block of message.content) {
            if (block.type !== 'text') continue;
            for (const word of block.text.split(/(?<= )/)) {
              listeners.forEach((listener) => listener(word));
            }
          }
          return message;
        },
      };
    };
  }
  return { requests, beta: { messages } };
}

afterEach(() => setAssistantClientForTests(undefined));

test('a plain answer comes back as the reply, with the app context sent ahead of the question', async () => {
  const claude = scriptedClaude([{ text: 'There are two datasets.' }]);
  setAssistantClientForTests(claude);
  const answer = await askAssistant(ask, { page: 'dashboard' }, viewer);
  assert.deepEqual(answer, { reply: 'There are two datasets.', proposal: null });

  const [context, question] = claude.requests[0].messages[0].content;
  assert.match(context.text, /Signed-in role: viewer\. Can generate reports: no\./);
  assert.match(context.text, /Page: dashboard\./);
  assert.equal(question.text, 'What data is there?');
});

test('earlier turns are sent in order and the tool list never changes between requests', async () => {
  const claude = scriptedClaude([{ text: 'Second answer.' }, { text: 'Third answer.' }]);
  setAssistantClientForTests(claude);
  const history = [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First answer.' },
    { role: 'user', content: 'Second question' },
  ];
  await askAssistant(history, {}, viewer);
  await askAssistant(ask, {}, viewer);

  const sent = claude.requests[0].messages;
  assert.deepEqual(sent.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.equal(sent[0].content, 'First question');
  // A stable prefix (tools, then system) is what lets the prompt cache work.
  assert.deepEqual(claude.requests[0].tools, claude.requests[1].tools);
  assert.equal(claude.requests[0].system, claude.requests[1].system);
  assert.deepEqual(claude.requests[0].tools.map((tool) => tool.name), ['list_datasets', 'describe_dataset', 'get_figures', 'propose_report']);
});

test('a streamed answer arrives piece by piece and adds up to the reply', async () => {
  setAssistantClientForTests(scriptedClaude([{ text: 'Hartford has the most people.' }], { streaming: true }));
  const events = [];
  const answer = await askAssistant(ask, {}, viewer, (event) => events.push(event));
  assert.ok(events.length > 1, 'the text should arrive in more than one piece');
  assert.ok(events.every((event) => event.type === 'text'));
  assert.equal(events.map((event) => event.delta).join(''), answer.reply);
});

test('a lookup is announced, and a refused lookup goes back to Claude as an error to explain', async () => {
  const proposal = { dataset_id: 1, compare_by: 'town', rows: [], fields: ['pop'], summaries: [], include_statewide: false, title: '' };
  const claude = scriptedClaude([
    { tool: 'propose_report', input: proposal },
    { text: 'Only staff and administrators can have me set up reports.' },
  ], { streaming: true });
  setAssistantClientForTests(claude);
  const events = [];
  const answer = await askAssistant([{ role: 'user', content: 'Build me a report' }], {}, viewer, (event) => events.push(event));

  assert.deepEqual(events[0], { type: 'status', text: 'Setting up the report…' });
  assert.equal(answer.proposal, null);
  const result = claude.requests[1].messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.equal(result.is_error, true);
  assert.match(result.content, /Only staff and administrators/);
});

test('a refusal becomes a polite reply instead of an error', async () => {
  setAssistantClientForTests(scriptedClaude([{ refusal: true }]));
  const answer = await askAssistant(ask, {}, viewer);
  assert.match(answer.reply, /can’t help with that/);
  assert.equal(answer.proposal, null);
});

test('a conversation that keeps calling tools stops after a fixed number of rounds', async () => {
  const proposal = { dataset_id: 1, compare_by: 'town', rows: [], fields: [], summaries: [], include_statewide: false, title: '' };
  const claude = scriptedClaude(Array.from({ length: 20 }, () => ({ tool: 'propose_report', input: proposal })));
  setAssistantClientForTests(claude);
  const answer = await askAssistant(ask, {}, viewer);
  assert.equal(claude.requests.length, 8);
  assert.match(answer.reply, /more steps than I can manage/);
});

test('a failing Claude request is reported without leaking the cause', async (context) => {
  context.mock.method(console, 'error', () => {});
  setAssistantClientForTests({ beta: { messages: { create: async () => { throw new Error('socket hang up at 10.0.0.5'); } } } });
  await assert.rejects(askAssistant(ask, {}, viewer), (error) => {
    return error.status === 502 && !error.message.includes('10.0.0.5');
  });
});

// With a real provider configured this would call the Claude API, so it only runs without one.
test('without a provider or client the assistant says it is not set up', { skip: config.ai.provider !== 'none' }, async () => {
  await assert.rejects(askAssistant(ask, {}, viewer), (error) => error.status === 503);
});

test('only staff and administrators may have reports set up for them', () => {
  assert.equal(canGenerateReports({ role: 'admin' }), true);
  assert.equal(canGenerateReports({ role: 'staff' }), true);
  assert.equal(canGenerateReports({ role: 'viewer' }), false);
});

test('summary facts carry the report figures as shown, for town and row-based reports alike', () => {
  const dataset = { name: 'Programs', source: 'Example', vintage: '2026' };
  const towns = summaryFacts({
    dataset,
    places: [{ name: 'Groton', label: 'Groton', geoType: 'town' }, { name: 'Connecticut', label: 'Connecticut (statewide)', geoType: 'state' }],
    indicators: [{ displayLabel: 'Population', cells: [{ display: '38,130' }, { display: '3,624,508' }] }],
  });
  assert.deepEqual(towns.places, [{ name: 'Groton', type: 'town' }, { name: 'Connecticut', type: 'statewide' }]);
  assert.deepEqual(towns.indicators[0].values, { Groton: '38,130', Connecticut: '3,624,508' });

  const rows = summaryFacts({
    dataset,
    rowBased: true,
    places: [{ name: 'Row 2', label: 'Food pantry', geoType: 'row' }],
    indicators: [{ displayLabel: 'Clients', cells: [{ display: '1,200' }] }],
  });
  // Row-based reports are known by their labels, not their spreadsheet positions.
  assert.deepEqual(rows.places, [{ name: 'Food pantry', type: 'row' }]);
  assert.deepEqual(rows.indicators[0].values, { 'Food pantry': '1,200' });
  assert.ok(!('summaries' in rows));
});
