// ==========================================================================
// SETUP — Supabase client + references to key DOM elements
// This is the dashboard/index page: it lists all athletes as cards and
// handles adding/deleting athletes.
// ==========================================================================
import { supabase } from './coachClient.js'
import { sendPush } from './push.js'
 
const addBtn = document.querySelector('.btn-add');
const modal = document.getElementById('addAthleteModal');
const cancelBtn = document.getElementById('cancelBtn');
const saveBtn = document.getElementById('saveBtn');
const athleteGrid = document.querySelector('.athlete-grid');

// Cached full list + the filter currently applied to it, so switching
// status chips (or typing a search) re-renders instantly from memory
// instead of re-querying
let allAthletes = []
let flaggedCountByAthlete = {}
let athleteStatsById = {} // athlete_id -> { acwr, acwrBuilding, furthestDate, completionRate30 } - see loadAthleteCardStats()
// Status now lives in the sidebar submenu (index.html?status=X) instead of
// in-page chips, so the initial filter comes from the URL, not a hardcoded default
let currentStatusFilter = new URLSearchParams(window.location.search).get('status') || 'active'
let currentSearchQuery = ''

// Coach-created labels (e.g. "Monthly Plan") + which athletes have which -
// see the "Filter by Label" dropdown and each card's "Manage Labels" kebab item
let allLabels = []
let labelLinksByAthlete = {} // athlete_id -> Set of label_id
let selectedLabelFilterIds = new Set()

// Require a logged-in coach before loading anything. RLS is on, so the
// database itself only ever returns this coach's own athletes - this is
// just an extra UX gate so a logged-out visitor gets bounced to the login
// page instead of seeing an empty dashboard.
const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  // Shows which account is logged in - each device remembers its own
  // session, so it's possible to be logged into a different coach account
  // (e.g. one made by tapping "Sign up" instead of "Log In" on a new
  // device) without realizing it, since the login screen looks the same
  // either way. Comparing this text between devices is the fastest way to
  // check if that's what's happening.
  document.getElementById('loggedInAs').textContent = session.user.email
  loadAthletes();
}

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'login.html'
})

// ==========================================================================
// ---- MESSAGE ATHLETES ----
// Compose a message, sent to all athletes or specific ones - one row per
// recipient (fan-out at send time), same shape notifications already
// uses, so "seen" tracking is just a per-row timestamp with no separate
// join table. timing decides which of the two in-app moments the athlete
// app shows it at (see loadCoachMessages()/startWorkout() in
// athlete-app/dashboard.js) - real push notifications aren't built yet,
// deliberately deferred (needs a service worker + a way to send from a
// server, which this app doesn't have).
// ==========================================================================
document.getElementById('messageAthletesBtn').addEventListener('click', function() {
  document.getElementById('coachMessageText').value = ''
  document.querySelectorAll('#messageTimingChips .chip-btn').forEach(b => b.classList.toggle('selected', b.dataset.timing === 'on_open'))
  document.getElementById('messageToAllToggle').checked = true
  document.getElementById('messageRecipientList').style.display = 'none'
  renderMessageRecipientList()
  document.getElementById('messageAthletesModal').classList.add('active')
})

document.getElementById('closeMessageAthletesBtn').addEventListener('click', function() {
  document.getElementById('messageAthletesModal').classList.remove('active')
})
document.getElementById('cancelMessageAthletesBtn').addEventListener('click', function() {
  document.getElementById('messageAthletesModal').classList.remove('active')
})

document.querySelectorAll('#messageTimingChips .chip-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('#messageTimingChips .chip-btn').forEach(b => b.classList.remove('selected'))
    btn.classList.add('selected')
  })
})

document.getElementById('messageToAllToggle').addEventListener('change', function(e) {
  document.getElementById('messageRecipientList').style.display = e.target.checked ? 'none' : 'block'
})

