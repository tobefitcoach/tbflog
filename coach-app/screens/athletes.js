// ==========================================================================
// ATHLETES — screen
// Converted from the repo-root script.js + the .dashboard block of
// index.html and its three modals (Add Athlete, Manage Labels, Message
// Athletes). This is the app's root screen: one card per athlete, with the
// ACWR / Programmed Through / 30-Day Completion stats, pain-flag and
// low-on-trainings badges, status filtering, search and labels.
//
// The queries, the stat math and the card markup are unchanged; what
// changed is the shape around them:
//
//   - the session check at the top is gone (the bootstrap does it once),
//     and every session.user.id became coachId()
//   - the #loggedInAs line went with it - dashboard.js fills that in once
//     for the whole app, not once per screen
//   - the five module-level document.getElementById refs (addBtn, modal,
//     cancelBtn, saveBtn, athleteGrid) move inside mount(), because this
//     module is now imported before its markup exists
//   - the ONE document-level click listener script.js had (outside-click
//     closes the label filter dropdown) is registered in mount() and
//     REMOVED in unmount() - left attached it would accumulate one copy
//     per visit for the life of the app
//   - the status filter no longer comes from ?status= in the URL; the
//     sidebar submenu passes it in as params.status, same default of
//     'active' when it's absent
//   - window.location.href = 'athlete.html?id=X' becomes a route call
//   - every await in mount() is followed by an isCurrent(token) check
//     before the DOM is touched again, and the two background loads
//     (loadAthleteExtras/checkLowTrainings) check the mount's token too
//   - loadAthletes() used to both fetch AND repaint. Here it only fetches
//     (mount paints the template itself, and there's nothing to repaint
//     into until it has); reloadAndRepaint() is what the card actions call
//   - createAthleteCard returns the card instead of appending it itself,
//     so the grid is looked up once per render rather than once per card -
//     same split the other converted screens use
//
// See screens/_placeholder.js for the full contract.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import { sendPush } from '../../push.js'
import * as nav from '../nav.js'
import { go } from '../router.js'
import { coachId } from '../session.js'

const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Your Athletes</h2>
    <div class="header-actions-row">
      <button class="btn-profile-action" id="messageAthletesBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-inline-icon"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>Message Athletes</button>
      <button class="btn-add">+ Add Athlete</button>
    </div>
  </div>
  <input type="text" id="athleteSearchInput" class="exercise-search-input" placeholder="Search athletes by name..." />
  <div class="label-filter" id="labelFilter">
    <button type="button" class="btn-profile-action" id="labelFilterBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-inline-icon"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>Filter by Label</button>
    <div class="label-filter-dropdown" id="labelFilterDropdown">
      <div class="entries-modal-body" id="labelFilterList"></div>
      <div class="label-filter-new">
        <input type="text" id="newLabelInput" placeholder="New label name..." maxlength="40" />
        <button type="button" id="addLabelBtn">+ Add</button>
      </div>
    </div>
  </div>
  <div class="athlete-grid"></div>

  <!-- Add Athlete Modal: form for creating a new athlete (hidden by
       default, shown via the "active" class). All three modals live inside
       the screen rather than the shell, so they are torn down with it. -->
  <div class="modal-overlay" id="addAthleteModal">
    <div class="modal">
      <h2>Add Athlete</h2>

      <div class="form-group">
        <label>Full Name</label>
        <input type="text" id="athleteName" placeholder="e.g. John Doe" />
      </div>

      <div class="form-group">
        <label>Date of Birth</label>
        <input type="date" id="athleteDOB" />
      </div>

      <div class="form-group">
        <label>Gender</label>
        <select id="athleteGender">
          <option value="">Select gender</option>
          <option value="Male">Male</option>
          <option value="Female">Female</option>
          <option value="Other">Other</option>
        </select>
      </div>

      <div class="form-group">
        <label>Height (cm)</label>
        <input type="number" id="athleteHeight" placeholder="e.g. 180" />
      </div>

      <div class="form-group">
        <label>Email (for athlete login)</label>
        <input type="email" id="athleteEmail" placeholder="athlete@email.com" />
      </div>

      <div class="form-actions">
        <button class="btn-cancel" id="cancelBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveBtn">Save Athlete</button>
      </div>
    </div>
  </div>

  <!-- Manage Labels Modal: tag/untag one athlete with any of the coach's
       labels - opened from that athlete's kebab menu. Checking a box saves
       immediately (same optimistic pattern as Archive), no separate Save
       button needed. -->
  <div class="modal-overlay" id="manageLabelsModal">
    <div class="modal">
      <h2>Manage Labels</h2>
      <p class="modal-subtitle" id="manageLabelsAthleteName"></p>
      <div class="entries-modal-body" id="manageLabelsList"></div>
      <div class="label-filter-new">
        <input type="text" id="manageLabelsNewInput" placeholder="New label name..." maxlength="40" />
        <button type="button" id="manageLabelsAddBtn">+ Add</button>
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="closeManageLabelsBtn" data-modal-dismiss>Close</button>
      </div>
    </div>
  </div>

  <!-- Message Athletes Modal: compose + send, to all athletes or specific
       ones, shown either the next time they open the app, right before
       they start their next workout, or immediately as a real push
       notification - see the sendMessageAthletesBtn handler below. -->
  <div class="modal-overlay" id="messageAthletesModal">
    <div class="modal">
      <div class="graph-modal-header">
        <h2>Message Athletes</h2>
        <button type="button" class="btn-cancel" id="closeMessageAthletesBtn">✕</button>
      </div>
      <div class="form-group">
        <label>Message</label>
        <textarea id="coachMessageText" class="notes-textarea" placeholder="e.g. Reminder: no training tomorrow, enjoy the rest day!"></textarea>
      </div>
      <div class="form-group">
        <label>When should they see it?</label>
        <div class="chip-row" id="messageTimingChips">
          <button type="button" class="chip-btn selected" data-timing="on_open">When they open the app</button>
          <button type="button" class="chip-btn" data-timing="before_workout">Right before they start a workout</button>
          <button type="button" class="chip-btn" data-timing="push">Push notification, right now</button>
        </div>
      </div>
      <div class="form-group">
        <label>Send to</label>
        <label class="bodyweight-toggle" style="margin-bottom:10px"><span>All athletes</span>
          <span class="toggle-switch"><input type="checkbox" id="messageToAllToggle" checked><span class="toggle-slider"></span></span>
        </label>
        <div id="messageRecipientList" class="entries-modal-body" style="display:none"></div>
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelMessageAthletesBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="sendMessageAthletesBtn">Send</button>
      </div>
    </div>
  </div>
