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

// Global on/off for the "Daily Mobility/Stretching" tile athletes see on
// their home screen - turn off while you haven't filmed any stretch videos
// yet, so athletes don't land on an empty flow.
function mobilityStatusDesc(enabled) {
  return enabled
    ? 'Athletes see the Daily Mobility/Stretching tile on their home screen'
    : "Hidden from athletes - turn this on once you've added stretches to the library"
}

const { data: profileData } = await supabase.from('profiles').select('mobility_enabled').eq('id', session.user.id).single()
let mobilityEnabled = profileData ? profileData.mobility_enabled !== false : true
document.getElementById('mobilityStatusDesc').textContent = mobilityStatusDesc(mobilityEnabled)
const mobilityBtn = document.getElementById('mobilityToggleBtn')
mobilityBtn.textContent = mobilityEnabled ? 'Disable' : 'Enable'
mobilityBtn.disabled = false

mobilityBtn.addEventListener('click', async function(e) {
  e.target.disabled = true
  const newValue = !mobilityEnabled
  const { error } = await supabase.from('profiles').update({ mobility_enabled: newValue }).eq('id', session.user.id)
  if (error) {
    console.log(error)
    customAlert('Something went wrong saving that setting')
  } else {
    mobilityEnabled = newValue
    document.getElementById('mobilityStatusDesc').textContent = mobilityStatusDesc(mobilityEnabled)
    mobilityBtn.textContent = mobilityEnabled ? 'Disable' : 'Enable'
  }
  mobilityBtn.disabled = false
})

// How many days before an athlete's last scheduled training the Athletes
// list (script.js) flags them with the red "!" and sorts them to the top -
// see isLowOnTrainings() there.
const { data: warningData } = await supabase.from('profiles').select('low_trainings_warning_days').eq('id', session.user.id).single()
const warningInput = document.getElementById('lowTrainingsWarningInput')
warningInput.value = warningData ? (warningData.low_trainings_warning_days ?? 7) : 7

warningInput.addEventListener('change', async function() {
  const days = Math.max(0, Math.min(60, parseInt(warningInput.value) || 0))
  warningInput.value = days
  const { error } = await supabase.from('profiles').update({ low_trainings_warning_days: days }).eq('id', session.user.id)
  if (error) { console.log(error); customAlert('Something went wrong saving that setting') }
})
