/**
 * Tiny DOM builder. Text is always inserted as text nodes, never as HTML, so
 * values from the API cannot inject markup.
 *
 *   h('a', { href: '/x', class: 'button' }, 'Label')
 *   h('input', { type: 'checkbox', checked: true, onChange: handler })
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  el.append(...children.flat().filter((child) => child != null && child !== false).map((child) => (child instanceof Node ? child : String(child))));
  return el;
}