`

// Shown before the athletes query has even started - a blank grid for
// however long the fetch takes reads as broken, not loading. This is the
// old renderAthleteGridSkeleton(), now a const painted into the container
// itself rather than into a grid that doesn't exist yet.
const SKELETON = `
  <div class="dashboard-header"><h2>Your Athletes</h2></div>
  <div class="athlete-grid">
    ${Array.from({ length: 6 }, () => `
      <div class="athlete-card-skeleton">
        <div class="skeleton-row">
          <div class="skeleton-bar skeleton-avatar"></div>
          <div class="skeleton-bar" style="width:90px; height:14px"></div>
        </div>
        <div class="skeleton-bar" style="width:70%; height:11px"></div>
        <div class="skeleton-bar" style="width:50%; height:11px"></div>
        <div class="skeleton-bar" style="width:60%; height:11px"></div>
      </div>
    `).join('')}
  </div>
`

let root = null
// The mount's nav token, kept module-level so the two background loads
// (loadAthleteExtras and the label flows that follow it) can check it after
// their own awaits - they're started fire-and-forget from mount and can
// easily outlive it on a slow connection.
let mountToken = null

// Cached full list + the filter currently applied to it, so switching
// status (or typing a search) re-renders instantly from memory instead of
// re-querying
let allAthletes = []
let flaggedCountByAthlete = {}
let athleteStatsById = {} // athlete_id -> { acwr, acwrBuilding, furthestDate, completionRate30 } - see loadAthleteCardStats()
let lowTrainingsWarningDays = 7 // coach's own "warn me N days before an athlete's last training" setting (Settings screen), refreshed in loadAthleteExtras
// Status used to come from ?status= in the URL; the sidebar submenu now
// passes it into mount() as params.status instead, same default of 'active'
let currentStatusFilter = 'active'
let currentSearchQuery = ''

// Coach-created labels (e.g. "Monthly Plan") + which athletes have which -
// see the "Filter by Label" dropdown and each card's "Manage Labels" kebab item
let allLabels = []
let labelLinksByAthlete = {} // athlete_id -> Set of label_id
let selectedLabelFilterIds = new Set()
let manageLabelsAthleteId = null

let onDocClickFilter = null

export async function mount(container, params, token) {
  root = container
  mountToken = token
  currentStatusFilter = params.status || 'active'
  container.innerHTML = SKELETON

  if (!(await loadAthletes(token))) return

  container.innerHTML = TEMPLATE
  bindEvents()
  updateFilterCounts()
  applyFilters()

  // Pain-flag badges + card stats (ACWR/Programmed Through/Completion) are
  // enhancements, not required to see the athlete list - fetched
  // separately so a failure here (e.g. a query erroring because a pending
  // migration hasn't been run yet) can never block the list above from
  // rendering. This used to be bundled into the same Promise.all as the
  // athletes query, with the default 3 retries each - a single broken
  // "nice to have" query could make the whole page look empty for up to a
  // minute while it retried a request that was never going to succeed.
  loadAthleteExtras()
}

export function unmount() {
  // script.js could leave this attached because the whole document went
  // away on every navigation. Here it must be removed by hand, or every
  // visit to this screen adds another live listener.
  if (onDocClickFilter) document.removeEventListener('click', onDocClickFilter)
  onDocClickFilter = null
  root = null
  mountToken = null
  allAthletes = []
  flaggedCountByAthlete = {}
  athleteStatsById = {}
  lowTrainingsWarningDays = 7
  currentSearchQuery = ''
  allLabels = []
  labelLinksByAthlete = {}
  selectedLabelFilterIds = new Set()
  manageLabelsAthleteId = null
}

// ==========================================================================
// ---- LOAD ATHLETES ----
// Fetches every athlete from the DB. Returns false if the screen should
// stop (error, or navigated away mid-load). Unlike script.js's
// loadAthletes() this does NOT repaint - on the first load there's nothing
// to paint into yet, so mount() puts up the template and renders itself,
// and reloadAndRepaint() below is what the card actions call.
// ==========================================================================
async function loadAthletes(token) {
  // Just the athletes themselves - the one query the whole screen actually
  // depends on to show anything. Kept alone in its own await (default 3
  // retries) so a slow/flaky connection still gets retried, but nothing
  // else can ever hold this up.
  const { data, error } = await window.fetchWithRetry((signal) => supabase.from('athletes').select('*').abortSignal(signal))
  if (token !== undefined && !nav.isCurrent(token)) return false

  if (error) {
    console.log('Error loading athletes:', error)
    if (root) root.innerHTML = `
      <div class="screen-message">
        <h2>Couldn't load your athletes</h2>
        <p>Check your connection and try again.</p>
      </div>`
    return false
  }

  allAthletes = data
  return true
}

// Re-reads from the server and repaints - what "Archive", "Delete",
// "Save Athlete" and a label deletion all call. script.js used plain
// loadAthletes() for this, which did the fetch and the repaint together.
async function reloadAndRepaint() {
  if (!(await loadAthletes())) return
  if (!root) return
  updateFilterCounts()
  applyFilters()
  loadAthleteExtras()
}

async function loadAthleteExtras() {
  const thirtyDaysAgo = toDateStrIdx(addDaysIdx(new Date(), -29))
  const ninetyDaysAgoISO = addDaysIdx(new Date(), -89).toISOString()

  // maxAttempts=1 (no retries) - these are all secondary/derived data, so
  // failing fast and just showing '—'/no badge is better than making the
  // coach wait through 3 rounds of backoff for something non-essential
  const [
    { data: flaggedData },
    { data: programs, error: programsError },
    { data: logSets, error: logError },
    { data: sessions, error: sessionsError },
    { data: labelsData },
    { data: labelLinksData },
    { data: profileData }
  ] = await Promise.all([
    // Unreviewed pain/injury reports (see wireRpeFlagFollowup in
    // athlete-app/dashboard.js) - not time-scoped, unlike Overview's other
    // stats, since this is meant to stay visible until acknowledged
    window.fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('athlete_id')
      .eq('rpe_flag_reason', 'pain_injury')
      .is('rpe_flag_reviewed_at', null)
      .abortSignal(signal), 1
    ),
    // Every non-template scheduled day, for "Programmed Through" + 30-day
    // completion - same nested shape athlete.js's loadOverviewStats() uses
    window.fetchWithRetry((signal) => supabase
      .from('programs')
      .select('athlete_id, start_date, program_weeks(week_number, program_days(day_number, date_override, program_exercises(id, prescribed_sets)))')
      .eq('is_template', false)
      .abortSignal(signal), 1
    ),
    // Logged sets for the last 30 days only - completion rate never looks
    // further back than that
    window.fetchWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .select('athlete_id, program_exercise_id, date, completed_at, set_number')
      .gte('date', thirtyDaysAgo)
      .abortSignal(signal), 1
    ),
    // Rated sessions for ACWR - 90 days back, same window athlete.js uses
    window.fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('athlete_id, started_at, ended_at, local_date, session_rpe')
      .not('ended_at', 'is', null)
      .gte('started_at', ninetyDaysAgoISO)
      .abortSignal(signal), 1
    ),
    window.fetchWithRetry((signal) => supabase.from('athlete_labels').select('*').order('name').abortSignal(signal), 1),
    window.fetchWithRetry((signal) => supabase.from('athlete_label_links').select('*').abortSignal(signal), 1),
    // Coach's own "warn me N days before an athlete's last training" setting
    window.fetchWithRetry((signal) => supabase.from('profiles').select('low_trainings_warning_days').eq('id', coachId()).single().abortSignal(signal), 1)
  ])
  // Started fire-and-forget from mount(), so this can easily land after the
  // coach has moved on - everything below repaints the grid.
  if (!nav.isCurrent(mountToken) || !root) return

  lowTrainingsWarningDays = profileData ? (profileData.low_trainings_warning_days ?? 7) : 7

  allLabels = labelsData || []
  labelLinksByAthlete = {}
  for (const row of (labelLinksData || [])) {
    (labelLinksByAthlete[row.athlete_id] ||= new Set()).add(row.label_id)
  }
  renderLabelFilterList()

  flaggedCountByAthlete = {}
  if (flaggedData) {
    for (const row of flaggedData) {
      flaggedCountByAthlete[row.athlete_id] = (flaggedCountByAthlete[row.athlete_id] || 0) + 1
    }
  }

  if (programsError || logError || sessionsError) {
    console.log('Error loading card stats:', programsError || logError || sessionsError)
    athleteStatsById = {}
  } else {
    athleteStatsById = computeAthleteCardStats(programs, logSets, sessions, thirtyDaysAgo)
  }

  applyFilters() // re-render now that badges/stats are in (counts already shown, don't depend on this)
  checkLowTrainings() // fire-and-forget - never blocks the list from rendering
}

// ==========================================================================
// ---- LOW ON TRAININGS (no trainings left, or running out soon) ----
// stats.furthestDate is already the furthest scheduled day across every
// non-template program (see computeAthleteCardStats) - "low" means that
// date is within the coach's configured warning window from today, or
// there's no scheduled date at all. Only checked for active athletes -
// pending/offline/archived aren't actually being trained yet, so flagging
// them here would just be noise.
// ==========================================================================
function isLowOnTrainings(athlete, stats) {
  if (athleteStatus(athlete) !== 'active') return false
  const todayStr = toDateStrIdx(new Date())
  if (!stats || !stats.furthestDate) return true
  return daysBetweenDateStrsIdx(todayStr, stats.furthestDate) <= lowTrainingsWarningDays
}

// Notifies the coach (via the bell - see bell.js) the first time an athlete
// crosses into "low on trainings", using athletes.low_trainings_notified_for
// as a dedupe key so reloading this screen repeatedly doesn't spam a fresh
// notification every time - a NEW one only fires once the coach has fixed
// it (added more trainings, pushing furthestDate out) and it later runs dry
// again, since that produces a different furthestDate to compare against.
//
// Touches no DOM, so it needs no isCurrent guard to be safe - but it does
// stop early once the screen is gone, rather than walking a whole roster of
// athletes the coach has already navigated away from.
async function checkLowTrainings() {
  for (const athlete of allAthletes) {
    if (!nav.isCurrent(mountToken)) return
    const stats = athleteStatsById[athlete.id]
    if (!isLowOnTrainings(athlete, stats)) continue

    const currentKey = (stats && stats.furthestDate) || 'never'
    if (athlete.low_trainings_notified_for === currentKey) continue

    const message = (stats && stats.furthestDate)
      ? `${athlete.name} only has trainings scheduled through ${parseDateStrIdx(stats.furthestDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : `${athlete.name} doesn't have any trainings scheduled yet`

    const { error: notifError } = await supabase.from('notifications').insert([{
      coach_id: coachId(), athlete_id: athlete.id, type: 'low_trainings', message
    }])
    if (notifError) { console.log(notifError); continue }

    const { error: updateError } = await supabase.from('athletes').update({ low_trainings_notified_for: currentKey }).eq('id', athlete.id)
    if (!updateError) athlete.low_trainings_notified_for = currentKey
  }
}

