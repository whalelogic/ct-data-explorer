/**
 * The data assistant: a chat button in the bottom-right corner of every signed-in page.
 * It answers questions about published data and, for staff and administrators, sets up
 * reports that can be applied to the report builder.
 *
 * Pages tell it what the person is looking at with setAssistantContext(), and the builder
 * receives proposed reports through setAssistantApply(). The conversation is kept for this
 * tab only (sessionStorage), so it survives moving between pages but not closing the tab.
 */
import { api, currentSession } from './api.js';
import { h } from './dom.js';

const STORAGE_KEY = 'ctde-assistant';
/** A proposal waiting for the builder to open, when it was made on another page. */
export const PENDING_PROPOSAL_KEY = 'ctde-assistant-proposal';
const MAX_SENT_TURNS = 30;

let contextProvider = () => ({});
let applyHandler = null;
let state = { open: false, messages: [] };
let elements = null;
let isSending = false;

/** @param {() => { page?: string, datasetId?: number, selection?: object }} provider */
export function setAssistantContext(provider) {
  contextProvider = provider;
}

/** @param {(proposal: { datasetId: number, selection: object }) => void | Promise<void>} handler */
export function setAssistantApply(handler) {
  applyHandler = handler;
}

/** Read and clear a proposal that was made on another page. */
export function takePendingProposal() {
  try {
    const stored = sessionStorage.getItem(PENDING_PROPOSAL_KEY);
    sessionStorage.removeItem(PENDING_PROPOSAL_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function mountAssistant() {
  const features = currentSession()?.features;
  if (!features?.assistant || elements) {
    return;
  }
  loadState();
  elements = buildWidget(features);
  document.body.append(elements.launcher, elements.panel);
  renderMessages();
  setOpen(state.open, { focus: false });
}

// ---- State ----------------------------------------------------------------------------------

function loadState() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (stored && Array.isArray(stored.messages)) {
      state = { open: Boolean(stored.open), messages: stored.messages.slice(-60) };
    }
  } catch {
    // Storage can be unavailable (private windows); the chat still works for this page.
  }
}

function saveState() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not saved; nothing else depends on it.
  }
}

// ---- Layout ---------------------------------------------------------------------------------

const CHAT_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm5 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm5 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" transform="translate(0 1.5)"/></svg>';

function buildWidget(features) {
  const launcher = h('button', {
    type: 'button',
    class: 'assistant-launcher',
    'aria-expanded': 'false',
    'aria-controls': 'assistant-panel',
    onClick: () => setOpen(!state.open),
  });
  launcher.innerHTML = CHAT_ICON;
  launcher.append(h('span', { class: 'assistant-launcher-label' }, 'Ask about the data'));

  const log = h('div', { class: 'assistant-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const input = h('textarea', {
    id: 'assistant-input',
    class: 'assistant-input',
    rows: 1,
    maxlength: 4000,
    placeholder: 'Ask a question about the data…',
    onKeydown: handleInputKeydown,
    onInput: autosize,
  });
  const send = h('button', { type: 'submit', class: 'assistant-send', 'aria-label': 'Send' }, '↑');
  const form = h('form', { class: 'assistant-form', onSubmit: handleSubmit },
    h('label', { for: 'assistant-input', class: 'sr-only' }, 'Message the data assistant'), input, send);

  const header = h('div', { class: 'assistant-header' },
    h('div', {},
      h('h2', { id: 'assistant-title' }, 'Data assistant'),
      h('p', {}, features.assistantReports ? 'Ask about the data or have it set up a report' : 'Ask about the published data')),
    h('div', { class: 'assistant-header-actions' },
      h('button', { type: 'button', class: 'link', onClick: startNewChat }, 'New chat'),
      h('button', { type: 'button', class: 'assistant-close', 'aria-label': 'Close the assistant', onClick: () => setOpen(false) }, '×')));

  const panel = h('section', {
    id: 'assistant-panel',
    class: 'assistant-panel',
    role: 'dialog',
    'aria-labelledby': 'assistant-title',
    hidden: true,
    onKeydown: (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    },
  }, header, log, form, h('p', { class: 'assistant-footnote' }, 'Answers use published figures only. Check important numbers in the report.'));

  return { launcher, panel, log, input, send, features };
}

function setOpen(open, { focus = true } = {}) {
  state.open = open;
  saveState();
  elements.panel.hidden = !open;
  elements.launcher.setAttribute('aria-expanded', String(open));
  elements.launcher.classList.toggle('is-open', open);
  if (open && focus) {
    elements.input.focus();
    scrollToEnd();
  } else if (!open && focus) {
    elements.launcher.focus();
  }
}

function startNewChat() {
  state.messages = [];
  saveState();
  renderMessages();
  elements.input.focus();
}

// ---- Messages -------------------------------------------------------------------------------

function renderMessages() {
  const log = elements.log;
  log.replaceChildren();
  if (state.messages.length === 0) {
    log.append(renderWelcome());
    return;
  }
  for (const message of state.messages) {
    log.append(renderMessage(message));
  }
  scrollToEnd();
}

