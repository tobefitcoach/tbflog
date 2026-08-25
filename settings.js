// ==========================================================================
// SETTINGS (coach-level preferences)
// Currently just one row - push notifications - moved here out of the
// bell's dropdown panel (see bell.js) since that felt buried inside a
// click-to-open popup rather than a real settings page. Mirrors the exact
// same enable/disable logic as the athlete-app's own equivalent row in
// renderSettings() (athlete-app/dashboard.js).
// ==========================================================================
import { supabase } from './coachClient.js'
import { pushStatus, enablePush, disablePush } from './push.js'

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
}

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'login.html'
})

function pushStatusDesc(status) {
  if (status === 'on') return 'On - get notified even when the app is closed'
  if (status === 'denied') return 'Blocked in your browser settings - re-enable notifications for this site to turn this on'
  if (status === 'unsupported') return "This browser doesn't support push notifications"
  return 'Get notified (e.g. an athlete completes a workout) even when this tab is closed'
}

async function refreshPushRow() {
  const status = await pushStatus()
  document.getElementById('pushStatusDesc').textContent = pushStatusDesc(status)
  const btn = document.getElementById('pushToggleBtn')
  btn.textContent = status === 'on' ? 'Disable' : 'Enable'
  btn.disabled = status === 'unsupported'
  return status
}

let currentStatus = await refreshPushRow()

document.getElementById('pushToggleBtn').addEventListener('click', async function(e) {
  e.target.disabled = true
  if (currentStatus === 'on') await disablePush(supabase)
  else await enablePush(supabase, session.user.id)
  currentStatus = await refreshPushRow()
})
