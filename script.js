// ==========================================================================
// SETUP — Supabase client + references to key DOM elements
// This is the dashboard/index page: it lists all athletes as cards and
// handles adding/deleting athletes.
// ==========================================================================
import { supabase } from './coachClient.js'
 
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
let currentStatusFilter = 'active'
let currentSearchQuery = ''

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
// ---- LOAD ATHLETES ----
// Fetches every athlete from the DB and renders a card for each one
// (or a placeholder message if there are none yet).
// ==========================================================================
async function loadAthletes() {
  const thirtyDaysAgo = toDateStrIdx(addDaysIdx(new Date(), -29))
  const ninetyDaysAgoISO = addDaysIdx(new Date(), -89).toISOString()

  // None of these 5 depend on each other's results, so they all fire
  // together - each goes through fetchWithRetry (network-retry.js) so a
  // slow/flaky connection gets a couple of automatic retries instead of
  // silently leaving this page looking like the athletes are missing. None
  // of the last 3 filter by athlete_id - same "fetch everything this coach
  // owns, group in JS" pattern the pain-flag query above already uses,
  // avoiding one query per athlete card.
  const [
    { data, error },
    { data: flaggedData },
    { data: programs, error: programsError },
    { data: logSets, error: logError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    fetchWithRetry((signal) => supabase.from('athletes').select('*').abortSignal(signal)),
    // Unreviewed pain/injury reports (see wireRpeFlagFollowup in
    // athlete-app/dashboard.js) - not time-scoped, unlike Overview's other
    // stats, since this is meant to stay visible until acknowledged
    fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('athlete_id')
      .eq('rpe_flag_reason', 'pain_injury')
      .is('rpe_flag_reviewed_at', null)
      .abortSignal(signal)
    ),
    // Every non-template scheduled day, for "Programmed Through" + 30-day
    // completion - same nested shape athlete.js's loadOverviewStats() uses
    fetchWithRetry((signal) => supabase
      .from('programs')
      .select('athlete_id, start_date, program_weeks(week_number, program_days(day_number, program_exercises(id, prescribed_sets)))')
      .eq('is_template', false)
      .abortSignal(signal)
    ),
    // Logged sets for the last 30 days only - completion rate never looks
    // further back than that
    fetchWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .select('athlete_id, program_exercise_id, date, completed_at, set_number')
      .gte('date', thirtyDaysAgo)
      .abortSignal(signal)
    ),
    // Rated sessions for ACWR - 90 days back, same window athlete.js uses
    fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('athlete_id, started_at, ended_at, session_rpe')
      .not('ended_at', 'is', null)
      .gte('started_at', ninetyDaysAgoISO)
      .abortSignal(signal)
    )
  ])

  if (error) {
    console.log('Error loading athletes:', error)
    customAlert('Something went wrong loading your athletes - check your connection and try again')
    return
  }

  allAthletes = data

  flaggedCountByAthlete = {}
  if (flaggedData) {
    for (const row of flaggedData) {
      flaggedCountByAthlete[row.athlete_id] = (flaggedCountByAthlete[row.athlete_id] || 0) + 1
    }
  }

  // Card stats are non-critical - if any of these 3 queries failed, cards
  // just show '—' instead of blocking the whole athlete list from loading
  if (programsError || logError || sessionsError) {
    console.log('Error loading card stats:', programsError || logError || sessionsError)
    athleteStatsById = {}
  } else {
    athleteStatsById = computeAthleteCardStats(programs, logSets, sessions, thirtyDaysAgo)
  }

  updateFilterCounts()
  applyFilters()
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
          const dateStr = resolveDateIdx(program.start_date, week.week_number, day.day_number)
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
      const dateStr = toDateStrIdx(new Date(s.started_at))
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

// Chip labels get a live count appended, e.g. "Active (3)" - STATUS_LABELS
// is declared further down this file, but this only ever runs from
// loadAthletes() (after an await), by which point the whole module has
// already finished its initial top-to-bottom pass, so it's defined in time.
function updateFilterCounts() {
  const counts = { active: 0, pending: 0, offline: 0, archived: 0 }
  allAthletes.forEach(a => { counts[athleteStatus(a)]++ })
  document.querySelectorAll('#athleteStatusFilter .chip-btn').forEach(btn => {
    const status = btn.dataset.status
    btn.textContent = `${STATUS_LABELS[status]} (${counts[status]})`
  })
}

function applyStatusFilter(status) {
  currentStatusFilter = status
  applyFilters()
}

// Re-renders the grid from the cached athlete list using both the status
// chip and the search box together (AND, not either/or) - no re-query for
// either one, matching how the status filter already worked before search
// was added.
function applyFilters() {
  document.querySelectorAll('#athleteStatusFilter .chip-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.status === currentStatusFilter)
  })

  const query = currentSearchQuery.trim().toLowerCase()
  const filtered = allAthletes.filter(a =>
    athleteStatus(a) === currentStatusFilter && (!query || a.name.toLowerCase().includes(query))
  )

  athleteGrid.innerHTML = ''
  if (filtered.length === 0) {
    athleteGrid.innerHTML = query ? '<p>No athletes match your search.</p>' : '<p>No athletes here yet.</p>'
    return
  }
  filtered.forEach(athlete => {
    createAthleteCard(athlete, flaggedCountByAthlete[athlete.id])
  })
}

document.getElementById('athleteStatusFilter').addEventListener('click', function(e) {
  const btn = e.target.closest('.chip-btn')
  if (btn) applyStatusFilter(btn.dataset.status)
})

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

  const card = document.createElement('div')
  card.classList.add('athlete-card')
card.innerHTML = `
    <div class="card-top">
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
        <div class="athlete-initials">${initials}</div>
        <span class="athlete-status-badge status-${status}">${STATUS_LABELS[status]}</span>
        ${flaggedCount ? `<span class="pain-flag-badge">🚩 ${flaggedCount > 1 ? flaggedCount + ' pain reports' : 'Pain reported'}</span>` : ''}
      </div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-athlete-id="${athlete.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${athlete.id}">
          ${status === 'pending' ? `
            <button class="kebab-item kebab-resend" data-athlete-id="${athlete.id}">✉️ Resend Invite</button>
            <button class="kebab-item kebab-copy-link" data-athlete-id="${athlete.id}">🔗 Copy Invite Link</button>
          ` : ''}
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