function renderMessageRecipientList() {
  const list = document.getElementById('messageRecipientList')
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

document.getElementById('sendMessageAthletesBtn').addEventListener('click', async function() {
  const message = document.getElementById('coachMessageText').value.trim()
  if (!message) { customAlert('Please write a message first'); return }

  const timingBtn = document.querySelector('#messageTimingChips .chip-btn.selected')
  const timing = timingBtn ? timingBtn.dataset.timing : 'on_open'

  const sendToAll = document.getElementById('messageToAllToggle').checked
  const recipientIds = sendToAll
    ? allAthletes.filter(a => !a.archived).map(a => a.id)
    : [...document.querySelectorAll('.message-recipient-checkbox:checked')].map(cb => parseInt(cb.value))

  if (recipientIds.length === 0) { customAlert('Please choose at least one athlete'); return }

  const { error } = await supabase.from('coach_messages').insert(
    recipientIds.map(athleteId => ({ coach_id: session.user.id, athlete_id: athleteId, message, timing }))
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
      sendPush(supabase, athlete.user_id, 'Message from your coach', message, new URL('athlete-app/dashboard.html', window.location.href).href)
    }
  }

  document.getElementById('messageAthletesModal').classList.remove('active')
  customAlert(`Sent to ${recipientIds.length} athlete${recipientIds.length === 1 ? '' : 's'}.`)
})

// ==========================================================================
// ---- LOAD ATHLETES ----
// Fetches every athlete from the DB and renders a card for each one
// (or a placeholder message if there are none yet).
// ==========================================================================
async function loadAthletes() {
  // Just the athletes themselves - the one query the whole page actually
  // depends on to show anything. Kept alone in its own await (default 3
  // retries) so a slow/flaky connection still gets retried, but nothing
  // else can ever hold this up.
  const { data, error } = await fetchWithRetry((signal) => supabase.from('athletes').select('*').abortSignal(signal))

  if (error) {
    console.log('Error loading athletes:', error)
    customAlert('Something went wrong loading your athletes - check your connection and try again')
    return
  }

  allAthletes = data
  updateFilterCounts()
  applyFilters()

  // Pain-flag badges + card stats (ACWR/Programmed Through/Completion) are
  // enhancements, not required to see the athlete list - fetched
  // separately so a failure here (e.g. a query erroring because a pending
  // migration hasn't been run yet) can never block the page above from
  // rendering. This used to be bundled into the same Promise.all as the
  // athletes query, with the default 3 retries each - a single broken
  // "nice to have" query could make the whole page look empty for up to a
  // minute while it retried a request that was never going to succeed.
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
    { data: labelLinksData }
  ] = await Promise.all([
    // Unreviewed pain/injury reports (see wireRpeFlagFollowup in
    // athlete-app/dashboard.js) - not time-scoped, unlike Overview's other
    // stats, since this is meant to stay visible until acknowledged
    fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('athlete_id')
      .eq('rpe_flag_reason', 'pain_injury')
      .is('rpe_flag_reviewed_at', null)
      .abortSignal(signal), 1
    ),
    // Every non-template scheduled day, for "Programmed Through" + 30-day
    // completion - same nested shape athlete.js's loadOverviewStats() uses
    fetchWithRetry((signal) => supabase
      .from('programs')
      .select('athlete_id, start_date, program_weeks(week_number, program_days(day_number, date_override, program_exercises(id, prescribed_sets)))')
      .eq('is_template', false)
      .abortSignal(signal), 1
    ),
    // Logged sets for the last 30 days only - completion rate never looks
    // further back than that
    fetchWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .select('athlete_id, program_exercise_id, date, completed_at, set_number')
      .gte('date', thirtyDaysAgo)
      .abortSignal(signal), 1
    ),
    // Rated sessions for ACWR - 90 days back, same window athlete.js uses
    fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('athlete_id, started_at, ended_at, local_date, session_rpe')
      .not('ended_at', 'is', null)
      .gte('started_at', ninetyDaysAgoISO)
      .abortSignal(signal), 1
    ),
    fetchWithRetry((signal) => supabase.from('athlete_labels').select('*').order('name').abortSignal(signal), 1),
    fetchWithRetry((signal) => supabase.from('athlete_label_links').select('*').abortSignal(signal), 1)
  ])

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

