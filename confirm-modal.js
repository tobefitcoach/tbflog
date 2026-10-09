// ==========================================================================
// CUSTOM CONFIRM / ALERT
// Replaces the browser's native confirm()/alert() popups - those come
// branded with the page's own address in the title ("tbflog.github.io
// says...") and are styled by the OS, not the app, which looks out of
// place next to every other popup here. These reuse the same
// .modal-overlay/.modal/.form-actions/.btn-cancel/.btn-save classes as
// every other modal in the app, so they look the same as everything else.
//
// Imported where needed (import { customConfirm, customAlert } from
// '.../confirm-modal.js'). The popup itself is created the first time this
// file loads, so a page doesn't need a script tag for it.
// ==========================================================================
const overlay = document.createElement('div')
overlay.className = 'modal-overlay'
overlay.innerHTML = `
  <div class="modal" style="max-width:420px">
    <p id="customConfirmMessage" style="color:#ffffff; font-size:15px; line-height:1.5; margin:0; white-space:pre-line"></p>
    <div class="form-actions">
      <button type="button" class="btn-cancel" id="customConfirmCancelBtn" data-modal-dismiss>Cancel</button>
      <button type="button" class="btn-save" id="customConfirmOkBtn">OK</button>
    </div>
  </div>
`
document.documentElement.appendChild(overlay)

const messageEl = overlay.querySelector('#customConfirmMessage')
const cancelBtn = overlay.querySelector('#customConfirmCancelBtn')
const okBtn = overlay.querySelector('#customConfirmOkBtn')

// One popup at a time. A second customConfirm/customAlert while one is
// showing waits its turn instead of replacing it - replacing it used to
// leave the first one's await hanging forever (e.g. a "Delete?" whose
// button then stayed on "Deleting..."). Each request: { message,
// showCancel, resolve }.
const queue = []
let current = null

function showNext() {
  if (current || queue.length === 0) return
  current = queue.shift()
  messageEl.textContent = current.message
  cancelBtn.style.display = current.showCancel ? '' : 'none'
  overlay.classList.add('active')
}

function close(result) {
  if (!current) return
  const { resolve } = current
  current = null
  overlay.classList.remove('active')
  resolve(result)
  showNext()
}

cancelBtn.addEventListener('click', function() { close(false) })
okBtn.addEventListener('click', function() { close(true) })
overlay.addEventListener('click', function(e) { if (e.target === overlay) close(false) })
document.addEventListener('keydown', function(e) {
  if (!overlay.classList.contains('active')) return
  if (e.key === 'Escape') { e.preventDefault(); close(false) }
  if (e.key === 'Enter') {
    // The Enter that was typed into a text box and opened this popup is
    // still on its way up to here - it must not also answer it
    if (e.target.closest('input, textarea, select') && !overlay.contains(e.target)) return
    // Enter answers for whichever button has focus - Cancel when Cancel is
    // focused (it used to count as OK), OK otherwise. preventDefault stops
    // the browser's own Enter-click on the focused button, which would
    // otherwise answer the NEXT queued popup too.
    e.preventDefault()
    close(document.activeElement !== cancelBtn)
  }
})

function open(message, showCancel) {
  return new Promise(function(resolve) {
    queue.push({ message, showCancel, resolve })
    showNext()
  })
}

// Confirm: Cancel + OK, resolves true/false - use with await, same as the
// native confirm() it replaces
export function customConfirm(message) {
  return open(message, true)
}

// Alert: OK only. Every existing alert() call site fires right before a
// `return` with nothing depending on it blocking, so this is fire-and-forget
// (no await needed) - callers can keep calling it exactly like alert(...)
export function customAlert(message) {
  return open(message, false)
}
