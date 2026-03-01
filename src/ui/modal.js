/**
 * Custom in-page modal dialog to replace native confirm() / prompt().
 *
 * Supports:
 *   - Confirmation dialogs (OK / Cancel)
 *   - Destructive confirmations (styled with danger)
 *   - Future expansion: custom buttons, inputs, etc.
 *
 * Usage:
 *   const ok = await showConfirm('Discard changes?');
 *   const ok = await showConfirm('Delete this game?', { danger: true });
 */

/** @type {HTMLDivElement|null} */
let overlayEl = null;

/** Lazily create the modal DOM skeleton and append to <body>. */
function ensureOverlay() {
  if (overlayEl) return overlayEl;

  overlayEl = document.createElement('div');
  overlayEl.className = 'modal-overlay confirm-overlay hidden';
  overlayEl.innerHTML = `
    <div class="modal-card confirm-card">
      <h3 class="confirm-title"></h3>
      <p class="confirm-message"></p>
      <div class="confirm-actions"></div>
      <div class="confirm-cancel-row"></div>
    </div>`;
  document.body.appendChild(overlayEl);
  return overlayEl;
}

/**
 * Show a confirmation dialog and return a Promise that resolves to true/false.
 *
 * @param {string} message - The question / warning text.
 * @param {Object} [opts]
 * @param {string} [opts.title]        - Optional heading (default: 'Confirm').
 * @param {string} [opts.okLabel]      - Label for the confirm button (default: 'OK').
 * @param {string} [opts.cancelLabel]  - Label for the cancel button (default: 'Cancel').
 * @param {boolean} [opts.danger]      - Use danger styling for the confirm button.
 * @param {Array<{label:string, value:*, className?:string}>} [opts.buttons]
 *        - Custom button list. If provided, okLabel/cancelLabel/danger are ignored.
 *          Each button resolves the promise with its `value`.
 *          The last button in the array receives focus by default.
 * @returns {Promise<boolean|*>}  Resolves to true/false for simple confirms,
 *          or the button `value` / null (backdrop/Escape) for custom buttons.
 */
export function showConfirm(message, opts = {}) {
  const {
    title = 'Confirm',
    okLabel = 'OK',
    cancelLabel = 'Cancel',
    danger = false,
    buttons = null,
  } = opts;

  const overlay = ensureOverlay();
  const card = overlay.querySelector('.confirm-card');
  const titleEl = overlay.querySelector('.confirm-title');
  const msgEl = overlay.querySelector('.confirm-message');
  const actionsEl = overlay.querySelector('.confirm-actions');

  titleEl.textContent = title;
  msgEl.textContent = message;

  // Build buttons
  actionsEl.innerHTML = '';
  const cancelRowEl = card.querySelector('.confirm-cancel-row');
  cancelRowEl.innerHTML = '';
  cancelRowEl.style.display = 'none';
  const btnEls = [];
  let defaultBtn = null;

  if (buttons) {
    // Custom button set
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = b.className || 'btn btn-secondary';
      btn.textContent = b.label;
      btn.dataset.value = JSON.stringify(b.value);
      // Buttons marked cancelRow go into the separate row below
      if (b.cancelRow) {
        cancelRowEl.appendChild(btn);
        cancelRowEl.style.display = '';
      } else {
        actionsEl.appendChild(btn);
      }
      if (b.default) defaultBtn = btn;
      btnEls.push({ el: btn, value: b.value });
    }
  } else {
    // Standard OK / Cancel — OK first (primary action)
    const okBtn = document.createElement('button');
    okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    okBtn.textContent = okLabel;
    actionsEl.appendChild(okBtn);
    btnEls.push({ el: okBtn, value: true });
    defaultBtn = okBtn;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = cancelLabel;
    actionsEl.appendChild(cancelBtn);
    btnEls.push({ el: cancelBtn, value: false });
  }

  // Show
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    overlay.classList.add('visible');
    card.classList.add('visible');
  });
  // Focus default button (first/primary action)
  (defaultBtn || btnEls[0]?.el)?.focus();

  return new Promise((resolve) => {
    function close(result) {
      overlay.classList.remove('visible');
      card.classList.remove('visible');
      setTimeout(() => {
        overlay.classList.add('hidden');
      }, 200);
      cleanup();
      resolve(result);
    }

    // Dismiss value: false for standard confirm, null for custom buttons
    const dismissValue = buttons ? null : false;

    function onKey(e) {
      if (e.key === 'Escape') close(dismissValue);
      // Enter confirms the default button (primary action)
      if (e.key === 'Enter') close(defaultBtn ? btnEls.find(b => b.el === defaultBtn)?.value ?? dismissValue : dismissValue);
    }
    function onBackdrop(e) {
      if (e.target === overlay) close(dismissValue);
    }

    const clickHandlers = btnEls.map(({ el, value }) => {
      const handler = () => close(value);
      el.addEventListener('click', handler);
      return { el, handler };
    });

    function cleanup() {
      for (const { el, handler } of clickHandlers) {
        el.removeEventListener('click', handler);
      }
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    }

    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}