// ==========================================================================
// ---- PER-ATHLETE CARD STATS (ACWR / Programmed Through / 30-Day Completion) ----
// Same math as athlete.js's loadOverviewStats(), computed here in bulk
// across every athlete in one pass. Date helpers duplicated from athlete.js
// per this codebase's per-file convention (this is a separate module with
// no shared scope).
// ==========================================================================
function toDateStrIdx(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseDateStrIdx(dateStr) {
  return new Date(dateStr + 'T00:00:00')
}

function addDaysIdx(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function daysBetweenDateStrsIdx(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000)
}

function resolveDateIdx(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStrIdx(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStrIdx(result)
}

function computeAthleteCardStats(programs, logSets, sessions, thirtyDaysAgo) {
  const programsByAthlete = {}
  for (const p of programs) (programsByAthlete[p.athlete_id] ||= []).push(p)

  const logSetsByAthletePE = {}
  for (const row of logSets) {
    const byPE = (logSetsByAthletePE[row.athlete_id] ||= {})
    ;(byPE[row.program_exercise_id] ||= []).push(row)
  }

  const sessionsByAthlete = {}
  for (const s of sessions) (sessionsByAthlete[s.athlete_id] ||= []).push(s)

  const todayStr = toDateStrIdx(new Date())
  const result = {}

  for (const athlete of allAthletes) {
    const athletePrograms = programsByAthlete[athlete.id] || []
    const logSetsByPE = logSetsByAthletePE[athlete.id] || {}
    const athleteSessions = sessionsByAthlete[athlete.id] || []

    // ---- Programmed through: furthest scheduled date + this window's
    // workout entries (reused for completion below) ----
    let furthestDate = null
    const workoutEntries = []
    for (const program of athletePrograms) {
      for (const week of program.program_weeks) {
        for (const day of week.program_days) {
          const dateStr = day.date_override || resolveDateIdx(program.start_date, week.week_number, day.day_number)
          if (furthestDate === null || dateStr > furthestDate) furthestDate = dateStr
          workoutEntries.push({ dateStr, exercises: day.program_exercises })
        }
      }
    }

    // ---- 30-day completion (same rule as athlete.js's completionRate) ----
    let scheduled = 0
    let completed = 0
    for (const entry of workoutEntries) {
      if (entry.dateStr < thirtyDaysAgo || entry.dateStr > todayStr) continue
      if (entry.exercises.length === 0) continue
      let totalSets = 0
      let doneSets = 0
      for (const pe of entry.exercises) {
        const prescribed = pe.prescribed_sets || 1
        totalSets += prescribed
        const logged = (logSetsByPE[pe.id] || []).filter(s => s.completed_at && s.set_number <= prescribed)
        doneSets += Math.min(logged.length, prescribed)
      }
      const workoutDone = totalSets > 0 && (doneSets / totalSets) >= 0.5
      if (entry.dateStr === todayStr && !workoutDone) continue
      scheduled++
      if (workoutDone) completed++
    }
    const completionRate30 = scheduled === 0 ? null : Math.round((completed / scheduled) * 100)

    // ---- ACWR (Foster's session-RPE method, same 28-day-history guard
    // used on the athlete's own Overview tab) ----
    const dailyLoad = {}
    for (const s of athleteSessions) {
      if (s.session_rpe == null) continue
      const dateStr = s.local_date
      const minutes = (new Date(s.ended_at) - new Date(s.started_at)) / 60000
      dailyLoad[dateStr] = (dailyLoad[dateStr] || 0) + s.session_rpe * minutes
    }
    function loadSum(days) {
      const cutoff = toDateStrIdx(addDaysIdx(new Date(), -(days - 1)))
      return Object.entries(dailyLoad).filter(([d]) => d >= cutoff && d <= todayStr).reduce((sum, [, v]) => sum + v, 0)
    }
    const loadDates = Object.keys(dailyLoad).sort()
    const daysOfHistory = loadDates.length ? daysBetweenDateStrsIdx(loadDates[0], todayStr) + 1 : 0
    const hasEnoughHistory = daysOfHistory >= 28
    const acuteLoad = loadSum(7)
    const chronicLoad = hasEnoughHistory ? loadSum(28) / 4 : 0
    const acwr = (hasEnoughHistory && chronicLoad > 0) ? acuteLoad / chronicLoad : null

    result[athlete.id] = {
      acwr,
      acwrBuilding: !hasEnoughHistory && loadDates.length > 0,
      furthestDate,
      completionRate30
    }
  }

  return result
}

// ==========================================================================
// ---- STATUS + FILTER ----
// active = linked to a real login, pending = coach has entered an email but
// the athlete hasn't signed up/linked yet, offline = no email on file yet,
// archived = coach hid them (overrides the other 3 regardless of link state).
// ==========================================================================
function athleteStatus(athlete) {
  if (athlete.archived) return 'archived'
  if (athlete.user_id) return 'active'
  if (athlete.email) return 'pending'
  return 'offline'
}

// Sidebar submenu links get a live count appended, e.g. "Active (3)" and
// the current one highlighted. Deliberately document-scoped rather than
// root-scoped: #athleteStatusFilter lives in the shell's sidebar
// (dashboard.html), which this screen does not own and which survives every
// screen swap. dashboard.js's syncNavHighlight only touches
// .sidebar-link[data-tab], so nothing else is fighting over these four.
function updateFilterCounts() {
  const counts = { active: 0, pending: 0, offline: 0, archived: 0 }
  allAthletes.forEach(a => { counts[athleteStatus(a)]++ })
  document.querySelectorAll('#athleteStatusFilter a').forEach(link => {
    const status = link.dataset.status
    link.textContent = `${STATUS_LABELS[status]} (${counts[status]})`
    link.classList.toggle('active', status === currentStatusFilter)
  })
}

// Re-renders the grid from the cached athlete list using the status
// (handed in as params.status by the sidebar submenu, see
// currentStatusFilter above), the search box, and the label filter
// together (AND across all three) - no re-query for any of them.
function applyFilters() {
  const athleteGrid = root.querySelector('.athlete-grid')
  const query = currentSearchQuery.trim().toLowerCase()
  const filtered = allAthletes.filter(a =>
    athleteStatus(a) === currentStatusFilter &&
    (!query || a.name.toLowerCase().includes(query)) &&
    (selectedLabelFilterIds.size === 0 || [...selectedLabelFilterIds].some(id => labelLinksByAthlete[a.id]?.has(id)))
  )

  // Athletes low on (or out of) trainings float to the top - Array.sort is
  // stable, so everyone else keeps whatever order they were already in
  filtered.sort((a, b) => isLowOnTrainings(b, athleteStatsById[b.id]) - isLowOnTrainings(a, athleteStatsById[a.id]))

  athleteGrid.innerHTML = ''
  if (filtered.length === 0) {
    athleteGrid.innerHTML = (query || selectedLabelFilterIds.size > 0) ? '<p>No athletes match your search.</p>' : '<p>No athletes here yet.</p>'
    return
  }
  filtered.forEach(athlete => {
    athleteGrid.appendChild(createAthleteCard(athlete, flaggedCountByAthlete[athlete.id]))
  })
}

// ==========================================================================
// ---- EVENT WIRING ----
// Everything script.js registered at module top-level, against markup that
// was already in the document. Called once per mount, after TEMPLATE is in.
// ==========================================================================
function bindEvents() {
  // Outside click closes the label filter dropdown (same pattern as the
  // kebab dropdowns). The screen's only document-level listener - tracked
  // so unmount() can take it back off.
  onDocClickFilter = function(e) {
    if (!e.target.closest('#labelFilter')) root?.querySelector('#labelFilterDropdown')?.classList.remove('active')
  }
  document.addEventListener('click', onDocClickFilter)

  root.querySelector('#athleteSearchInput').addEventListener('input', function(e) {
    currentSearchQuery = e.target.value
    applyFilters()
  })

  root.querySelector('#labelFilterBtn').addEventListener('click', function(e) {
    e.stopPropagation()
    root.querySelector('#labelFilterDropdown').classList.toggle('active')
  })

  root.querySelector('#addLabelBtn').addEventListener('click', function() {
    const input = root.querySelector('#newLabelInput')
    addLabel(input.value)
    input.value = ''
  })

  root.querySelector('#newLabelInput').addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return
    addLabel(this.value)
    this.value = ''
  })

  root.querySelector('#manageLabelsAddBtn').addEventListener('click', function() {
    const input = root.querySelector('#manageLabelsNewInput')
    addLabel(input.value, manageLabelsAthleteId)
    input.value = ''
  })

  root.querySelector('#manageLabelsNewInput').addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return
    addLabel(this.value, manageLabelsAthleteId)
    this.value = ''
  })

  root.querySelector('#closeManageLabelsBtn').addEventListener('click', function() {
    root.querySelector('#manageLabelsModal').classList.remove('active')
  })

  bindAddAthleteEvents()
  bindMessageAthletesEvents()
}

