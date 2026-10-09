// ==========================================================================
// ATHLETE APP - Profile tab
// Push status text, the Profile screen (photo, units, weekly recap, push,
// tour replay, log out).
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import { supabase as coachSupabase } from '../../coachClient.js?v=__V__'
import { pushStatus, enablePush, disablePush } from '../../push.js?v=__V__'
import { alertPermission, askForAlerts, isNativeApp } from '../native-alerts.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { escapeHtml, safeUrl } from '../../escape.js?v=__V__'
import { startOfWeek } from '../../shared/dates.js?v=__V__'
import { pageContent, session, athlete } from '../state.js?v=__V__'
import { SET_HINT_KEY, runHomeTour } from '../home-tour.js?v=__V__'
import { saveWithRetry } from '../outbox.js?v=__V__'
import { resizeImageFile } from './chat.js?v=__V__'
import { renderWeekView } from './home.js?v=__V__'
import { customAlert, customConfirm } from '../../confirm-modal.js?v=__V__'

let coachName = null // fetched once, lazily, the first time the Profile tab is opened

// A place for per-athlete settings that live outside the coach-editable
// Settings tab (which is on the coach's own athlete page) - this one is
// self-service, for things the athlete should be able to change themselves.
const BELL_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px; margin-right:5px"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>'

function restAlertDesc(permission) {
  if (permission === 'granted') return "On - your phone tells you when a rest is over, even if you've switched apps"
  if (permission === 'denied') return "Off - turn on notifications for Tobe-Fit in your phone's Settings to get them"
  return "Get an alert when a rest is over, even if you've switched apps"
}

function pushStatusDesc(status) {
  if (status === 'on') return 'On - your coach can message you even when the app is closed'
  if (status === 'denied') return 'Blocked in your browser settings - re-enable notifications for this site to turn this on'
  if (status === 'unsupported') return "This browser doesn't support push notifications"
  return 'Get notified even when the app is closed'
}

