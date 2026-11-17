import { api, loadSession } from './api.js';
import { savePendingProposal } from './chat-proposal.js';
import { h } from './dom.js';
import { boot, renderHeader, showStatus } from './layout.js';

const MAX_HISTORY = 29;
const byId = (id) => document.getElementById(id);

async function initializeChat() {
  const { user, features } = await loadSession();
  renderHeader(user);
  if (!features.assistant) {
    showStatus(byId('page-status'), 'AI chat is unavailable. An administrator can enable it in AI settings.');
    return;
  }

  const chat = byId('chat');
  const privateConsent = byId('chat-include-private');
  privateConsent.checked = false;
  const startOver = byId('new-chat');
  const log = byId('chat-log');
  const input = byId('chat-message');
  const sendButton = byId('chat-send');
  const status = byId('chat-status');
  const linkedId = Number(new URLSearchParams(location.search).get('dataset'));
  const datasetId = Number.isSafeInteger(linkedId) && linkedId > 0 ? linkedId : undefined;
  const privateDatasets = await api('/datasets?scope=private');
  byId('chat-private-consent').hidden = !privateDatasets.some((dataset) => dataset.isActive);
  const linkedPrivateDataset = privateDatasets.some((dataset) => dataset.id === datasetId);
  const messages = [];
  let sending = false;

  function updateControls() {
    startOver.disabled = sending || !messages.length;
    privateConsent.disabled = sending;
    sendButton.disabled = sending;
    input.readOnly = sending;
  }

  function showSuggestions() {
    const hasDatasetContext = datasetId && (!linkedPrivateDataset || privateConsent.checked);
    const suggestions = hasDatasetContext
      ? ['What does this dataset cover?', 'Which indicators are available?']
      : ['What data is available?', 'Compare Hartford and New Haven by population'];
    if (features.assistantReports) suggestions.push('Help me build a report');
    log.replaceChildren(h('div', { class: 'assistant-suggestions' }, suggestions.map((question) =>
      h('button', { type: 'button', class: 'assistant-suggestion', onClick: () => {
        input.value = question;
        send();
      } }, question))));
  }

  function resetConversation() {
    messages.length = 0;
    showStatus(status, '');
    showSuggestions();
    updateControls();
  }

  function addProposal(message, proposal) {
    message.append(h('button', {
      type: 'button',
      class: 'assistant-apply',
      onClick: () => {
        try {
          savePendingProposal(user.id, proposal);
          location.assign(`/builder?dataset=${proposal.datasetId}&proposal=1`);
        } catch {
          showStatus(status, 'Enable browser session storage to open the report.', 'error');
        }
      },
    }, 'Open in report builder'));
  }

  async function send() {
    const question = input.value.trim();
    if (!question || sendButton.disabled) return;
    if (!messages.length) log.replaceChildren();
    const prompt = { role: 'user', content: question };
    const bubble = h('div', { class: 'assistant-message is-user' }, question);
    log.append(bubble);
    input.value = '';
    sending = true;
    updateControls();
    showStatus(status, 'Working…');
    log.scrollTop = log.scrollHeight;
    try {
      const history = messages.slice(-MAX_HISTORY);
      if (history[0]?.role === 'assistant') history.shift();
      const { reply, proposal } = await api('/assistant', {
        method: 'POST',
        json: {
          messages: [...history, prompt],
          context: { page: 'chat', datasetId, includePrivate: privateConsent.checked },
        },
      });
      messages.push(prompt, { role: 'assistant', content: reply.slice(0, 4000) });
      const answer = h('div', { class: 'assistant-message' }, renderRichText(reply));
      if (proposal) addProposal(answer, proposal);
      log.append(answer);
      showStatus(status, '');
    } catch (error) {
      bubble.remove();
      if (!messages.length) showSuggestions();
      input.value = question;
      showStatus(status, error.message, 'error');
    } finally {
      sending = false;
      updateControls();
      log.scrollTop = log.scrollHeight;
      if (document.activeElement === document.body || document.activeElement === sendButton) input.focus();
    }
  }

  privateConsent.addEventListener('change', () => {
    if (!privateConsent.checked) resetConversation();
    else if (!messages.length) showSuggestions();
  });
  startOver.addEventListener('click', () => {
    privateConsent.checked = false;
    resetConversation();
    input.value = '';
    input.focus();
  });
  byId('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });
  updateControls();
  showSuggestions();
  startOver.hidden = false;
  chat.hidden = false;
}

/** Render paragraphs, bullets and emphasis as text nodes. */
function renderRichText(text) {
  const children = [];
  let list = null;
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = h('ul');
        children.push(list);
      }
      list.append(h('li', {}, emphasis(bullet[1])));
    } else {
      list = null;
      if (line.trim()) children.push(h('p', {}, emphasis(line)));
    }
  }
  return children;
}

function emphasis(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
    .map((part) => /^\*\*[^*]+\*\*$/.test(part) ? h('strong', {}, part.slice(2, -2)) : part);
}

boot(initializeChat);
