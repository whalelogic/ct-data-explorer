import { api, loadSession } from './api.js';
import { savePendingProposal } from './chat-proposal.js';
import { h } from './dom.js';
import { boot, renderHeader, showStatus } from './layout.js';

const MAX_DATASETS = 8;
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
  const picker = byId('chat-dataset');
  const selectedList = byId('chat-datasets');
  const privateConsent = byId('chat-include-private');
  const startOver = byId('new-chat');
  const log = byId('chat-log');
  const input = byId('chat-message');
  const sendButton = byId('chat-send');
  const status = byId('chat-status');
  const datasets = new Map((await api('/datasets')).filter((dataset) => dataset.isActive)
    .map((dataset) => [dataset.id, dataset]));
  const params = new URLSearchParams(location.search);
  const selected = new Set(params.getAll('dataset').map(Number).filter((id) => datasets.has(id)).slice(0, MAX_DATASETS));
  const messages = [];
  let sending = false;

  function hasPrivateData() {
    return [...selected].some((id) => datasets.get(id).isPrivate);
  }

  function updateControls() {
    picker.disabled = sending || selected.size >= MAX_DATASETS;
    startOver.disabled = sending || !messages.length;
    privateConsent.disabled = sending;
    sendButton.disabled = sending || (hasPrivateData() && !privateConsent.checked);
    input.readOnly = sending;
    selectedList.querySelectorAll('button').forEach((button) => { button.disabled = sending; });
  }

  function renderScope() {
    picker.replaceChildren(h('option', { value: '' }, 'Add a dataset…'));
    const choices = [...datasets.values()].filter((dataset) => !selected.has(dataset.id));
    for (const [label, isPrivate] of [['Published', false], ['My datasets', true]]) {
      const group = choices.filter((dataset) => Boolean(dataset.isPrivate) === isPrivate);
      if (group.length) {
        picker.append(h('optgroup', { label }, group.map((dataset) =>
          h('option', { value: dataset.id }, datasetLabel(dataset)))));
      }
    }

    selectedList.replaceChildren(...[...selected].map((id) => {
      const dataset = datasets.get(id);
      return h('li', {}, datasetLabel(dataset), h('button', {
        class: 'link',
        type: 'button',
        'aria-label': `Remove ${datasetLabel(dataset)}`,
        onClick: () => {
          changeScope(id, false);
          picker.focus();
        },
      }, '×'));
    }));
    selectedList.hidden = selected.size === 0;
    byId('chat-default-scope').hidden = selected.size > 0;
    byId('chat-private-consent').hidden = !hasPrivateData();
    updateControls();
  }

  function changeScope(id, add) {
    if (sending || !datasets.has(id)) return;
    if (add) selected.add(id);
    else selected.delete(id);
    if (datasets.get(id).isPrivate) {
      privateConsent.checked = false;
      resetConversation();
    } else if (!messages.length) {
      showSuggestions();
    }
    renderScope();
  }

  function showSuggestions() {
    const suggestions = selected.size > 1
      ? ['What do these datasets have in common?', 'How can I compare these by county?']
      : selected.size
        ? ['What does this dataset cover?', 'Which indicators are available?']
        : ['What datasets are available?', 'Which towns have the highest household income?'];
    if (features.assistantReports) suggestions.push('Help me build a report');
    log.replaceChildren(h('div', { class: 'assistant-suggestions' }, suggestions.map((question) =>
      h('button', { type: 'button', class: 'assistant-suggestion', onClick: () => {
        input.value = question;
        if (hasPrivateData() && !privateConsent.checked) privateConsent.focus();
        else send();
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
          context: { page: 'chat', datasetIds: [...selected], includePrivate: privateConsent.checked },
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

  picker.addEventListener('change', () => changeScope(Number(picker.value), true));
  privateConsent.addEventListener('change', () => {
    if (!privateConsent.checked) resetConversation();
    updateControls();
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
  renderScope();
  showSuggestions();
  startOver.hidden = false;
  chat.hidden = false;
}

function datasetLabel(dataset) {
  return `${dataset.displayName || dataset.name} · ${dataset.vintage}`;
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
