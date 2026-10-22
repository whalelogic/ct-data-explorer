/**
 * Accessible tabs (WAI-ARIA tabs pattern) whose state lives in the URL hash, so links,
 * reloads and the Back button all land on the same tab.
 *
 * Markup: a [role="tablist"] of buttons with [role="tab"][data-tab="name"][aria-controls="panel-id"].
 */

/**
 * @param {HTMLElement} tabList
 * @param {{ fallback: string, onChange?: (name: string) => void }} options
 * @returns {{ select: (name: string, options?: { focus?: boolean }) => void }}
 */
export function mountTabs(tabList, { fallback, onChange }) {
  const tabs = () => [...tabList.querySelectorAll('[role="tab"]')].filter((tab) => !tab.hidden);

  function select(name, { focus = false, updateHash = true } = {}) {
    const target = tabs().find((tab) => tab.dataset.tab === name) ?? tabs().find((tab) => tab.dataset.tab === fallback);
    if (!target) {
      return;
    }
    for (const tab of tabList.querySelectorAll('[role="tab"]')) {
      const isSelected = tab === target;
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !isSelected;
    }
    if (focus) {
      target.focus();
    }
    if (updateHash && location.hash !== `#${target.dataset.tab}`) {
      history.replaceState(null, '', `#${target.dataset.tab}`);
    }
    onChange?.(target.dataset.tab);
  }

  tabList.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) {
      select(tab.dataset.tab);
    }
  });
  tabList.addEventListener('keydown', (event) => {
    const visible = tabs();
    const index = visible.indexOf(document.activeElement);
    if (index === -1) {
      return;
    }
    const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: visible.length - 1 };
    if (!(event.key in moves)) {
      return;
    }
    event.preventDefault();
    const next = visible[(moves[event.key] + visible.length) % visible.length];
    select(next.dataset.tab, { focus: true });
  });
  window.addEventListener('hashchange', () => select(location.hash.slice(1), { updateHash: false }));

  select(location.hash.slice(1), { updateHash: false });
  return { select };
}
