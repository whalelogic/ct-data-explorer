/**
 * Confirmation and single-field dialogs, built on <dialog>. They replace the browser's
 * confirm() and prompt(): the buttons say what they do, the styling matches the app,
 * Escape cancels, and focus returns to the control that opened the dialog.
 */
import { h as createElement } from './dom.js';

let dialogCount = 0;

/**
 * @param {{ title: string, message?: string, confirmLabel: string, cancelLabel?: string, danger?: boolean }} options
 * @returns {Promise<boolean>} true when the person confirms
 */
export function confirmDialog({ title, message, confirmLabel, cancelLabel = 'Cancel', danger = false }) {
  return openDialog({ title, message, confirmLabel, cancelLabel, danger }).then((result) => result !== null);
}

/**
 * Ask for one line of text.
 * @param {{ title: string, label: string, value?: string, maxLength?: number, confirmLabel: string, cancelLabel?: string }} options
 * @returns {Promise<string | null>} the trimmed text, or null when cancelled or left empty
 */
export function promptDialog({ title, label, value = '', maxLength = 200, confirmLabel, cancelLabel = 'Cancel' }) {
  return openDialog({ title, confirmLabel, cancelLabel, field: { label, value, maxLength } });
}

function openDialog({ title, message, confirmLabel, cancelLabel, danger, field }) {
  const opener = document.activeElement;
  const id = `app-dialog-${++dialogCount}`;
  const heading = createElement('h2', { id: `${id}-title` }, title);
  const form = createElement('form', { method: 'dialog', novalidate: true }, heading);

  if (message) {
    form.append(createElement('p', { id: `${id}-message` }, message));
  }
  let input = null;
  if (field) {
    input = createElement('input', { id: `${id}-input`, type: 'text', maxlength: field.maxLength, value: field.value, autocomplete: 'off' });
    form.append(createElement('label', { for: input.id }, field.label), input);
  }

  const cancelButton = createElement('button', { type: 'button', class: 'secondary' }, cancelLabel);
  const confirmButton = createElement('button', { type: 'submit', class: danger ? 'danger' : null }, confirmLabel);
  form.append(createElement('div', { class: 'button-row' }, confirmButton, cancelButton));

  const dialog = createElement('dialog', {
    class: 'app-dialog',
    'aria-labelledby': heading.id,
    'aria-describedby': message ? `${id}-message` : null,
  }, form);
  document.body.append(dialog);

  return new Promise((resolve) => {
    let result = null;

    cancelButton.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input) {
        const text = input.value.trim();
        if (!text) {
          input.focus();
          return;
        }
        result = text;
      } else {
        result = true;
      }
      dialog.close();
    });
    // Clicking the dimmed page behind the dialog cancels, like Escape.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) {
        dialog.close();
      }
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      const focusTarget = openerTarget(opener);
      if (focusTarget) {
        focusTarget.focus();
      }
      resolve(result);
    });

    dialog.showModal();
    if (input) {
      input.focus();
      input.select();
    } else if (danger) {
      // A destructive action should never be one stray Enter away.
      cancelButton.focus();
    } else {
      confirmButton.focus();
    }
  });
}

function openerTarget(opener) {
  if (!(opener instanceof HTMLElement) || !opener.isConnected) {
    return null;
  }
  const menu = opener.closest('details');
  if (menu && !menu.open) {
    const summary = menu.querySelector(':scope > summary');
    if (summary instanceof HTMLElement) {
      return summary;
    }
  }
  return opener;
}
