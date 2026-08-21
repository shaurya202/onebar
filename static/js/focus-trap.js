// Modal focus management.
//
// Every dialog in the app was shown by removing a `hidden` class and nothing else:
// keyboard focus stayed on the page behind, Tab walked straight out of the dialog into
// the map, Escape did nothing, and closing a dialog left focus on `<body>` so the next
// Tab restarted from the top of the document. For someone using a switch device or a
// screen reader that makes the SOS dialog unusable — which is the one dialog that has
// to work under stress.
//
// This module owns show/hide for dialogs so the behaviour cannot drift apart again.

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(', ');

// A stack, because a dialog may open another one (contacts from within SOS).
const stack = [];

function focusableWithin(root) {
  // Visibility in this app is driven by the `.hidden` class and the `hidden`
  // attribute, not by layout — and `offsetParent` is unreliable inside a
  // `position: fixed` dialog and unavailable outside a rendering browser at all.
  return Array.from(root.querySelectorAll(FOCUSABLE))
    .filter((el) => !el.hasAttribute('hidden') && !el.closest('.hidden'));
}

function onKeydown(event) {
  const top = stack[stack.length - 1];
  if (!top) return;

  if (event.key === 'Escape') {
    if (top.dismissible === false) return;
    event.preventDefault();
    closeModal(top.element);
    return;
  }

  if (event.key !== 'Tab') return;

  const items = focusableWithin(top.element);
  if (!items.length) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !top.element.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !top.element.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Show a dialog and trap keyboard focus inside it.
 *
 * @param {HTMLElement} element        the `.modal-backdrop` container
 * @param {object}      options
 * @param {HTMLElement} options.initialFocus  element to focus first
 * @param {boolean}     options.dismissible   false for gates the user must answer
 * @param {Function}    options.onClose       called after the dialog is hidden
 */
export function openModal(element, { initialFocus = null, dismissible = true, onClose = null } = {}) {
  if (!element || stack.some((entry) => entry.element === element)) return;

  const entry = {
    element,
    dismissible,
    onClose,
    previouslyFocused: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  };
  stack.push(entry);

  element.classList.remove('hidden');
  element.setAttribute('aria-modal', 'true');
  element.setAttribute('role', 'dialog');
  document.body.classList.add('modal-open');

  if (stack.length === 1) {
    document.addEventListener('keydown', onKeydown, true);
  }

  const target = initialFocus || focusableWithin(element)[0] || element;
  // A frame's delay: the element is not laid out until the class change paints, and
  // `focus()` on a zero-size element is a no-op.
  requestAnimationFrame(() => {
    if (!(target instanceof HTMLElement)) return;
    if (!target.hasAttribute('tabindex') && target === element) target.setAttribute('tabindex', '-1');
    target.focus();
  });
}

export function closeModal(element) {
  const index = stack.findIndex((entry) => entry.element === element);
  if (index === -1) {
    element?.classList.add('hidden');
    return;
  }
  const [entry] = stack.splice(index, 1);

  element.classList.add('hidden');
  element.removeAttribute('aria-modal');

  if (!stack.length) {
    document.removeEventListener('keydown', onKeydown, true);
    document.body.classList.remove('modal-open');
  }

  // Return focus where the user left it, so the page does not silently reset to the
  // top of the document every time a dialog closes.
  entry.previouslyFocused?.focus?.();
  entry.onClose?.();
}

export function isModalOpen(element) {
  return stack.some((entry) => entry.element === element);
}

/** Close every open dialog — used when an emergency action takes over the screen. */
export function closeAllModals() {
  while (stack.length) closeModal(stack[stack.length - 1].element);
}