function renderWelcome() {
  const welcome = h('div', { class: 'assistant-welcome' },
    h('p', {}, elements.features.assistantReports
      ? 'Hi! I can answer questions about the published data, or set up a report for you to review.'
      : 'Hi! I can answer questions about the published data.'));
  const list = h('div', { class: 'assistant-suggestions' });
  for (const suggestion of suggestionsForPage()) {
    list.append(h('button', { type: 'button', class: 'assistant-suggestion', onClick: () => send(suggestion) }, suggestion));
  }
  welcome.append(list);
  return welcome;
}

function suggestionsForPage() {
  const page = currentContext().page;
  const canBuild = elements.features.assistantReports;
  if (page === 'builder') {
    return [
      ...(canBuild ? ['Set up a report comparing Hartford, New Haven and Bridgeport'] : []),
      'Which fields can I use in this dataset?',
      'What is the average population of a Connecticut town?',
    ];
  }
  if (page === 'dataset') {
    return ['What does this dataset cover?', 'Which fields can I report on?', ...(canBuild ? ['Build a report with this data'] : [])];
  }
  return [
    'What data is available?',
    'Which towns have the highest median household income?',
    ...(canBuild ? ['Help me build a report about housing'] : []),
  ];
}

function renderMessage(message) {
  if (message.role === 'user') {
    return h('div', { class: 'assistant-message is-user' }, message.content);
  }
  const bubble = h('div', { class: `assistant-message${message.error ? ' is-error' : ''}` }, ...renderRichText(message.content));
  if (message.proposal) {
    bubble.append(renderProposal(message.proposal));
  }
  return bubble;
}

/** Paragraphs, "- " bullet lists and **bold**, built from text nodes only (never HTML). */
function renderRichText(text) {
  const nodes = [];
  let list = null;
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (bullet) {
      list ??= h('ul');
      list.append(h('li', {}, ...inline(bullet[1])));
      continue;
    }
    if (list) {
      nodes.push(list);
      list = null;
    }
    if (line.trim()) {
      nodes.push(h('p', {}, ...inline(line)));
    }
  }
  if (list) {
    nodes.push(list);
  }
  return nodes;
}

function inline(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
    .map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? h('strong', {}, part.slice(2, -2)) : part));
}

function renderProposal(proposal) {
  const onBuilder = Boolean(applyHandler);
  const button = h('button', { type: 'button', class: 'assistant-apply' }, onBuilder ? 'Apply to my report' : 'Open in report builder');
  button.addEventListener('click', async () => {
    if (onBuilder) {
      button.disabled = true;
      try {
        await applyHandler(proposal);
        button.textContent = 'Applied ✓';
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Try again';
        console.error(error);
      }
      return;
    }
    try {
      sessionStorage.setItem(PENDING_PROPOSAL_KEY, JSON.stringify(proposal));
    } catch {
      // Without storage the builder still opens on the right dataset.
    }
    location.assign(`/builder?dataset=${encodeURIComponent(proposal.datasetId)}`);
  });
  return h('div', { class: 'assistant-proposal' },
    h('span', { class: 'assistant-proposal-label' }, 'Report ready to review'),
    button);
}

function scrollToEnd() {
  elements.log.scrollTop = elements.log.scrollHeight;
}

// ---- Sending --------------------------------------------------------------------------------

function currentContext() {
  const page = location.pathname.startsWith('/builder') ? 'builder'
    : location.pathname.startsWith('/dataset') ? 'dataset'
      : location.pathname === '/' ? 'dashboard'
        : location.pathname.startsWith('/explore/') ? 'report'
          : location.pathname.startsWith('/explore') ? 'reports'
            : location.pathname.startsWith('/admin') ? 'admin' : 'other';
  try {
    return { page, ...contextProvider() };
  } catch {
    return { page };
  }
}

function handleInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSubmit(event);
  }
}

function autosize() {
  const input = elements.input;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function handleSubmit(event) {
  event.preventDefault();
  const text = elements.input.value.trim();
  if (text) {
    elements.input.value = '';
    autosize();
    send(text);
  }
}

async function send(text) {
  if (isSending) {
    return;
  }
  isSending = true;
  elements.send.disabled = true;
  state.messages.push({ role: 'user', content: text });
  saveState();
  renderMessages();
  const typing = h('div', { class: 'assistant-message is-typing', 'aria-label': 'The assistant is looking at the data' },
    h('span'), h('span'), h('span'));
  elements.log.append(typing);
  scrollToEnd();

  try {
    // Only the text of earlier turns is sent; errors shown to the person are not part of the conversation.
    const turns = state.messages.filter((message) => !message.error)
      .map(({ role, content }) => ({ role, content }))
      .slice(-MAX_SENT_TURNS);
    while (turns.length && turns[0].role !== 'user') {
      turns.shift();
    }
    const { reply, proposal } = await api('/assistant', { method: 'POST', json: { messages: turns, context: currentContext() } });
    state.messages.push({ role: 'assistant', content: reply, proposal: proposal ?? undefined });
  } catch (error) {
    state.messages.push({ role: 'assistant', content: error.message, error: true });
  } finally {
    isSending = false;
    elements.send.disabled = false;
    saveState();
    renderMessages();
    elements.input.focus();
  }
}
