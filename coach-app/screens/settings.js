// ==========================================================================
// SETTINGS — screen
// Converted from the repo-root settings.js + the .dashboard block of
// settings.html. Coach-level preferences: push notifications, the
// low-trainings warning threshold, the global mobility toggle, and log out.
//
// The original ran as a sequence of top-level awaits against markup that
// was already in the document. Here all three reads (push status, profile
// flags) are issued TOGETHER with Promise.all rather than one after another
// - the original's sequential awaits meant three round trips stacked back
// to back before the screen settled, which on a phone is exactly the kind
// of waterfall this rewrite exists to remove.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import { supabase as athleteSupabase } from '../../athlete-app/athleteClient.js'
import { pushStatus, enablePush, disablePush } from '../../push.js'
import * as nav from '../nav.js'
import { coachId } from '../session.js'

const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Settings</h2>
  </div>

  <h3 class="detail-group-title" style="margin-top:0">Notifications</h3>
  <div class="settings-row">
    <div class="settings-row-info">
      <div class="settings-row-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="settings-row-icon"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>Push Notifications</div>
      <div class="settings-row-desc" id="pushStatusDesc">Checking...</div>
    </div>
    <button type="button" class="btn-profile-action" id="pushToggleBtn" disabled>...</button>
  </div>
  <div class="settings-row">
    <div class="settings-row-info">
      <div class="settings-row-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="settings-row-icon"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86l-8.18 14.18A2 2 0 0 0 4 21h16a2 2 0 0 0 1.89-2.96L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>Low Trainings Warning</div>
      <div class="settings-row-desc">Flag an athlete on the Athletes list once their last scheduled training is this many days away (or they have none at all)</div>
    </div>
    <div class="settings-row-control">
      <input type="number" id="lowTrainingsWarningInput" min="0" max="60" class="settings-number-input" />
      <span class="settings-row-unit">days</span>
    </div>
  </div>

  <h3 class="detail-group-title" style="margin-top:32px">Athlete App</h3>
  <div class="settings-row">
    <div class="settings-row-info">
      <div class="settings-row-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="settings-row-icon"><circle cx="12" cy="4" r="2"></circle><path d="M12 6v6"></path><path d="M8 8l4 2 4-2"></path><path d="M9 20l3-6 3 6"></path></svg>Mobility / Stretching</div>
      <div class="settings-row-desc" id="mobilityStatusDesc">Loading...</div>
    </div>
    <button type="button" class="btn-profile-action" id="mobilityToggleBtn" disabled>...</button>
  </div>

  <h3 class="detail-group-title" style="margin-top:32px">Account</h3>
  <div class="settings-row">
    <div class="settings-row-info">
      <div class="settings-row-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="settings-row-icon"><circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4 4-6 8-6s8 2 8 6"></path></svg>Athlete Account</div>
      <div class="settings-row-desc" id="athleteAccountDesc">Checking...</div>
    </div>
    <button type="button" class="btn-profile-action" id="athleteAccountBtn" disabled>...</button>
  </div>
  <div class="settings-row">
    <div class="settings-row-info">
      <div class="settings-row-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="settings-row-icon"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>Log Out</div>
      <div class="settings-row-desc">Sign out of this device</div>
    </div>
    <button type="button" class="btn-profile-action" id="logoutBtn">Log Out</button>
  </div>
