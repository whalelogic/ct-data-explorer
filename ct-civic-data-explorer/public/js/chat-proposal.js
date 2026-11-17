const PROPOSAL_KEY = 'ctde-chat-proposal';

export function savePendingProposal(userId, proposal) {
  sessionStorage.setItem(PROPOSAL_KEY, JSON.stringify({ userId, proposal }));
}

export function takePendingProposal(userId) {
  try {
    const stored = sessionStorage.getItem(PROPOSAL_KEY);
    clearPendingProposal();
    const pending = stored && JSON.parse(stored);
    return pending?.userId === userId ? pending.proposal : null;
  } catch {
    return null;
  }
}

export function clearPendingProposal() {
  try {
    sessionStorage.removeItem(PROPOSAL_KEY);
  } catch {
    // Storage can be unavailable in a restricted browser.
  }
}