// Sidebar submenu links get a live count appended, e.g. "Active (3)" and the
// current one highlighted - STATUS_LABELS is declared further down this
// file, but this only ever runs from loadAthletes() (after an await), by
// which point the whole module has already finished its initial
// top-to-bottom pass, so it's defined in time.
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
// (set from the sidebar submenu's ?status= link, see currentStatusFilter
// above), the search box, and the label filter together (AND across all
// three) - no re-query for any of them.
function applyFilters() {
  const query = currentSearchQuery.trim().toLowerCase()
  const filtered = allAthletes.filter(a =>
    athleteStatus(a) === currentStatusFilter &&
    (!query || a.name.toLowerCase().includes(query)) &&
    (selectedLabelFilterIds.size === 0 || [...selectedLabelFilterIds].some(id => labelLinksByAthlete[a.id]?.has(id)))
  )

  athleteGrid.innerHTML = ''
  if (filtered.length === 0) {
    athleteGrid.innerHTML = (query || selectedLabelFilterIds.size > 0) ? '<p>No athletes match your search.</p>' : '<p>No athletes here yet.</p>'
    return
  }
  filtered.forEach(athlete => {
    createAthleteCard(athlete, flaggedCountByAthlete[athlete.id])
  })
}

document.getElementById('athleteSearchInput').addEventListener('input', function(e) {
  currentSearchQuery = e.target.value
  applyFilters()
})

// ==========================================================================
// ---- CREATE ATHLETE CARD ----
// Builds one athlete card (initials, name, basic stats), wires up:
//  - clicking the card → go to that athlete's profile page
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

  const completionText = stats.completionRate30 == null ? '—' : `${stats.completionRate30}%`

  const athleteLabelIds = labelLinksByAthlete[athlete.id] || new Set()
  const labelTagsHtml = allLabels.filter(l => athleteLabelIds.has(l.id)).map(l => `<span class="label-tag">${escapeHtmlIdx(l.name)}</span>`).join('')

  const card = document.createElement('div')
  card.classList.add('athlete-card')
