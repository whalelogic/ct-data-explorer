/** Indicator definitions are shared by uploads; this form can live inside a dataset overview. */
import { api } from './api.js';
import { h } from './dom.js';
import { showStatus } from './layout.js';

export function mountIndicatorEditor(container, prefix, onCreated = async () => {}) {
  const field = (name, label, attributes = {}) => h('div', {},
    h('label', { for: `${prefix}-${name}` }, label),
    h('input', { id: `${prefix}-${name}`, name, ...attributes }));
  const unit = h('select', { id: `${prefix}-unit`, name: 'unit' },
    ...['count', 'currency', 'percent', 'density', 'area'].map((value) => h('option', { value }, value)));
  const derivation = h('select', { id: `${prefix}-derivation`, name: 'derivation' },
    h('option', { value: 'direct' }, 'Uploaded column'), h('option', { value: 'ratio' }, 'Computed ratio'));
  const numerator = field('numeratorKey', 'Numerator column');
  const denominator = field('denominatorKey', 'Denominator column');
  const updateRatioFields = () => {
    const ratio = derivation.value === 'ratio';
    numerator.hidden = denominator.hidden = !ratio;
    numerator.querySelector('input').required = ratio;
    denominator.querySelector('input').required = ratio;
  };
  derivation.addEventListener('change', updateRatioFields);
  updateRatioFields();
  const button = h('button', { type: 'submit' }, 'Add Indicator');
  const status = h('p', { class: 'status', role: 'status', hidden: true });
  const form = h('form', { class: 'grid-form' },
    field('key', 'Column key', { required: true, maxlength: 60, pattern: '[A-Za-z0-9_]+' }),
    field('label', 'Display label', { required: true, maxlength: 120 }),
    h('div', {}, h('label', { for: unit.id }, 'Unit'), unit),
    field('decimals', 'Decimal places', { type: 'number', min: 0, max: 4, value: 0, required: true }),
    h('div', {}, h('label', { for: derivation.id }, 'Value'), derivation),
    numerator, denominator, h('div', { class: 'button-row' }, button));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      const created = await api('/indicators', { method: 'POST', json: {
        ...values, decimals: Number(values.decimals),
        numeratorKey: values.numeratorKey || undefined,
        denominatorKey: values.denominatorKey || undefined,
      } });
      form.reset();
      form.elements.decimals.value = '0';
      updateRatioFields();
      showStatus(status, `Added ${created.label}. Uploaded columns appear when a dataset includes their values; ratios appear when both inputs are available.`, 'ok');
      await onCreated();
    } catch (err) {
      showStatus(status, err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  container.replaceChildren(form, status);
}