// Athlete's own name + their coach's name, the settings that used to live
// on their own separate tab (photo, weight units, weekly recap, push
// notifications - merged in here since a 5th bottom-nav item just for
// these didn't earn its own tab), and Log Out. Coach's name isn't already
// loaded anywhere in this app (the athletes row only carries coach_id), so
// it's fetched lazily here, once, the first time this tab is opened.
export async function renderProfile() {
  const myToken = nav.enter('profile', {}, { root: true, tab: 'profile' })
  pageContent.innerHTML = `
    <div class="day-view-header">
      <h2 class="day-view-date">Profile</h2>
    </div>
    <p class="no-metrics">Loading...</p>
  `

  // pushStatus is local-only (no network); the coach-session check is a
  // localStorage read under coachClient.js's own key, not a login - see
  // coach-app/screens/settings.js's matching "Athlete Account" row for the
  // other direction of this same shortcut.
  // Inside the App Store / Play Store app the browser's push can't work, so
  // that row is replaced by on-device rest-timer alerts (see
  // native-alerts.js) - or left out, on an older app build without them
  const native = isNativeApp()
  const [status, coachAccountSession, alertStatus] = await Promise.all([
    native ? null : pushStatus(),
    coachSupabase.auth.getSession(),
    alertPermission(),
  ])
  const coachAccountLinked = !!coachAccountSession?.data?.session
  const initials = athlete.name.split(' ').map(w => w[0]).join('').toUpperCase()

  if (coachName === null) {
    const { data } = await saveWithRetry((signal) => supabase
      .from('profiles')
      .select('name')
      .eq('id', athlete.coach_id)
      .maybeSingle()
      .abortSignal(signal)
    )
    coachName = (data && data.name) || ''
  }

  // Unlike renderCommunication (guarded by #chatMessages existence),
  // nothing below checks whether Profile is still the visible screen -
  // without this, navigating away during either await above would still
  // land this render on top of whatever screen the athlete is actually on.
  if (!nav.isCurrent(myToken)) return

  pageContent.innerHTML = `
    <div class="day-view-header">
      <h2 class="day-view-date">Profile</h2>
    </div>
    <div class="settings-row">
      <div class="settings-row-info"><div class="settings-row-title">Name</div></div>
      <span>${escapeHtml(athlete.name)}</span>
    </div>
    ${coachName ? `
    <div class="settings-row">
      <div class="settings-row-info"><div class="settings-row-title">Coach</div></div>
      <span>${escapeHtml(coachName)}</span>
    </div>` : ''}
    <div class="settings-row">
      <div class="settings-row-info">
        <div class="settings-row-title">Profile Photo</div>
        <div class="settings-row-desc">Your coach sees this instead of your initials</div>
      </div>
      <div style="display:flex; align-items:center; gap:10px">
        ${safeUrl(athlete.avatar_url)
          ? `<img src="${safeUrl(athlete.avatar_url)}" class="settings-avatar-preview" alt="">`
          : `<div class="settings-avatar-placeholder">${initials}</div>`}
        <input type="file" id="avatarFileInput" accept="image/*" style="display:none" />
        <button type="button" class="btn-profile-action" id="avatarUploadBtn">Change</button>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-row-info">
        <div class="settings-row-title">Weight units</div>
      </div>
      <div class="unit-toggle-switch">
        <span class="${athlete.weight_unit !== 'lbs' ? 'active' : ''}">kg</span>
        <label class="toggle-switch">
          <input type="checkbox" id="weightUnitToggle" ${athlete.weight_unit === 'lbs' ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span class="${athlete.weight_unit === 'lbs' ? 'active' : ''}">lbs</span>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-row-info">
        <div class="settings-row-title">Weekly recap</div>
        <div class="settings-row-desc">Get a summary of what you completed each week</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="weeklyRecapToggle" ${athlete.weekly_recap_enabled ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    </div>
    ${!native ? `
    <div class="settings-row">
      <div class="settings-row-info">
        <div class="settings-row-title">${BELL_ICON}Push Notifications</div>
        <div class="settings-row-desc" id="pushStatusDesc">${pushStatusDesc(status)}</div>
      </div>
      <button type="button" class="btn-profile-action" id="pushToggleBtn">${status === 'on' ? 'Disable' : 'Enable'}</button>
    </div>` : alertStatus ? `
    <div class="settings-row">
      <div class="settings-row-info">
        <div class="settings-row-title">${BELL_ICON}Rest Timer Alerts</div>
        <div class="settings-row-desc">${restAlertDesc(alertStatus)}</div>
      </div>
      ${alertStatus === 'prompt' ? '<button type="button" class="btn-profile-action" id="restAlertsBtn">Turn On</button>' : ''}
    </div>` : ''}
    ${coachAccountLinked ? `
    <div class="settings-row">
      <div class="settings-row-info">
        <div class="settings-row-title">Coach Account</div>
        <div class="settings-row-desc">Linked - jump to your coaching dashboard any time</div>
      </div>
      <button type="button" class="btn-profile-action" id="coachAccountBtn">Switch to Coach View</button>
    </div>` : ''}
    <div class="settings-row">
      <div class="settings-row-info">
        <div class="settings-row-title">App tour</div>
        <div class="settings-row-desc">See where everything is again</div>
      </div>
      <button type="button" class="btn-profile-action" id="replayTourBtn">Replay</button>
    </div>
    <button type="button" class="btn-cancel" id="profileLogoutBtn" style="margin-top:24px">Log Out</button>

    <div class="profile-danger-zone">
      <div class="profile-danger-desc">Permanently deletes your account, training history, messages and photos. This can't be undone.</div>
      <button type="button" class="btn-delete-account" id="deleteAccountBtn">Delete Account</button>
    </div>
  `

  document.getElementById('avatarUploadBtn').addEventListener('click', function() {
    document.getElementById('avatarFileInput').click()
  })

  document.getElementById('avatarFileInput').addEventListener('change', async function(e) {
    const file = e.target.files[0]
    if (!file) return

    const btn = document.getElementById('avatarUploadBtn')
    btn.disabled = true
    btn.textContent = 'Uploading...'

    try {
      const resized = await resizeImageFile(file, 512)
      // Fixed filename per athlete (not a fresh uuid each time, unlike the
      // coach's stretch-video uploads) - upsert:true so a re-upload just
      // overwrites the same object instead of leaving old photos orphaned
      // in storage forever
      const path = `${session.user.id}/avatar.jpg`
      const { error: uploadError } = await supabase.storage.from('athlete-avatars').upload(path, resized, { contentType: 'image/jpeg', upsert: true })
      if (uploadError) throw uploadError

      // ?t= cache-busts the public URL itself (stored in the DB, not just a
      // page-local query string) so every place this shows - the coach's
      // athlete grid, profile header, communication list - picks up the new
      // photo immediately instead of serving a stale cached image forever
      const avatarUrl = `${supabase.storage.from('athlete-avatars').getPublicUrl(path).data.publicUrl}?t=${Date.now()}`

      const { error } = await saveWithRetry((signal) => supabase
        .from('athletes')
        .update({ avatar_url: avatarUrl })
        .eq('id', athlete.id)
        .abortSignal(signal)
      )
      if (error) throw error

      athlete.avatar_url = avatarUrl
      renderProfile()
    } catch (err) {
      console.log('Error uploading avatar:', err)
      customAlert('Something went wrong uploading your photo - check your connection and try again')
      btn.disabled = false
      btn.textContent = 'Change'
    }
  })

  // Turning ON needs a real user tap (browsers require a user gesture to
  // show the permission prompt, so this can't be a silent toggle like the
  // two above) - re-renders the whole screen after either action so the
  // button label/description reflect what actually happened
  document.getElementById('pushToggleBtn')?.addEventListener('click', async function(e) {
    e.target.disabled = true
    if (status === 'on') await disablePush(supabase)
    else await enablePush(supabase, session.user.id)
    renderProfile()
  })

  // The phone's own permission question - asked once; after that the
  // switch lives in the phone's Settings, which the row then points to
  document.getElementById('restAlertsBtn')?.addEventListener('click', async function(e) {
    e.target.disabled = true
    await askForAlerts()
    renderProfile()
  })

  document.getElementById('weightUnitToggle').addEventListener('change', async function(e) {
    const newUnit = e.target.checked ? 'lbs' : 'kg'
    const previousUnit = athlete.weight_unit
    athlete.weight_unit = newUnit // optimistic, same pattern used everywhere else in this file

    const labels = e.target.closest('.unit-toggle-switch').querySelectorAll('span')
    labels[0].classList.toggle('active', newUnit === 'kg')
    labels[1].classList.toggle('active', newUnit === 'lbs')

    const { error } = await saveWithRetry((signal) => supabase
      .from('athletes')
      .update({ weight_unit: newUnit })
      .eq('id', athlete.id)
      .abortSignal(signal)
    )

    if (error) {
      console.log(error)
      athlete.weight_unit = previousUnit
      e.target.checked = previousUnit === 'lbs'
      labels[0].classList.toggle('active', previousUnit === 'kg')
      labels[1].classList.toggle('active', previousUnit === 'lbs')
      customAlert('Something went wrong saving that - try again')
    }
  })

  document.getElementById('weeklyRecapToggle').addEventListener('change', async function(e) {
    const newValue = e.target.checked
    const previousValue = athlete.weekly_recap_enabled
    athlete.weekly_recap_enabled = newValue

    const { error } = await saveWithRetry((signal) => supabase
      .from('athletes')
      .update({ weekly_recap_enabled: newValue })
      .eq('id', athlete.id)
      .abortSignal(signal)
    )

    if (error) {
      console.log(error)
      athlete.weekly_recap_enabled = previousValue
      e.target.checked = previousValue
      customAlert('Something went wrong saving that - try again')
    }
  })

  document.getElementById('replayTourBtn').addEventListener('click', function() {
    try { localStorage.removeItem(SET_HINT_KEY) } catch (e) { /* storage blocked - the hint just won't replay */ }
    renderWeekView(startOfWeek(new Date()))
    runHomeTour()
  })

  document.getElementById('profileLogoutBtn').addEventListener('click', async function() {
    await supabase.auth.signOut()
    // See renderWrongRole's identical 2 lines above for why this clears the
    // cached role and goes to the chooser instead of straight back to the
    // athlete login.
    localStorage.removeItem('tbflog-known-role')
    window.location.href = '../app/index.html'
  })

  if (coachAccountLinked) {
    document.getElementById('coachAccountBtn').addEventListener('click', function() {
      window.location.href = '../coach-app/dashboard.html'
    })
  }

  document.getElementById('deleteAccountBtn').addEventListener('click', async function(e) {
    const ok = await customConfirm("Delete your account? This permanently erases your training history, messages and photos and can't be undone.")
    if (!ok) return

    e.target.disabled = true
    e.target.textContent = 'Deleting...'

    const { data, error } = await supabase.functions.invoke('delete-account')

    if (error || data?.error) {
      console.log('Error deleting account:', error || data.error)
      customAlert("Something went wrong deleting your account - check your connection and try again, or email tobefitcoach@gmail.com")
      e.target.disabled = false
      e.target.textContent = 'Delete Account'
      return
    }

    // Same role-cache clear as the other 2 sign-out sites above.
    await supabase.auth.signOut()
    localStorage.removeItem('tbflog-known-role')
    window.location.href = '../app/index.html'
  })
}