card.innerHTML = `
    <div class="card-top">
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
        <div class="athlete-initials">${initials}</div>
        <span class="athlete-status-badge status-${status}">${STATUS_LABELS[status]}</span>
        ${flaggedCount ? `<span class="pain-flag-badge">🚩 ${flaggedCount > 1 ? flaggedCount + ' pain reports' : 'Pain reported'}</span>` : ''}
        ${labelTagsHtml}
      </div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-athlete-id="${athlete.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${athlete.id}">
          ${status === 'pending' ? `
            <button class="kebab-item kebab-resend" data-athlete-id="${athlete.id}">✉️ Resend Invite</button>
            <button class="kebab-item kebab-copy-link" data-athlete-id="${athlete.id}">🔗 Copy Invite Link</button>
          ` : ''}
          <button class="kebab-item kebab-manage-labels" data-athlete-id="${athlete.id}">🏷 Manage Labels</button>
          <button class="kebab-item kebab-archive" data-athlete-id="${athlete.id}">${athlete.archived ? '♻️ Unarchive athlete' : '📦 Archive athlete'}</button>
          <button class="kebab-delete" data-athlete-id="${athlete.id}">🗑 Delete athlete</button>
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
    window.location.href = `athlete.html?id=${athlete.id}`
  })

  // Kebab (⋮) button toggles the dropdown open/closed
  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    const dropdown = document.getElementById(`dropdown-${athlete.id}`)
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

    loadAthletes()
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

    loadAthletes()
  })

  athleteGrid.appendChild(card)
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
// ==========================================================================
async function sendInviteEmail(email, name) {
  const redirectTo = new URL('athlete-app/dashboard.html', window.location.href).href
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: redirectTo, data: { role: 'athlete', name, needs_password: true } }
  })
  return error
}

function buildInviteLink(email, name) {
  const url = new URL('athlete-app/index.html', window.location.href)
  if (email) url.searchParams.set('email', email)
  if (name) url.searchParams.set('name', name)
  return url.href
}

// ==========================================================================
// ---- ADD ATHLETE MODAL ----
// Open/close the "add athlete" modal, and save a new athlete to the DB.
// ==========================================================================
addBtn.addEventListener('click', function() {
  modal.classList.add('active');
});
 
cancelBtn.addEventListener('click', function() {
  modal.classList.remove('active');
});
 
saveBtn.addEventListener('click', async function() {
  const name = document.getElementById('athleteName').value;
  const dob = document.getElementById('athleteDOB').value;
  const gender = document.getElementById('athleteGender').value;
  const height = parseInt(document.getElementById('athleteHeight').value);
  // Empty -> null, not '' - the email column has a "no duplicates" rule in
  // the database, and two blank emails would otherwise count as duplicates
  const email = document.getElementById('athleteEmail').value.trim() || null;

  if (name === '') {
    customAlert('Please enter a name');
    return;
  }

  // coach_id has to be set on insert - once RLS is on, the athletes table
  // policy only allows rows where coach_id matches the logged-in coach
  const { data, error } = await supabase
    .from('athletes')
    .insert([{
      name: name,
      date_of_birth: dob,
      gender: gender,
      height: height,
      email: email,
      coach_id: session.user.id
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

  modal.classList.remove('active')
  document.getElementById('athleteEmail').value = ''

  // The athlete row is saved either way - an invite failure shouldn't look
  // like the whole save failed, just its own message
  if (email) {
    const inviteError = await sendInviteEmail(email, name)
    if (inviteError) {
      console.log('Error sending invite:', inviteError)
      customAlert('Athlete saved, but the invite email failed to send. You can resend it or copy the invite link from the kebab menu on their card.')
    }
  }

  await loadAthletes()
});

// ==========================================================================
// ---- LABELS ----
// Coach-created tags (e.g. "Monthly Plan", "12 Week Plan") - the "Filter by
// Label" dropdown (next to the search bar) filters the grid to athletes
// with ANY of the checked labels; each card's kebab menu has its own
// "Manage Labels" modal for tagging/untagging that one athlete. Both share
// the same allLabels/labelLinksByAthlete state loaded in loadAthleteExtras().
// ==========================================================================
const labelFilterBtn = document.getElementById('labelFilterBtn')
const labelFilterDropdown = document.getElementById('labelFilterDropdown')
const manageLabelsModal = document.getElementById('manageLabelsModal')
let manageLabelsAthleteId = null

function renderLabelFilterList() {
  const list = document.getElementById('labelFilterList')
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
      loadAthletes()
    })
  })
}

// Creates a label, optionally linking it straight to one athlete (used by
// the Manage Labels modal, so creating a new label there tags it onto that
// athlete immediately instead of leaving it unassigned)
async function addLabel(name, linkToAthleteId) {
  name = name.trim()
  if (!name) return
  const { data, error } = await supabase.from('athlete_labels').insert([{ name, coach_id: session.user.id }]).select().single()
  if (error) {
    console.log('Error adding label:', error)
    customAlert('Something went wrong adding that label')
    return
  }
  if (linkToAthleteId) {
    await supabase.from('athlete_label_links').insert([{ athlete_id: linkToAthleteId, label_id: data.id }])
  }
  await loadAthleteExtras()
  if (linkToAthleteId) renderManageLabelsList()
}

labelFilterBtn.addEventListener('click', function(e) {
  e.stopPropagation()
  labelFilterDropdown.classList.toggle('active')
})

document.getElementById('addLabelBtn').addEventListener('click', function() {
  const input = document.getElementById('newLabelInput')
  addLabel(input.value)
  input.value = ''
})

document.getElementById('newLabelInput').addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return
  addLabel(this.value)
  this.value = ''
})

// Outside click closes the label filter dropdown (same pattern as the kebab dropdowns)
document.addEventListener('click', function(e) {
  if (!e.target.closest('#labelFilter')) labelFilterDropdown.classList.remove('active')
})

// ---- Manage Labels modal (per-athlete tagging) ----
function openManageLabelsModal(athleteId, athleteName) {
  manageLabelsAthleteId = athleteId
  document.getElementById('manageLabelsAthleteName').textContent = athleteName
  renderManageLabelsList()
  manageLabelsModal.classList.add('active')
}

function renderManageLabelsList() {
  const list = document.getElementById('manageLabelsList')
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
  renderLabelFilterList()
  applyFilters()
}

document.getElementById('manageLabelsAddBtn').addEventListener('click', function() {
  const input = document.getElementById('manageLabelsNewInput')
  addLabel(input.value, manageLabelsAthleteId)
  input.value = ''
})

document.getElementById('manageLabelsNewInput').addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return
  addLabel(this.value, manageLabelsAthleteId)
  this.value = ''
})

document.getElementById('closeManageLabelsBtn').addEventListener('click', function() {
  manageLabelsModal.classList.remove('active')
})