// ==========================================================================
// ---- MESSAGE ATHLETES ----
// Compose a message, sent to all athletes or specific ones - one row per
// recipient (fan-out at send time), same shape notifications already
// uses, so "seen" tracking is just a per-row timestamp with no separate
// join table. timing decides which of the two in-app moments the athlete
// app shows it at (see loadCoachMessages()/startWorkout() in
// athlete-app/dashboard.js). 'push' additionally sends a real push
// notification via sendPush() below, same send-push Edge Function as
// every other push in this app.
// ==========================================================================
function bindMessageAthletesEvents() {
  root.querySelector('#messageAthletesBtn').addEventListener('click', function() {
    root.querySelector('#coachMessageText').value = ''
    root.querySelectorAll('#messageTimingChips .chip-btn').forEach(b => b.classList.toggle('selected', b.dataset.timing === 'on_open'))
    root.querySelector('#messageToAllToggle').checked = true
    root.querySelector('#messageRecipientList').style.display = 'none'
    renderMessageRecipientList()
    root.querySelector('#messageAthletesModal').classList.add('active')
  })

  root.querySelector('#closeMessageAthletesBtn').addEventListener('click', function() {
    root.querySelector('#messageAthletesModal').classList.remove('active')
  })
  root.querySelector('#cancelMessageAthletesBtn').addEventListener('click', function() {
    root.querySelector('#messageAthletesModal').classList.remove('active')
  })

  root.querySelectorAll('#messageTimingChips .chip-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      root.querySelectorAll('#messageTimingChips .chip-btn').forEach(b => b.classList.remove('selected'))
      btn.classList.add('selected')
    })
  })

  root.querySelector('#messageToAllToggle').addEventListener('change', function(e) {
    root.querySelector('#messageRecipientList').style.display = e.target.checked ? 'none' : 'block'
  })

  root.querySelector('#sendMessageAthletesBtn').addEventListener('click', onSendMessageAthletes)
}