`

let root = null
let currentStatus = null
let mobilityEnabled = true
let athleteAccountLinked = false

function pushStatusDesc(status) {
  if (status === 'on') return 'On - get notified even when the app is closed'
  if (status === 'denied') return 'Blocked in your browser settings - re-enable notifications for this site to turn this on'
  if (status === 'unsupported') return "This browser doesn't support push notifications"
  return 'Get notified (e.g. an athlete completes a workout) even when this tab is closed'
}

function mobilityStatusDesc(enabled) {
  return enabled
    ? 'Athletes see the Daily Mobility/Stretching tile on their home screen'
    : "Hidden from athletes - turn this on once you've added stretches to the library"
}

function paintPushRow(status) {
  currentStatus = status
  root.querySelector('#pushStatusDesc').textContent = pushStatusDesc(status)
  const btn = root.querySelector('#pushToggleBtn')
  btn.textContent = status === 'on' ? 'Disable' : 'Enable'
  btn.disabled = status === 'unsupported'
}

function paintMobilityRow() {
  root.querySelector('#mobilityStatusDesc').textContent = mobilityStatusDesc(mobilityEnabled)
  const btn = root.querySelector('#mobilityToggleBtn')
  btn.textContent = mobilityEnabled ? 'Disable' : 'Enable'
  btn.disabled = false
}

// A coach who also trains under their own account can link it here so the
// two stay one tap apart instead of needing a second sign-in every time -
// see athlete-app/dashboard.js's Profile tab for the matching link back.
// coachClient.js and athleteClient.js use separate localStorage keys by
// design (see either file's header), so both sessions genuinely coexist in
// this browser/app - this is just a shortcut between two sessions that
// already exist, never a second credential check.
function paintAthleteAccountRow() {
  root.querySelector('#athleteAccountDesc').textContent = athleteAccountLinked
    ? 'Linked - jump to your own training log any time'
    : "Also train yourself? Link your athlete account to switch between them in one tap"
  const btn = root.querySelector('#athleteAccountBtn')
  btn.textContent = athleteAccountLinked ? 'Switch to Athlete View' : '+ Add Athlete Account'
  btn.disabled = false
}

export async function mount(container, params, token) {
  root = container
  container.innerHTML = TEMPLATE
  bindEvents()

  // All four reads at once. The original awaited them in sequence.
  const [status, profile, athleteSession] = await Promise.all([
    pushStatus(),
    window.fetchWithRetry((signal) => supabase
      .from('profiles')
      .select('mobility_enabled, low_trainings_warning_days')
      .eq('id', coachId())
      .single()
      .abortSignal(signal)
    ),
    athleteSupabase.auth.getSession(),
  ])
  if (!nav.isCurrent(token)) return

  paintPushRow(status)

  const row = profile?.data
  mobilityEnabled = row ? row.mobility_enabled !== false : true
  paintMobilityRow()
  root.querySelector('#lowTrainingsWarningInput').value = row ? (row.low_trainings_warning_days ?? 7) : 7

  athleteAccountLinked = !!athleteSession?.data?.session
  paintAthleteAccountRow()
}

export function unmount() {
  root = null
  currentStatus = null
}

function bindEvents() {
  root.querySelector('#logoutBtn').addEventListener('click', async function() {
    await supabase.auth.signOut()
    // Forget which role this browser/device was routed as last time, so the
    // app root (app/index.js) asks again instead of silently sending the
    // next visit straight back to the coach side - see that file's header
    // comment for the cache this clears.
    localStorage.removeItem('tbflog-known-role')
    window.location.href = '../../app/index.html'
  })

  root.querySelector('#athleteAccountBtn').addEventListener('click', function() {
    // Linked: athleteClient's session is already sitting there, so this is
    // a same-tick jump, not a login. Not linked: the athlete login form,
    // same as any other first-time athlete sign-in - signing in there only
    // ever touches athleteClient's session, this coach session is untouched.
    window.location.href = athleteAccountLinked ? '../athlete-app/dashboard.html' : '../athlete-app/index.html'
  })

  root.querySelector('#pushToggleBtn').addEventListener('click', async function(e) {
    e.target.disabled = true
    if (currentStatus === 'on') await disablePush(supabase)
    else await enablePush(supabase, coachId())
    paintPushRow(await pushStatus())
  })

  root.querySelector('#mobilityToggleBtn').addEventListener('click', async function(e) {
    e.target.disabled = true
    const newValue = !mobilityEnabled
    const { error } = await supabase.from('profiles').update({ mobility_enabled: newValue }).eq('id', coachId())
    if (error) {
      console.log(error)
      customAlert('Something went wrong saving that setting')
      e.target.disabled = false
      return
    }
    mobilityEnabled = newValue
    paintMobilityRow()
  })

  // How many days before an athlete's last scheduled training the Athletes
  // screen flags them with the red "!" and sorts them to the top - see
  // isLowOnTrainings() there.
  const warningInput = root.querySelector('#lowTrainingsWarningInput')
  warningInput.addEventListener('change', async function() {
    const days = Math.max(0, Math.min(60, parseInt(warningInput.value) || 0))
    warningInput.value = days
    const { error } = await supabase.from('profiles').update({ low_trainings_warning_days: days }).eq('id', coachId())
    if (error) { console.log(error); customAlert('Something went wrong saving that setting') }
  })
}
