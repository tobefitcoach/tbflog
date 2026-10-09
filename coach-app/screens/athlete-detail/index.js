// ==========================================================================
// ATHLETE DETAIL - screen
// The drill-down reached by tapping an athlete card on the Athletes screen
// (go('athlete-detail', { id })): four tabs - Overview / Metrics / Calendar
// / Settings - plus the PDF progress report. This file opens and closes the
// screen, switches tabs, loads the athlete row and runs the Settings tab;
// everything else lives next to it:
//
//   template.js        the skeleton + full screen markup
//   state.js           everything the screen remembers, grouped per tab
//   overview.js        Overview tab
//   metrics.js         Metrics tab
//   metrics-modals.js  Metrics tab popups (graph, entries, PRs, ...)
//   calendar/          Calendar tab: grid, day popup, "+" popup and its
//                      Program/Section/Form tabs, copy/move, static wiring
//   report.js          PDF progress report
//   toast.js           the bottom-of-screen confirmation message
//
// Conventions every file follows:
//   - every await is followed by nav.isCurrent(mountToken) (or the token
//     passed down) before the DOM is touched again
//   - Metrics and Calendar load their data the first time their tab is
//     opened (met.metricsLoaded / cal.calendarLoaded) - Chart.js sizes its
//     canvases from their rendered size, so drawing into a hidden panel
//     gives blank charts
//   - Chart.js and jsPDF are fetched on first use (await loadChartJs() /
//     loadJsPdf(), see vendor.js), not on every visit
//   - the Overview refresh guard (ov.overviewLoadInFlight) stops overlapping
//     refreshes - the exact bug that once caused a statement timeout
// ==========================================================================
import { supabase } from '../../../coachClient.js?v=__V__'
import * as nav from '../../nav.js?v=__V__'
import { ensureCss } from '../../lazy-css.js?v=__V__'
import { flushBuilderOverlay, teardownBuilderOverlay } from '../../builder-overlay.js?v=__V__'
import { escapeHtml, safeUrl } from '../../../escape.js?v=__V__'
import { root, mountToken, athleteId, currentAthlete, setScreen, setCurrentAthlete, resetState, ui, ov, met, cal } from './state.js?v=__V__'
import { disarmCopy, wireCalendarCopyArming } from './calendar/copy.js?v=__V__'
import { loadCalendarMonth, wireCalendarBadgeKebabs, wireCalendarDragToMove } from './calendar/grid.js?v=__V__'
import { bindCalendarStaticEvents } from './calendar/wiring.js?v=__V__'
import { bindGraphModalEvents } from './metrics-modals.js?v=__V__'
import { bindMetricsStaticEvents, loadAllMetrics, loadAthleteMetrics } from './metrics.js?v=__V__'
import { bindBodyweightEvents, bindChangeExplainEvents, bindNotesEvents, bindOverviewEvents, loadBodyweightGraph, loadLatestNote, loadOverviewStats, loadOverviewStatsGuarded, loadRecentActivity } from './overview.js?v=__V__'
import { bindReportEvents } from './report.js?v=__V__'
import { SKELETON, TEMPLATE } from './template.js?v=__V__'
import { customAlert } from '../../../confirm-modal.js?v=__V__'
import { fetchWithRetry } from '../../../network-retry.js?v=__V__'