function renderMessageRecipientList() {
  const list = root.querySelector('#messageRecipientList')
  const eligible = allAthletes.filter(a => !a.archived)
  list.innerHTML = eligible.length === 0
    ? '<p class="no-metrics">No athletes yet</p>'
    : eligible.map(a => `
        <label class="message-recipient-row">
          <input type="checkbox" class="message-recipient-checkbox" value="${a.id}">
          <span>${a.name}</span>
        </label>
      `).join('')
}

async function onSendMessageAthletes() {
  const message = root.querySelector('#coachMessageText').value.trim()
  if (!message) { customAlert('Please write a message first'); return }

  const timingBtn = root.querySelector('#messageTimingChips .chip-btn.selected')
  const timing = timingBtn ? timingBtn.dataset.timing : 'on_open'

  const sendToAll = root.querySelector('#messageToAllToggle').checked
  const recipientIds = sendToAll
    ? allAthletes.filter(a => !a.archived).map(a => a.id)
    : [...root.querySelectorAll('.message-recipient-checkbox:checked')].map(cb => parseInt(cb.value))

  if (recipientIds.length === 0) { customAlert('Please choose at least one athlete'); return }

  const { error } = await supabase.from('coach_messages').insert(
    recipientIds.map(athleteId => ({ coach_id: coachId(), athlete_id: athleteId, message, timing }))
  )
  if (error) { console.log(error); customAlert('Something went wrong sending that - try again'); return }

  // The row above is still inserted for 'push' too - a fallback in case the
  // notification is missed/dismissed or the athlete never enabled push on
  // this device (see loadCoachMessages() in athlete-app/dashboard.js). The
  // actual push itself is fire-and-forget, same as every other
  // notification send in this app - a failed push shouldn't block or alert
  // on "the message was saved" succeeding.
  if (timing === 'push') {
    for (const athleteId of recipientIds) {
      const athlete = allAthletes.find(a => a.id === athleteId)
      if (!athlete || !athlete.user_id) continue // not linked to a login yet - nothing to push to
      sendPush(supabase, athlete.user_id, 'Message from your coach', message, athleteAppUrl('dashboard.html'))
    }
  }

  // The modal and the alert are shell-independent, but the screen itself
  // may be gone by now - the insert above is a round trip the coach can
  // navigate away during.
  if (!root) return
  root.querySelector('#messageAthletesModal').classList.remove('active')
  customAlert(`Sent to ${recipientIds.length} athlete${recipientIds.length === 1 ? '' : 's'}.`)
}

