/** Shared keyboard navigation and focus recovery for task-based workspaces. */
const controllers = new WeakMap();

export function initializeTabs(scope = document) {
  const roots = [...scope.querySelectorAll('[data-tabs]')];
  if (scope.matches?.('[data-tabs]')) roots.unshift(scope);
  for (const root of roots) {
    const existing = controllers.get(root);
    if (existing) {
      existing.refresh();
      continue;
    }
    mountTabs(root);
  }
}

function mountTabs(root) {
  const tabs = [...root.querySelectorAll('[role="tab"]')].filter((tab) => tab.closest('[data-tabs]') === root);
  if (!tabs.length) return;
  const panels = new Map();
  for (const tab of tabs) {
    const panel = [...root.querySelectorAll('[role="tabpanel"]')].find((candidate) => candidate.id === tab.getAttribute('aria-controls'));
    if (panel && root.contains(panel)) panels.set(tab, panel);
  }
  if (!panels.size) return;
  const available = () => tabs.filter((tab) => panels.has(tab) && !tab.hidden && !tab.disabled);
  const activate = (tab, focus = false) => {
    if (!available().includes(tab)) return false;
    const focusWillHide = tabs.some((candidate) => candidate !== tab
      && panels.get(candidate)?.contains(root.ownerDocument.activeElement));
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      const panel = panels.get(candidate);
      if (panel) panel.hidden = !selected;
    }
    root.dataset.activeTab = panels.get(tab).id;
    if (focus || focusWillHide) {
      tab.focus({ preventScroll: true });
      tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    root.dispatchEvent(new CustomEvent('tabs:change', {
      bubbles: true, detail: { panelId: panels.get(tab).id },
    }));
    // Chart canvases may have been measured while their panel was hidden.
    globalThis.requestAnimationFrame?.(() => globalThis.dispatchEvent(new Event('resize')));
    return true;
  };
  const refresh = () => activate(available().find((tab) => tab.getAttribute('aria-selected') === 'true') ?? available()[0]);
  const controller = { activate, panels, refresh };
  controllers.set(root, controller);
  for (const tab of tabs) {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (event) => {
      const choices = available();
      const currentIndex = choices.indexOf(tab);
      let nextIndex;
      if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % choices.length;
      else if (event.key === 'ArrowLeft') nextIndex = (currentIndex + choices.length - 1) % choices.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = choices.length - 1;
      else return;
      event.preventDefault();
      activate(choices[nextIndex], true);
    });
  }
  root.addEventListener('invalid', (event) => revealTab(event.target), true);
  refresh();
}

/** Reveal nested task panels before moving focus to a field or an error. */
export function revealTab(element) {
  if (!element) return;
  const panels = [];
  let panel = element.closest('[role="tabpanel"]');
  while (panel) {
    panels.unshift(panel);
    panel = panel.parentElement?.closest('[role="tabpanel"]');
  }
  for (const target of panels) {
    const root = target.closest('[data-tabs]');
    if (!root) continue;
    initializeTabs(root);
    const controller = controllers.get(root);
    const tab = [...(controller?.panels ?? [])].find(([, candidate]) => candidate === target)?.[0];
    if (tab) controller.activate(tab);
  }
}