// ==========================================================================
// ---- MOUNT / UNMOUNT ----
// ==========================================================================
// Still on the token-based checks (nav.isCurrent(mountToken)) rather than
// ctx.alive() - the background loads in every tab file read mountToken from
// state.js. Its document listeners already go through ctx.on.
export async function mount(container, params, ctx) {
  const token = ctx.token
  ensureCss('css/athlete-detail.css?v=__V__')
  setScreen({ root: container, mountToken: token, athleteId: params.id })
  container.innerHTML = SKELETON
  root.querySelector('#athleteDetailBackBtn').addEventListener('click', function() { nav.back() })

  const now = new Date()
  cal.currentViewYear = now.getFullYear()
  cal.currentViewMonth = now.getMonth()

  const ok = await loadAthlete(token)
  if (!nav.isCurrent(token)) return
  if (!ok) return

  container.innerHTML = TEMPLATE
  // TEMPLATE's own back button is a fresh DOM node - the listener attached
  // to SKELETON's button above didn't carry over, it was destroyed along
  // with the rest of SKELETON's markup by the innerHTML replacement above.
  // Without this, "← Back" would be silently dead on every athlete screen
  // that finished loading (the skeleton and the error-state screen further
  // below both wire their own copy of this button already).
  root.querySelector('#athleteDetailBackBtn').addEventListener('click', function() { nav.back() })
  bindEvents()
  bindTabs()
  paintAthleteHeader()

  // Overview tab is visible by default, so its data loads right away.
  // Metrics/Calendar tabs load lazily when first clicked - see bindTabs().
  loadLatestNote()
  loadBodyweightGraph()
  loadOverviewStats()
  loadRecentActivity()

  ctx.on(document, 'visibilitychange', function() {
    if (document.visibilityState !== 'visible' || !athleteId) return
    if (Date.now() - ov.lastOverviewAutoRefresh < 15000) return
    ov.lastOverviewAutoRefresh = Date.now()
    loadOverviewStatsGuarded()
  })

  // Calendar tab's outside-click (closes its kebab dropdowns) and
  // Escape-to-disarm-copy - both document-level in the old athlete-calendar.js,
  // registered unconditionally there too (the elements they look for don't
  // exist until the Calendar tab has been opened at least once, so these
  // are harmless no-ops until then, exactly like on the original page).
  ctx.on(document, 'click', function(e) {
    if (e.target.closest('.kebab-menu')) return
    root?.querySelectorAll('#calendarGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
  })

  // Escape disarms an in-progress calendar copy
  ctx.on(document, 'keydown', function(e) {
    if (e.key === 'Escape' && cal.copyArmedMode) disarmCopy()
  })
}

// Leaving with the Workout Builder overlay still open: let it send any
// edit still waiting on its autosave before the router tears this down.
export async function beforeLeave() {
  await flushBuilderOverlay(root?.querySelector('#trainingBuilderHost'))
}

export function unmount() {
  teardownBuilderOverlay(root?.querySelector('#trainingBuilderHost'))
  clearTimeout(ui.toastHideTimer)
  ui.toastHideTimer = null

  if (ov.bodyweightChart) { ov.bodyweightChart.destroy(); ov.bodyweightChart = null }
  if (ov.volumeChart) { ov.volumeChart.destroy(); ov.volumeChart = null }
  if (met.fullChart) { met.fullChart.destroy(); met.fullChart = null }
  met.miniChartInstances.forEach(function(c) { c.destroy() })
  met.miniChartInstances = []

  // Every remembered value back to its starting point, so nothing from
  // this athlete leaks into the next visit - see state.js
  resetState()
}

// ==========================================================================
// ---- EVENT WIRING ----
// Everything the two original files registered at module top-level (against
// markup that was already in the document) or inside loadAthlete()/
// loadCalendarMonth() closures. Called once per mount, after TEMPLATE is in.
// Grouped into the same sections the originals used - see each section's
// own banner further down for the render/data logic these buttons call into.
// ==========================================================================
function bindEvents() {
  bindOverviewEvents()
  bindSettingsEvents()
  bindStatusInviteEvents()
  bindNotesEvents()
  bindMetricsStaticEvents()
  bindGraphModalEvents()
  bindReportEvents()
  bindChangeExplainEvents()
  bindEditAthleteEvents()
  bindBodyweightEvents()
  bindCalendarStaticEvents()
}

// ==========================================================================
// ---- TABS ----
// Switches which .tab-panel is visible. Metrics/Calendar data loads lazily,
// the first time that tab is clicked, not on mount - Chart.js sizes its
// canvases from their rendered pixel dimensions, so drawing graphs while a
// panel is still display:none would produce blank/squashed charts.
// ==========================================================================
function bindTabs() {
  root.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      root.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      root.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
      btn.classList.add('active')
      root.querySelector('#tab-' + btn.dataset.tab).classList.add('active')

      if (btn.dataset.tab === 'metrics' && !met.metricsLoaded) {
        met.metricsLoaded = true
        const token = mountToken
        loadAllMetrics().then(function() {
          if (!nav.isCurrent(token)) return
          return loadAthleteMetrics()
        })
      }

      if (btn.dataset.tab === 'calendar') {
        activateCalendarTab()
      }
    })
  })
}