// ==========================================================================
// ---- CREATE ATHLETE CARD ----
// Builds one athlete card (initials, name, basic stats), wires up:
//  - clicking the card → go to that athlete's profile screen
//  - the kebab (⋮) menu → toggle a dropdown
//  - "Delete athlete" in that dropdown → confirm, then delete from DB
// ==========================================================================
const STATUS_LABELS = { active: 'Active', pending: 'Pending', offline: 'Offline', archived: 'Archived' }

function escapeHtmlIdx(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function createAthleteCard(athlete, flaggedCount) {
  const initials = athlete.name.split(' ').map(word => word[0]).join('').toUpperCase()
  const avatarHtml = athlete.avatar_url ? `<img src="${athlete.avatar_url}" class="avatar-img" alt="">` : initials
  const status = athleteStatus(athlete)
  const stats = athleteStatsById[athlete.id] || {}
  const todayStr = toDateStrIdx(new Date())

  const acwrText = stats.acwr == null ? '—' : stats.acwr.toFixed(2)
  const acwrHighRisk = stats.acwr != null && stats.acwr > 1.5
  const acwrBadgeHtml = acwrHighRisk
    ? '<span class="stat-risk-badge">High Risk</span>'
    : (stats.acwrBuilding ? '<span class="stat-risk-badge neutral">Building History</span>' : '')

  const programmedThroughText = stats.furthestDate
    ? parseDateStrIdx(stats.furthestDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—'
  const programRanOut = stats.furthestDate && stats.furthestDate < todayStr
  const programBadgeHtml = programRanOut ? '<span class="stat-risk-badge neutral">Program Ended</span>' : ''
  const lowOnTrainings = isLowOnTrainings(athlete, stats)

  const completionText = stats.completionRate30 == null ? '—' : `${stats.completionRate30}%`

  const athleteLabelIds = labelLinksByAthlete[athlete.id] || new Set()
  const labelTagsHtml = allLabels.filter(l => athleteLabelIds.has(l.id)).map(l => `<span class="label-tag">${escapeHtmlIdx(l.name)}</span>`).join('')

  const card = document.createElement('div')
  card.classList.add('athlete-card')
  card.innerHTML = `
    <div class="card-top">
      <div class="card-badge-row">
        <div class="athlete-initials">${avatarHtml}</div>
        ${lowOnTrainings ? '<span class="low-trainings-badge" title="Low on (or out of) scheduled trainings">!</span>' : ''}
        <span class="athlete-status-badge status-${status}">${STATUS_LABELS[status]}</span>
        ${flaggedCount ? `<span class="pain-flag-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg> ${flaggedCount > 1 ? flaggedCount + ' pain reports' : 'Pain reported'}</span>` : ''}
        ${labelTagsHtml}
      </div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-athlete-id="${athlete.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${athlete.id}">
          ${status === 'pending' ? `
            <button class="kebab-item kebab-resend" data-athlete-id="${athlete.id}">Resend Invite</button>
            <button class="kebab-item kebab-copy-link" data-athlete-id="${athlete.id}">Copy Invite Link</button>
          ` : ''}
          <button class="kebab-item kebab-manage-labels" data-athlete-id="${athlete.id}">Manage Labels</button>
          <button class="kebab-item kebab-archive" data-athlete-id="${athlete.id}">${athlete.archived ? 'Unarchive athlete' : 'Archive athlete'}</button>
          <button class="kebab-delete" data-athlete-id="${athlete.id}">Delete athlete</button>
        </div>
      </div>
    </div>
    <h3>${athlete.name}</h3>
    <div class="athlete-card-stats">
      <div class="athlete-card-stat-row">
        <div class="athlete-card-stat-top">
          <span class="athlete-card-stat-label">ACWR</span>
          <span class="athlete-card-stat-value">${acwrText}</span>
        </div>
        ${acwrBadgeHtml}
      </div>
      <div class="athlete-card-stat-row">
        <div class="athlete-card-stat-top">
          <span class="athlete-card-stat-label">Programmed Through</span>
          <span class="athlete-card-stat-value">${programmedThroughText}</span>
        </div>
        ${programBadgeHtml}
      </div>
      <div class="athlete-card-stat-row">
        <div class="athlete-card-stat-top">
          <span class="athlete-card-stat-label">30-Day Completion</span>
          <span class="athlete-card-stat-value">${completionText}</span>
        </div>
      </div>
    </div>
  `

  // Clicking anywhere on the card (except the kebab menu) opens the athlete's profile
  card.addEventListener('click', function(e) {
    if (e.target.closest('.kebab-menu')) return
    go('athlete-detail', { id: athlete.id })
  })

  // Kebab (⋮) button toggles the dropdown open/closed
  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    const dropdown = card.querySelector(`#dropdown-${athlete.id}`)
    dropdown.classList.toggle('active')
  })

  // "Resend Invite" / "Copy Invite Link" - only present on Pending cards
  card.querySelector('.kebab-resend')?.addEventListener('click', async function(e) {
    e.stopPropagation()
    const error = await sendInviteEmail(athlete.email, athlete.name)
    customAlert(error ? 'Something went wrong sending the invite' : `Invite sent to ${athlete.email}`)
  })

  card.querySelector('.kebab-copy-link')?.addEventListener('click', async function(e) {
    e.stopPropagation()
    await navigator.clipboard.writeText(buildInviteLink(athlete.email, athlete.name))
    customAlert('Invite link copied - paste it anywhere you like.')
  })

  card.querySelector('.kebab-manage-labels').addEventListener('click', function(e) {
    e.stopPropagation()
    openManageLabelsModal(athlete.id, athlete.name)
  })

  // "Archive athlete" / "Unarchive athlete" - reversible, no confirm needed
  card.querySelector('.kebab-archive').addEventListener('click', async function(e) {
    e.stopPropagation()
    const { error } = await supabase
      .from('athletes')
      .update({ archived: !athlete.archived })
      .eq('id', athlete.id)

    if (error) {
      console.log('Error archiving athlete:', error)
      customAlert('Something went wrong')
      return
    }

    reloadAndRepaint()
  })

  // "Delete athlete" — confirm, delete from DB, then refresh the list
  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()

    if (!(await customConfirm('Delete this athlete? This cannot be undone.'))) return

    const { error } = await supabase
      .from('athletes')
      .delete()
      .eq('id', athlete.id)

    if (error) {
      console.log('Error deleting athlete:', error)
      customAlert('Something went wrong')
      return
    }

    reloadAndRepaint()
  })

  return card
}

