import { api, loadSession } from './api.js';
import { savePendingProposal } from './chat-proposal.js';
import { h } from './dom.js';
import { boot, renderHeader, showStatus } from './layout.js';

const MAX_HISTORY = 29;
const byId = (id) => document.getElementById(id);

async function initializeChat() {
  const { user, features } = await loadSession({ allowGuest: true });
  renderHeader(user);
  if (!features.assistant) {
    showStatus(byId('page-status'), 'AI chat is unavailable. An administrator can enable it in AI settings.');
    return;
  }

  const chat = byId('chat');
  const heading = byId('chat-title');
  const historyPanel = byId('chat-history');
  const scroller = byId('chat-scroll');
  const latestButton = byId('chat-latest');
  const suggestionsPanel = byId('chat-suggestions');
  const privateConsent = byId('chat-include-private');
  privateConsent.checked = false;
  const startOver = byId('new-chat');
  const log = byId('chat-log');
  const input = byId('chat-message');
  const sendButton = byId('chat-send');
  const status = byId('chat-status');
  const linkedId = Number(new URLSearchParams(location.search).get('dataset'));
  const datasetId = Number.isSafeInteger(linkedId) && linkedId > 0 ? linkedId : undefined;
  const privateDatasets = user ? await api('/datasets?scope=private') : [];
  byId('chat-private-consent').hidden = !privateDatasets.some((dataset) => dataset.isActive);
  const linkedPrivateDataset = privateDatasets.some((dataset) => dataset.id === datasetId);
  const messages = [];
  let sending = false;

  function updateControls() {
    startOver.disabled = sending;
    privateConsent.disabled = sending;
    sendButton.disabled = sending;
    input.readOnly = sending;
  }

  function showSuggestions() {
    const hasDatasetContext = datasetId && (!linkedPrivateDataset || privateConsent.checked);
    const suggestions = hasDatasetContext
      ? [['About this dataset', 'What does this dataset cover?'], ['Explore indicators', 'Which indicators are available?']]
      : [['Find datasets', 'What data is available?'], ['Compare towns', 'Compare Hartford and New Haven by population.']];
    if (features.assistantReports) suggestions.push(['Build a report', 'Help me build a report.']);
    suggestionsPanel.replaceChildren(...suggestions.map(([label, question]) =>
      h('button', { type: 'button', class: 'assistant-suggestion', onClick: () => {
        input.value = question;
        input.focus();
      } }, label)));
  }

  function setConversation(open) {
    document.body.classList.toggle('has-conversation', open);
    heading.textContent = open ? 'AI chat' : 'Ask about Connecticut data';
    startOver.hidden = !open;
    historyPanel.hidden = !open;
    suggestionsPanel.hidden = open;
    latestButton.hidden = true;
  }

  function atLatest() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }

  function updateLatestButton() {
    latestButton.hidden = historyPanel.hidden || atLatest();
  }

  function scrollToLatest() {
    scroller.scrollTop = scroller.scrollHeight;
    updateLatestButton();
  }

  function resetConversation() {
    messages.length = 0;
    log.replaceChildren();
    setConversation(false);
    showStatus(status, '');
    showSuggestions();
    updateControls();
  }

  function proposalButton(proposal) {
    return h('button', {
      type: 'button',
      class: 'assistant-apply',
      onClick: () => {
        try {
          savePendingProposal(user?.id ?? null, proposal);
          location.assign(`/builder?dataset=${proposal.datasetId}&proposal=1`);
        } catch {
          showStatus(status, 'Enable browser session storage to open the report.', 'error');
        }
      },
    }, 'Open in report builder');
  }

  async function send() {
    const question = input.value.trim();
    if (!question || sendButton.disabled) return;
    const prompt = { role: 'user', content: question };
    const bubble = h('div', { class: 'assistant-message is-user' }, question);
    const pending = h('div', { class: 'assistant-message is-pending' }, 'Looking up data…');
    input.value = '';
    sending = true;
    if (historyPanel.hidden) setConversation(true);
    log.append(bubble, pending);
    updateControls();
    showStatus(status, '');
    scrollToLatest();
    try {
      const history = messages.slice(-MAX_HISTORY);
      if (history[0]?.role === 'assistant') history.shift();
      const { reply, proposal, citations = [] } = await api('/assistant', {
        method: 'POST',
        json: {
          messages: [...history, prompt],
          context: { page: 'chat', datasetId, includePrivate: privateConsent.checked },
        },
      });
      messages.push(prompt, { role: 'assistant', content: reply.slice(0, 4000) });
      const follow = atLatest();
      const answer = h('div', { class: 'assistant-message' },
        renderRichText(reply), renderCitations(citations), proposal && proposalButton(proposal));
      pending.replaceWith(answer);
      if (follow) scrollToLatest();
      else updateLatestButton();
    } catch (error) {
      pending.remove();
      bubble.remove();
      if (!messages.length) setConversation(false);
      else updateLatestButton();
      input.value = question;
      showStatus(status, error.message, 'error');
    } finally {
      sending = false;
      updateControls();
      if (document.activeElement === document.body || document.activeElement === sendButton) input.focus({ preventScroll: true });
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
  scroller.addEventListener('scroll', updateLatestButton, { passive: true });
  new ResizeObserver(updateLatestButton).observe(scroller);
  latestButton.addEventListener('click', () => {
    scrollToLatest();
    scroller.focus({ preventScroll: true });
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
  chat.hidden = false;
}

function renderCitations(citations) {
  if (!citations.length) return null;
  return h('section', { class: 'chat-citations', 'aria-label': 'Sources' },
    h('h2', {}, 'Sources'),
    h('ul', {}, citations.map(renderCitation)));
}

function renderCitation(citation) {
  const datasetUrl = `/dataset?id=${encodeURIComponent(citation.datasetId)}`;
  const linkOptions = { target: '_blank', rel: 'noopener noreferrer' };
  const sourceUrl = externalSourceUrl(citation.sourceUrl);
  const source = sourceUrl
    ? h('a', { href: sourceUrl, ...linkOptions }, citation.source)
    : citation.source;
  const edition = [citation.vintage, citation.version != null && `Version ${citation.version}`].filter(Boolean).join(' · ');
  return h('li', {},
    h('a', { href: datasetUrl, ...linkOptions }, citation.name),
    h('div', { class: 'muted' }, source, source && edition ? ' · ' : null, edition),
    citationDetail('Rows', citation.locations, citation.locationCount),
    citationDetail('Fields', citation.fields, citation.fieldCount));
}

function citationDetail(label, values, count) {
  if (!values?.length) return null;
  const remaining = (count ?? values.length) - values.length;
  return h('div', { class: 'muted' },
    `${label} · ${values.join(', ')}`, remaining > 0 ? ` and ${remaining} more` : null);
}

function externalSourceUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {
    return null;
  }
  return null;
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