// Was a CustomEvent round trip (window.dispatchEvent/addEventListener)
// between the two original files, since they had no shared scope to call
// into each other with directly. Now that they're one module this is just a
// plain function call from bindTabs() above - simpler, and removes what
// would otherwise be a `window`-level listener living for the life of the
// app (a real SPA leak candidate, worse than the document-level ones this
// screen already has to track, since window listeners are even easier to
// forget).
function activateCalendarTab() {
  if (cal.calendarLoaded) return
  cal.calendarLoaded = true
  const token = mountToken
  loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
  // #calendarGrid itself is a persistent node (only its innerHTML gets
  // replaced on every month change) - delegated listeners are wired here,
  // once, rather than inside renderCalendarGrid (which reruns on every
  // month load and would otherwise stack a new set of listeners each time)
  wireCalendarDragToMove(root.querySelector('#calendarGrid'))
  wireCalendarCopyArming(root.querySelector('#calendarGrid'))
  wireCalendarBadgeKebabs(root.querySelector('#calendarGrid'))
}

// ==========================================================================
// ---- SETTINGS TAB ----
// Per-athlete settings save immediately on change, no separate Save button -
// this screen is meant to be filled in once during onboarding and left alone.
// ==========================================================================
function bindSettingsEvents() {
  function bindToggle(id, field) {
    root.querySelector('#' + id).addEventListener('change', async function(e) {
      const { error } = await supabase
        .from('athletes')
        .update({ [field]: e.target.checked })
        .eq('id', athleteId)

      if (error) {
        console.log(error)
        customAlert('Something went wrong saving that setting')
        e.target.checked = !e.target.checked // revert the toggle visually
      }
    })
  }

  bindToggle('settingsNextWeekToggle', 'can_preview_next_week')
  bindToggle('settingsSelfLogToggle', 'can_self_log_workouts')
  bindToggle('settingsMobilityToggle', 'mobility_enabled')
  bindToggle('settingsTournamentsToggle', 'tournaments_enabled')
  bindToggle('settingsAddExercisesToggle', 'can_add_exercises')
  bindToggle('settingsChangeExercisesToggle', 'can_change_exercises')
  bindToggle('settingsRescheduleToggle', 'can_reschedule_workouts')
  bindToggle('settingsWeeklyStatsToggle', 'can_view_weekly_stats')
}

// ==========================================================================
// ---- STATUS + INVITE ACTIONS ----
// active = linked to a real login, pending = coach has entered an email but
// the athlete hasn't signed up/linked yet, offline = no email on file yet,
// archived = coach hid them (overrides the other 3 regardless of link state).
// Mirrors athleteStatus()/sendInviteEmail()/buildInviteLink() in
// screens/athletes.js - same shape, duplicated per this codebase's per-file
// convention (each screen module has no shared scope with another).
// ==========================================================================
function athleteStatus(athlete) {
  if (athlete.archived) return 'archived'
  if (athlete.user_id) return 'active'
  if (athlete.email) return 'pending'
  return 'offline'
}

const STATUS_LABELS = { active: 'Active', pending: 'Pending', offline: 'Offline', archived: 'Archived' }

function updateStatusUI(data) {
  const status = athleteStatus(data)
  const badge = root.querySelector('#profileStatusBadge')
  badge.textContent = STATUS_LABELS[status]
  badge.className = `athlete-status-badge status-${status}`

  root.querySelector('#editAthleteInviteActions').style.display = status === 'pending' ? 'flex' : 'none'
}