// ==========================================================================
// ---- INVITE HELPERS ----
// sendInviteEmail fires Supabase's own magic-link email (shouldCreateUser
// lets it create the auth account on the spot, with role/name stamped into
// signup metadata for the handle_new_user trigger to pick up) - this is
// what turns a Pending athlete into Active once they click it and land on
// the athlete app, already signed in and auto-linked via
// claim_athlete_by_email(). buildInviteLink is the manual fallback: a
// plain link straight to the athlete app's signup form with email/name
// pre-filled, no dependency on the invite email actually arriving.
//
// athleteAppUrl exists because the coach app now lives one directory down
// (coach-app/dashboard.html) instead of at the repo root. 'athlete-app/x'
// resolved against this document would point at coach-app/athlete-app/x,
// which doesn't exist - hence the leading '../'.
// ==========================================================================
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

// ==========================================================================
// ---- ADD ATHLETE MODAL ----
// Open/close the "add athlete" modal, and save a new athlete to the DB.
// ==========================================================================
function bindAddAthleteEvents() {
  root.querySelector('.btn-add').addEventListener('click', function() {
    root.querySelector('#addAthleteModal').classList.add('active')
  })

  root.querySelector('#cancelBtn').addEventListener('click', function() {
    root.querySelector('#addAthleteModal').classList.remove('active')
  })

  root.querySelector('#saveBtn').addEventListener('click', onSaveAthlete)
}

