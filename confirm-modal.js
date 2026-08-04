// ==========================================================================
// CUSTOM CONFIRM / ALERT
// Replaces the browser's native confirm()/alert() popups - those come
// branded with the page's own address in the title ("tbflog.github.io
// says...") and are styled by the OS, not the app, which looks out of
// place next to every other popup here. These reuse the same
// .modal-overlay/.modal/.form-actions/.btn-cancel/.btn-save classes as
// every other modal in the app, so they look the same as everything else.
//
// Exposed as window.customConfirm/window.customAlert (same pattern as
// loading-bar.js patching window.fetch) since each page's own script is a
// separate module with no shared import - this needs to be callable from
// all of them without one.
//
// Loaded right after loading-bar.js, before each page's own script.
// ==========================================================================
const overlay = document.createElement('div')
overlay.className = 'modal-overlay'
overlay.innerHTML = `
  <div class="modal" style="max-width:420px">
    <p id="customConfirmMessage" style="color:#ffffff; font-size:15px; line-height:1.5; margin:0; white-space:pre-line"></p>
    <div class="form-actions">
      <button type="button" class="btn-cancel" id="customConfirmCancelBtn">Cancel</button>
      <button type="button" class="btn-save" id="customConfirmOkBtn">OK</button>
    </div>
  </div>
`
document.documentElement.appendChild(overlay)

const messageEl = overlay.querySelector('#customConfirmMessage')
const cancelBtn = overlay.querySelector('#customConfirmCancelBtn')
const okBtn = overlay.querySelector('#customConfirmOkBtn')

let resolveCurrent = null

function close(result) {
  overlay.classList.remove('active')
  const resolve = resolveCurrent
  resolveCurrent = null
  if (resolve) resolve(result)
}

cancelBtn.addEventListener('click', function() { close(false) })
okBtn.addEventListener('click', function() { close(true) })
overlay.addEventListener('click', function(e) { if (e.target === overlay) close(false) })
document.addEventListener('keydown', function(e) {
  if (!overlay.classList.contains('active')) return
  if (e.key === 'Escape') close(false)
  if (e.key === 'Enter') close(true)
})

function open(message, showCancel) {
  messageEl.textContent = message
  cancelBtn.style.display = showCancel ? '' : 'none'
  overlay.classList.add('active')
  return new Promise(function(resolve) { resolveCurrent = resolve })
}

// Confirm: Cancel + OK, resolves true/false - use with await, same as the
// native confirm() it replaces
window.customConfirm = function(message) {
  return open(message, true)
}

// Alert: OK only. Every existing alert() call site fires right before a
// `return` with nothing depending on it blocking, so this is fire-and-forget
// (no await needed) - callers can keep calling it exactly like alert(...)
window.customAlert = function(message) {
  return open(message, false)
}