// athleteAppUrl exists because the app now lives at
// coach-app/dashboard.html instead of at the repo root - 'athlete-app/x'
// resolved against window.location.href would point at
// coach-app/athlete-app/x, which doesn't exist. Resolution happens against
// the loaded DOCUMENT's location, not this module's own file path - it
// makes no difference that this particular module lives one directory
// deeper (coach-app/screens/) than dashboard.html itself, since
// window.location.href is always coach-app/dashboard.html regardless of
// which screen module is running. One '../' reaches the repo root from
// there. Same fix, same reasoning, as screens/athletes.js's own invite flow.
function athleteAppUrl(page) {
  return new URL(`../athlete-app/${page}`, window.location.href).href
}

async function sendInviteEmail(email, name) {
  const redirectTo = athleteAppUrl('dashboard.html')
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: redirectTo, data: { role: 'athlete', name, needs_password: true } }
  })
  return error
}

function buildInviteLink(email, name) {
  const url = new URL('../athlete-app/index.html', window.location.href)
  if (email) url.searchParams.set('email', email)
  if (name) url.searchParams.set('name', name)
  return url.href
}

function bindStatusInviteEvents() {
  root.querySelector('#resendInviteBtn').addEventListener('click', async function() {
    if (!currentAthlete || !currentAthlete.email) return
    const error = await sendInviteEmail(currentAthlete.email, currentAthlete.name)
    customAlert(error ? 'Something went wrong sending the invite' : `Invite sent to ${currentAthlete.email}`)
  })

  root.querySelector('#copyInviteLinkBtn').addEventListener('click', async function() {
    if (!currentAthlete) return
    await navigator.clipboard.writeText(buildInviteLink(currentAthlete.email, currentAthlete.name))
    customAlert('Invite link copied - paste it anywhere you like.')
  })
}

// ==========================================================================
// ---- LOAD ATHLETE INFO ----
// Fetches the athlete's profile row. Split into a fetch-only loadAthlete()
// (called before TEMPLATE exists, same split screens/athletes.js uses for
// loadAthletes()/reloadAndRepaint()) and paintAthleteHeader(), which fills
// in the header/settings toggles once the real markup is in the DOM.
// ==========================================================================
async function loadAthlete(token) {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('athletes')
    .select('*')
    .eq('id', athleteId)
    .single()
    .abortSignal(signal)
  )

  if (!nav.isCurrent(token)) return false

  if (error) {
    console.log('Error loading athlete:', error)
    if (root) {
      root.innerHTML = `
        <div class="screen-header">
          <button class="btn-back" id="athleteDetailBackBtn" aria-label="Back"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg></button>
          <h2 class="screen-title">Athlete</h2>
        </div>
        <div class="screen-message">
          <h2>Couldn't load this athlete</h2>
          <p>Check your connection and try again.</p>
        </div>`
      root.querySelector('#athleteDetailBackBtn').addEventListener('click', function() { nav.back() })
    }
    return false
  }

  setCurrentAthlete(data)
  return true
}