async function onSaveAthlete() {
  const name = root.querySelector('#athleteName').value
  // Empty -> null, not '' - a blank string sent to a `date` column errors
  // outright, and an empty gender fails its check constraint, so any coach
  // who only has a name+email at intake (the common case) couldn't save at
  // all. Height goes through the same treatment since parseInt('') is NaN.
  const dobRaw = root.querySelector('#athleteDOB').value
  const dob = dobRaw || null
  const genderRaw = root.querySelector('#athleteGender').value
  const gender = genderRaw || null
  const heightRaw = parseInt(root.querySelector('#athleteHeight').value)
  const height = Number.isNaN(heightRaw) ? null : heightRaw
  // Empty -> null, not '' - the email column has a "no duplicates" rule in
  // the database, and two blank emails would otherwise count as duplicates
  const email = root.querySelector('#athleteEmail').value.trim() || null

  if (name === '') {
    customAlert('Please enter a name')
    return
  }

  // coach_id has to be set on insert - once RLS is on, the athletes table
  // policy only allows rows where coach_id matches the logged-in coach
  const { error } = await supabase
    .from('athletes')
    .insert([{
      name: name,
      date_of_birth: dob,
      gender: gender,
      height: height,
      email: email,
      coach_id: coachId()
    }])
    .select()

  if (error) {
    console.log('Error saving athlete:', error)
    if (error.code === '23505') {
      customAlert('Another athlete is already using that email')
    } else {
      customAlert('Something went wrong saving the athlete')
    }
    return
  }

  if (!root) return
  root.querySelector('#addAthleteModal').classList.remove('active')
  root.querySelector('#athleteEmail').value = ''

  // The athlete row is saved either way - an invite failure shouldn't look
  // like the whole save failed, just its own message
  if (email) {
    const inviteError = await sendInviteEmail(email, name)
    if (inviteError) {
      console.log('Error sending invite:', inviteError)
      customAlert('Athlete saved, but the invite email failed to send. You can resend it or copy the invite link from the kebab menu on their card.')
    }
  }

  await reloadAndRepaint()
}

// ==========================================================================
// ---- LABELS ----
// Coach-created tags (e.g. "Monthly Plan", "12 Week Plan") - the "Filter by
// Label" dropdown (next to the search bar) filters the grid to athletes
// with ANY of the checked labels; each card's kebab menu has its own
// "Manage Labels" modal for tagging/untagging that one athlete. Both share
// the same allLabels/labelLinksByAthlete state loaded in loadAthleteExtras().
// ==========================================================================
function renderLabelFilterList() {
  const list = root.querySelector('#labelFilterList')
  if (allLabels.length === 0) {
    list.innerHTML = '<p class="label-filter-empty">No labels yet - add one below.</p>'
    return
  }
  list.innerHTML = allLabels.map(label => {
    const count = allAthletes.filter(a => labelLinksByAthlete[a.id]?.has(label.id)).length
    const checked = selectedLabelFilterIds.has(label.id) ? 'checked' : ''
    return `
      <div class="label-filter-row">
        <label>
          <input type="checkbox" data-label-id="${label.id}" ${checked}>
          <span>${escapeHtmlIdx(label.name)} (${count})</span>
        </label>
        <button type="button" class="label-row-delete" data-label-id="${label.id}" title="Delete label">✕</button>
      </div>
    `
  }).join('')

  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', function() {
      if (cb.checked) selectedLabelFilterIds.add(cb.dataset.labelId)
      else selectedLabelFilterIds.delete(cb.dataset.labelId)
      applyFilters()
    })
  })

  list.querySelectorAll('.label-row-delete').forEach(btn => {
    btn.addEventListener('click', async function() {
      if (!(await customConfirm('Delete this label? It will be removed from every athlete.'))) return
      const { error } = await supabase.from('athlete_labels').delete().eq('id', btn.dataset.labelId)
      if (error) {
        console.log('Error deleting label:', error)
        customAlert('Something went wrong')
        return
      }
      selectedLabelFilterIds.delete(btn.dataset.labelId)
      reloadAndRepaint()
    })
  })
}

// Creates a label, optionally linking it straight to one athlete (used by
// the Manage Labels modal, so creating a new label there tags it onto that
// athlete immediately instead of leaving it unassigned)
async function addLabel(name, linkToAthleteId) {
  name = name.trim()
  if (!name) return
  const { data, error } = await supabase.from('athlete_labels').insert([{ name, coach_id: coachId() }]).select().single()
  if (error) {
    console.log('Error adding label:', error)
    customAlert('Something went wrong adding that label')
    return
  }
  if (linkToAthleteId) {
    await supabase.from('athlete_label_links').insert([{ athlete_id: linkToAthleteId, label_id: data.id }])
  }
  await loadAthleteExtras()
  if (linkToAthleteId && root) renderManageLabelsList()
}

// ---- Manage Labels modal (per-athlete tagging) ----
function openManageLabelsModal(athleteId, athleteName) {
  manageLabelsAthleteId = athleteId
  root.querySelector('#manageLabelsAthleteName').textContent = athleteName
  renderManageLabelsList()
  root.querySelector('#manageLabelsModal').classList.add('active')
}

function renderManageLabelsList() {
  const list = root.querySelector('#manageLabelsList')
  const athleteLabelIds = labelLinksByAthlete[manageLabelsAthleteId] || new Set()

  if (allLabels.length === 0) {
    list.innerHTML = '<p class="label-filter-empty">No labels yet - add one below.</p>'
    return
  }

  list.innerHTML = allLabels.map(label => `
    <label class="message-recipient-row">
      <input type="checkbox" data-label-id="${label.id}" ${athleteLabelIds.has(label.id) ? 'checked' : ''}>
      <span>${escapeHtmlIdx(label.name)}</span>
    </label>
  `).join('')

  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', function() {
      toggleAthleteLabel(manageLabelsAthleteId, cb.dataset.labelId, cb.checked)
    })
  })
}

async function toggleAthleteLabel(athleteId, labelId, checked) {
  const { error } = checked
    ? await supabase.from('athlete_label_links').insert([{ athlete_id: athleteId, label_id: labelId }])
    : await supabase.from('athlete_label_links').delete().eq('athlete_id', athleteId).eq('label_id', labelId)

  if (error) {
    console.log('Error updating athlete label:', error)
    customAlert('Something went wrong')
    return
  }

  (labelLinksByAthlete[athleteId] ||= new Set())[checked ? 'add' : 'delete'](labelId)
  // The insert/delete above is a round trip the coach can navigate away
  // during - the cached Set is still worth updating, the repaint isn't.
  if (!root) return
  renderLabelFilterList()
  applyFilters()
}
