// ==========================================================================
// ATHLETE DETAIL - toast
// The brief confirmation message at the bottom of the screen.
// ==========================================================================
import { root, ui } from './state.js?v=__V__'

// Brief bottom-center confirmation that fades itself out - for background
// actions (like sharing the report to chat) that have no other visible result on
// this page, so the coach isn't left guessing whether it worked. Populates
// ui.toastHideTimer from state.js (cleared in unmount()), not a new one.
export function showToast(message) {
  const el = root.querySelector('#pageToast')
  el.textContent = message
  el.classList.add('active')
  clearTimeout(ui.toastHideTimer)
  ui.toastHideTimer = setTimeout(() => el.classList.remove('active'), 3000)
}