// Fills in the profile header (name, initials, age, height, status badge),
// the browser tab title, and the Settings tab's toggles - everything
// loadAthlete() used to do inline once TEMPLATE existed on the page already.
function paintAthleteHeader() {
  const data = currentAthlete

  // Calculate age from date of birth
  const dob = new Date(data.date_of_birth)
  const age = Math.floor((new Date() - dob) / (365.25 * 24 * 60 * 60 * 1000))

  // Fill in profile header
  const initials = data.name.split(' ').map(w => w[0]).join('').toUpperCase()
  root.querySelector('#profileInitials').innerHTML = safeUrl(data.avatar_url)
    ? `<img src="${safeUrl(data.avatar_url)}" class="avatar-img" alt="">`
    : escapeHtml(initials)
  root.querySelector('#profileName').textContent = data.name
  root.querySelector('#profileDetails').textContent =
    `${data.gender} · ${age} years old · ${data.height}cm`
  updateStatusUI(data)

  document.title = `${data.name} — Tobe-Fit`
  root.querySelector('#athleteDetailScreenTitle').textContent = data.name

  // Settings tab - populated here (not lazily) since it's just these
  // fields already loaded above, no chart-canvas-sizing concern like Metrics
  root.querySelector('#settingsNextWeekToggle').checked = !!data.can_preview_next_week
  root.querySelector('#settingsSelfLogToggle').checked = !!data.can_self_log_workouts
  root.querySelector('#settingsMobilityToggle').checked = !!data.mobility_enabled
  root.querySelector('#settingsTournamentsToggle').checked = !!data.tournaments_enabled
  root.querySelector('#settingsAddExercisesToggle').checked = !!data.can_add_exercises
  root.querySelector('#settingsChangeExercisesToggle').checked = !!data.can_change_exercises
  root.querySelector('#settingsRescheduleToggle').checked = !!data.can_reschedule_workouts
  root.querySelector('#settingsWeeklyStatsToggle').checked = !!data.can_view_weekly_stats
}

// ==========================================================================
// ---- EDIT ATHLETE INFO ----
// Saves changes made in the "edit athlete" modal (name, DOB, gender, height,
// email). Weight is not edited here - see the Bodyweight feature for that.
// Email is what links this athlete row to their own login once they sign up
// in the athlete app (see claim_athlete_by_email in sql-history.sql).
// ==========================================================================
function bindEditAthleteEvents() {
  root.querySelector('#closeEditAthleteBtn').addEventListener('click', function() {
    root.querySelector('#editAthleteModal').classList.remove('active')
  })

  root.querySelector('#cancelEditAthleteBtn').addEventListener('click', function() {
    root.querySelector('#editAthleteModal').classList.remove('active')
  })

  root.querySelector('#saveEditAthleteBtn').addEventListener('click', async function() {
    const name = root.querySelector('#editAthleteName').value.trim()
    // Empty -> null, not '' - a blank string sent to a `date` column errors
    // outright, and an empty gender fails its check constraint, so clearing
    // either field back out (not just leaving it blank on first save) would
    // fail too. Height goes through the same treatment since parseInt('') is NaN.
    const dobRaw = root.querySelector('#editAthleteDOB').value
    const dob = dobRaw || null
    const genderRaw = root.querySelector('#editAthleteGender').value
    const gender = genderRaw || null
    const heightRaw = parseInt(root.querySelector('#editAthleteHeight').value)
    const height = Number.isNaN(heightRaw) ? null : heightRaw
    // Empty -> null, not '' - the email column has a "no duplicates" rule in
    // the database, and two blank emails would otherwise count as duplicates
    const email = root.querySelector('#editAthleteEmail').value.trim() || null

    if (!name) { customAlert('Please enter a name'); return }

    const previousEmail = currentAthlete ? currentAthlete.email : null

    const { error } = await supabase
      .from('athletes')
      .update({ name, date_of_birth: dob, gender, height, email })
      .eq('id', athleteId)

    if (error) {
      console.log(error)
      if (error.code === '23505') {
        customAlert('Another athlete is already using that email')
      } else {
        customAlert('Something went wrong')
      }
      return
    }

    root.querySelector('#editAthleteModal').classList.remove('active')

    // Only a newly-added or changed email should trigger a fresh invite -
    // resaving unrelated fields shouldn't re-send one every time
    if (email && email !== previousEmail) {
      const inviteError = await sendInviteEmail(email, name)
      if (inviteError) {
        console.log('Error sending invite:', inviteError)
        customAlert('Athlete saved, but the invite email failed to send. Use "Resend Invite" or "Copy Invite Link" to try again.')
      }
    }

    // loadAthlete()/paintAthleteHeader() are split here (unlike the original
    // single-page site) so the profile header/title/Settings toggles still
    // repaint after this save, same as they do on first mount - see mount()
    const token = mountToken
    const ok = await loadAthlete(token)
    if (!nav.isCurrent(token)) return
    if (ok) paintAthleteHeader()
  })
}
