// ==========================================================================
// SETUP — Supabase client + page state
// ==========================================================================
import { supabase } from './coachClient.js'

// Get athlete ID from URL
const params = new URLSearchParams(window.location.search)
const athleteId = params.get('id')

// Keep track of current metric being recorded
let currentMetric = null
let allMetrics = []
let athleteMetrics = []
let prEvents = [] // PRs broken in the last 30 days, filled in by loadStatsBar, read by the PR overview modal
let allMeasurementsCache = [] // every measurement for this athlete, filled in by loadStatsBar, read by the stats-bar detail modals
let metricsLoaded = false // Metrics tab loads its data lazily - see initTabs()
let currentAthlete = null // most recently loaded athletes row, read by the status badge + invite actions below

// Require a logged-in coach before loading anything (same gate as script.js -
// see the comment there for why this isn't real security yet on its own)
const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  // Overview tab is visible by default, so its data loads right away.
  // Metrics/Calendar tabs load lazily when first clicked - see initTabs()
  loadAthlete()
}

initTabs()

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'login.html'
})

// This page otherwise only loads stats once, on open - a coach watching an
// athlete log a workout live (in another tab, or on their phone) would never
// see it update without a manual reload. Refresh button covers "check right
// now"; the visibilitychange listener covers "I switched back to this tab" -
// same pattern already used athlete-side (see dashboard.js) for the same
// reason, just applied here to the coach's page-level script instead.
//
// Both are guarded: overviewLoadInFlight stops an overlapping call from
// firing a second, competing round of the same 3 queries (the exact
// mistake that caused the athlete-side statement-timeout bug this session -
// same fix, applied here before it became a problem instead of after).
// lastOverviewAutoRefresh additionally throttles the visibilitychange
// trigger specifically - flipping back and forth to another tab (e.g. the
// Supabase SQL editor) shouldn't re-fire this page's stats every single
// time. The Refresh button ignores that cooldown - tapping it is explicit
// intent and should always work immediately.
let overviewLoadInFlight = false
let lastOverviewAutoRefresh = 0

async function loadOverviewStatsGuarded() {
  if (overviewLoadInFlight) return
  overviewLoadInFlight = true
  try {
    await loadOverviewStats()
  } finally {
    overviewLoadInFlight = false
  }
}

document.getElementById('refreshOverviewBtn').addEventListener('click', function() {
  loadOverviewStatsGuarded()
})
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible' || !athleteId) return
  if (Date.now() - lastOverviewAutoRefresh < 15000) return
  lastOverviewAutoRefresh = Date.now()
  loadOverviewStatsGuarded()
})

// ==========================================================================
// ---- SETTINGS TAB ----
// Per-athlete settings save immediately on change, no separate Save button -
// this page is meant to be filled in once during onboarding and left alone.
// ==========================================================================
document.getElementById('settingsNextWeekToggle').addEventListener('change', async function(e) {
  const { error } = await supabase
    .from('athletes')
    .update({ can_preview_next_week: e.target.checked })
    .eq('id', athleteId)

  if (error) {
    console.log(error)
    customAlert('Something went wrong saving that setting')
    e.target.checked = !e.target.checked // revert the toggle visually
  }
})

document.getElementById('settingsSelfLogToggle').addEventListener('change', async function(e) {
  const { error } = await supabase
    .from('athletes')
    .update({ can_self_log_workouts: e.target.checked })
    .eq('id', athleteId)

  if (error) {
    console.log(error)
    customAlert('Something went wrong saving that setting')
    e.target.checked = !e.target.checked // revert the toggle visually
  }
})

document.getElementById('settingsAddExercisesToggle').addEventListener('change', async function(e) {
  const { error } = await supabase
    .from('athletes')
    .update({ can_add_exercises: e.target.checked })
    .eq('id', athleteId)

  if (error) {
    console.log(error)
    customAlert('Something went wrong saving that setting')
    e.target.checked = !e.target.checked
  }
})

document.getElementById('settingsChangeExercisesToggle').addEventListener('change', async function(e) {
  const { error } = await supabase
    .from('athletes')
    .update({ can_change_exercises: e.target.checked })
    .eq('id', athleteId)

  if (error) {
    console.log(error)
    customAlert('Something went wrong saving that setting')
    e.target.checked = !e.target.checked
  }
})

document.getElementById('settingsRescheduleToggle').addEventListener('change', async function(e) {
  const { error } = await supabase
    .from('athletes')
    .update({ can_reschedule_workouts: e.target.checked })
    .eq('id', athleteId)

  if (error) {
    console.log(error)
    customAlert('Something went wrong saving that setting')
    e.target.checked = !e.target.checked
  }
})

document.getElementById('settingsWeeklyStatsToggle').addEventListener('change', async function(e) {
  const { error } = await supabase
    .from('athletes')
    .update({ can_view_weekly_stats: e.target.checked })
    .eq('id', athleteId)

  if (error) {
    console.log(error)
    customAlert('Something went wrong saving that setting')
    e.target.checked = !e.target.checked
  }
})

// ==========================================================================
// ---- STATUS + INVITE ACTIONS ----
// active = linked to a real login, pending = coach has entered an email but
// the athlete hasn't signed up/linked yet, offline = no email on file yet,
// archived = coach hid them (overrides the other 3 regardless of link state).
// Mirrors athleteStatus()/sendInviteEmail()/buildInviteLink() in script.js -
// same shape, duplicated per this codebase's per-file convention.
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
  const badge = document.getElementById('profileStatusBadge')
  badge.textContent = STATUS_LABELS[status]
  badge.className = `athlete-status-badge status-${status}`

  document.getElementById('editAthleteInviteActions').style.display = status === 'pending' ? 'flex' : 'none'
}

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

document.getElementById('resendInviteBtn').addEventListener('click', async function() {
  if (!currentAthlete || !currentAthlete.email) return
  const error = await sendInviteEmail(currentAthlete.email, currentAthlete.name)
  customAlert(error ? 'Something went wrong sending the invite' : `Invite sent to ${currentAthlete.email}`)
})

document.getElementById('copyInviteLinkBtn').addEventListener('click', async function() {
  if (!currentAthlete) return
  await navigator.clipboard.writeText(buildInviteLink(currentAthlete.email, currentAthlete.name))
  customAlert('Invite link copied - paste it anywhere you like.')
})

// ==========================================================================
// ---- TABS ----
// Switches which .tab-panel is visible. Metrics data loads lazily, the first
// time that tab is clicked, not on page load - Chart.js sizes its canvases
// from their rendered pixel dimensions, so drawing graphs while a panel is
// still display:none would produce blank/squashed charts.
// ==========================================================================
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active')

      if (btn.dataset.tab === 'metrics' && !metricsLoaded) {
        metricsLoaded = true
        loadAllMetrics().then(() => loadAthleteMetrics())
      }

      if (btn.dataset.tab === 'calendar') {
        window.dispatchEvent(new CustomEvent('calendar-tab-activated'))
      }
    })
  })
}

// ==========================================================================
// ---- LOAD ATHLETE INFO ----
// Fetches the athlete's profile row and fills in the header (name, initials,
// age, height), sets the page title, wires up the "edit info" button, and
// kicks off the bodyweight graph load.
// ==========================================================================
async function loadAthlete() {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('athletes')
    .select('*')
    .eq('id', athleteId)
    .single()
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading athlete:', error)
    customAlert('Something went wrong loading this athlete - check your connection and try again')
    return
  }

  currentAthlete = data

  // Calculate age from date of birth
  const dob = new Date(data.date_of_birth)
  const age = Math.floor((new Date() - dob) / (365.25 * 24 * 60 * 60 * 1000))

  // Fill in profile header
  const initials = data.name.split(' ').map(w => w[0]).join('').toUpperCase()
  document.getElementById('profileInitials').textContent = initials
  document.getElementById('profileName').textContent = data.name
document.getElementById('profileDetails').textContent =
    `${data.gender} · ${age} years old · ${data.height}cm`
  updateStatusUI(data)

  document.title = `${data.name} — TBFlog`

  // Show the most recent dated note in the header
  loadLatestNote()

  // Settings tab - populated here (not lazily) since it's just these
  // fields already loaded above, no chart-canvas-sizing concern like Metrics
  document.getElementById('settingsNextWeekToggle').checked = !!data.can_preview_next_week
  document.getElementById('settingsSelfLogToggle').checked = !!data.can_self_log_workouts
  document.getElementById('settingsAddExercisesToggle').checked = !!data.can_add_exercises
  document.getElementById('settingsChangeExercisesToggle').checked = !!data.can_change_exercises
  document.getElementById('settingsRescheduleToggle').checked = !!data.can_reschedule_workouts
  document.getElementById('settingsWeeklyStatsToggle').checked = !!data.can_view_weekly_stats

 // Edit info button
  document.getElementById('editAthleteBtn').addEventListener('click', function() {
    document.getElementById('editAthleteName').value = data.name
    document.getElementById('editAthleteDOB').value = data.date_of_birth
    document.getElementById('editAthleteGender').value = data.gender
    document.getElementById('editAthleteHeight').value = data.height
    document.getElementById('editAthleteEmail').value = data.email || ''
    document.getElementById('editAthleteModal').classList.add('active')
  })

  // Load bodyweight graph
  loadBodyweightGraph()

  // Training completion + volume stats
  loadOverviewStats()
}

// ==========================================================================
// ---- OVERVIEW STATS: completion rate + volume ----
// Computed from this athlete's schedule (programs -> ... -> program_exercises)
// and their logged exercise_log_sets. Same nested-query shape and date math
// athlete-calendar.js/dashboard.js use, duplicated here since this is a
// separate module with no shared scope.
// ==========================================================================
function toDateStrOv(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseDateStrOv(dateStr) {
  return new Date(dateStr + 'T00:00:00')
}

function resolveDateOv(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStrOv(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStrOv(result)
}

function addDaysOv(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function daysBetweenDateStrsOv(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000)
}

function startOfWeekOv(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day // shift back to Monday
  d.setDate(d.getDate() + diff)
  return d
}

// Weight x reps for one logged set - 0 if incomplete, unweighted, or the
// reps didn't parse as a plain number (duration text, unedited "8-12" ranges)
function setVolumeOv(s) {
  if (!s.completed_at || s.actual_weight == null) return 0
  const reps = parseInt(s.actual_reps)
  return isNaN(reps) ? 0 : reps * s.actual_weight
}

// Same is_adhoc/label fallback used everywhere else a training's display
// name is derived (athlete-calendar.js, dashboard.js)
function trainingDisplayNameOv(program, day) {
  if (program.is_adhoc) return program.name || 'Workout'
  return day.label || ('Day ' + day.day_number)
}

function formatDurationOv(minutes) {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

let volumeChart = null
let volumeChartData = { labels: [], values: [] }
let durationEvents = [] // { dateStr, name, minutes }, filled in by loadOverviewStats, read by the duration detail modal

// Training load (Foster's session-RPE method) - all filled in by
// loadOverviewStats, read by the 4 detail modals below
let last7DailyLoad = [] // { dateStr, load }, oldest first
let acuteLoadValue = 0
let chronicLoadValue = 0
let acwrValue = null
let monotonyValue = null
let strainValue = null
let daysOfLoadHistoryValue = 0 // how many days back the earliest rated session goes - read by the ACWR modal's "building history" note

// PDF Progress Report - all filled in fresh every time the Report Builder
// modal opens (no saved template), see fetchReportData()/generateReportPDF() below
let reportDataCache = null
let reportSelectedSections = new Set()
let reportSelectedMonths = 3

async function loadOverviewStats() {
  const ninetyDaysAgo = toDateStrOv(addDaysOv(new Date(), -89))
  const ninetyDaysAgoISO = addDaysOv(new Date(), -89).toISOString()

  // These 3 queries don't depend on each other's results, so they fire
  // together instead of waiting on each other one at a time - this alone
  // cuts this page's load time roughly in half to a third. Each also goes
  // through fetchWithRetry (network-retry.js) so a slow/flaky connection
  // gets a couple of automatic retries instead of these stats just staying
  // blank with no explanation.
  const [
    { data: programs, error: programsError },
    { data: logSets, error: logError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    fetchWithRetry((signal) => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises!exercise_id(tracks_weight))))')
      .eq('athlete_id', athleteId)
      .eq('is_template', false)
      .abortSignal(signal)
    ),
    fetchWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .select('*')
      .eq('athlete_id', athleteId)
      .gte('date', ninetyDaysAgo)
      .abortSignal(signal)
    ),
    fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('*')
      .eq('athlete_id', athleteId)
      .not('ended_at', 'is', null)
      .gte('started_at', ninetyDaysAgoISO)
      .order('started_at', { ascending: false })
      .abortSignal(signal)
    )
  ])

  if (programsError) { console.log('Error loading schedule for stats:', programsError); customAlert('Something went wrong loading this athlete\'s stats - check your connection and try again'); return }
  if (logError) { console.log('Error loading logged sets for stats:', logError); customAlert('Something went wrong loading this athlete\'s stats - check your connection and try again'); return }
  if (sessionsError) { console.log('Error loading sessions for stats:', sessionsError); customAlert('Something went wrong loading this athlete\'s stats - check your connection and try again'); return }

  // One entry per program_days row - i.e. per workout, not per calendar
  // date. Two workouts landing on the same date (an assigned program day
  // plus an ad-hoc training, say) stay separate here so completion rate
  // counts them as two workouts, not one merged day. dayInfoById remembers
  // each workout's date + display name so a workout_sessions row (which
  // only has a program_day_id) can be labeled in the duration list below.
  const workoutEntries = [] // { dateStr, exercises }
  const dayInfoById = {}
  // Every program_exercise whose underlying exercise tracks weight - volume
  // only makes sense for weight-bearing sets, so it's scoped to just these
  // (tracks_weight is independent of Timed/Plyometric now, so a weighted
  // timed hold still counts, but a bodyweight-only exercise doesn't)
  const weightsPEIds = new Set()
  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        const dateStr = day.date_override || resolveDateOv(program.start_date, week.week_number, day.day_number)
        workoutEntries.push({ dateStr, exercises: day.program_exercises })
        dayInfoById[day.id] = { dateStr, name: trainingDisplayNameOv(program, day) }
        for (const pe of day.program_exercises) {
          if (pe.exercises && pe.exercises.tracks_weight) weightsPEIds.add(pe.id)
        }
      }
    }
  }

  const logSetsByPE = {}
  for (const row of logSets) {
    if (!logSetsByPE[row.program_exercise_id]) logSetsByPE[row.program_exercise_id] = []
    logSetsByPE[row.program_exercise_id].push(row)
  }

  // ---- Completion rate: scheduled workouts where at least half the
  // prescribed sets got logged, divided by scheduled workouts in the
  // window - counted per workout (per program_days row), not per calendar
  // date, so a day with two separate trainings counts as two, not one.
  // Set-level within a workout (not "every exercise finished") so 2 fully
  // done exercises plus 1 barely started still gets fair partial credit.
  // Workouts with no exercises don't count toward either side. Today's
  // workout(s) only count once actually done - the day isn't over yet, so
  // an unfinished/not-yet-started workout scheduled for today shouldn't
  // drag the rate down as if it had been missed.
  function completionRate(windowDays) {
    const cutoff = toDateStrOv(addDaysOv(new Date(), -(windowDays - 1)))
    const todayStr = toDateStrOv(new Date())
    let scheduled = 0
    let completed = 0

    for (const entry of workoutEntries) {
      if (entry.dateStr < cutoff || entry.dateStr > todayStr) continue
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

    return scheduled === 0 ? null : Math.round((completed / scheduled) * 100)
  }

  const rate30 = completionRate(30)
  const rate60 = completionRate(60)
  const rate90 = completionRate(90)

  document.getElementById('statCompletion').textContent = rate30 === null ? '—' : `${rate30}%`
  document.getElementById('statCompletion30').textContent = rate30 === null ? '—' : `${rate30}%`
  document.getElementById('statCompletion60').textContent = rate60 === null ? '—' : `${rate60}%`
  document.getElementById('statCompletion90').textContent = rate90 === null ? '—' : `${rate90}%`

  // ---- Volume (weights exercises only - see weightsPEIds above) ----
  const sevenDaysAgo = toDateStrOv(addDaysOv(new Date(), -6))
  const volume7d = logSets
    .filter(s => s.date >= sevenDaysAgo && weightsPEIds.has(s.program_exercise_id))
    .reduce((sum, s) => sum + setVolumeOv(s), 0)

  document.getElementById('statVolume').textContent = `${Math.round(volume7d).toLocaleString()}kg`

  // Weekly buckets for the trend chart, oldest of the last 12 weeks first
  const weeklyVolume = {} // 'YYYY-MM-DD' (week start) -> kg
  for (const s of logSets) {
    if (!weightsPEIds.has(s.program_exercise_id)) continue
    const weekStart = toDateStrOv(startOfWeekOv(parseDateStrOv(s.date)))
    weeklyVolume[weekStart] = (weeklyVolume[weekStart] || 0) + setVolumeOv(s)
  }

  const labels = []
  const values = []
  const currentWeekStart = startOfWeekOv(new Date())
  for (let i = 11; i >= 0; i--) {
    const weekStart = addDaysOv(currentWeekStart, -7 * i)
    labels.push(weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
    values.push(Math.round(weeklyVolume[toDateStrOv(weekStart)] || 0))
  }
  volumeChartData = { labels, values }

  // ---- Duration: completed workout_sessions rows only (still-open sessions
  // have no ended_at yet, nothing to measure) ----
  durationEvents = sessions.map(s => {
    const info = dayInfoById[s.program_day_id]
    const minutes = Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 60000)
    return { dateStr: info ? info.dateStr : s.local_date, name: info ? info.name : 'Workout', minutes }
  })

  const thirtyDaysAgo = toDateStrOv(addDaysOv(new Date(), -29))
  const recentDurations = durationEvents.filter(e => e.dateStr >= thirtyDaysAgo).map(e => e.minutes)
  const avgMinutes = recentDurations.length
    ? Math.round(recentDurations.reduce((sum, m) => sum + m, 0) / recentDurations.length)
    : null

  document.getElementById('statDuration').textContent = avgMinutes === null ? '—' : formatDurationOv(avgMinutes)

  // ---- Training Load (Foster's session-RPE method: RPE x duration) ----
  // sessions already covers a 90-day window with session_rpe included
  // (select('*') above) - no extra query needed.
  const dailyLoad = {} // dateStr -> summed session_load that day
  for (const s of sessions) {
    if (s.session_rpe == null) continue // no rating entered - excluded, not treated as 0
    const dateStr = s.local_date
    const minutes = (new Date(s.ended_at) - new Date(s.started_at)) / 60000
    dailyLoad[dateStr] = (dailyLoad[dateStr] || 0) + s.session_rpe * minutes
  }

  function loadSum(days) {
    const cutoff = toDateStrOv(addDaysOv(new Date(), -(days - 1)))
    const todayStr = toDateStrOv(new Date())
    return Object.entries(dailyLoad)
      .filter(([d]) => d >= cutoff && d <= todayStr)
      .reduce((sum, [, v]) => sum + v, 0)
  }

  // ACWR only means something once there's a real 4-week baseline to compare
  // against - with less than 28 days of rated-session history, loadSum(28)/4
  // divides a partial sum by 4 as if a full chronic period had passed,
  // understating the baseline and inflating the ratio. Held back as "—"
  // until enough history exists, rather than showing a falsely high number.
  const loadDates = Object.keys(dailyLoad).sort()
  daysOfLoadHistoryValue = loadDates.length ? daysBetweenDateStrsOv(loadDates[0], toDateStrOv(new Date())) + 1 : 0
  const hasEnoughHistoryForAcwr = daysOfLoadHistoryValue >= 28

  acuteLoadValue = loadSum(7)
  chronicLoadValue = hasEnoughHistoryForAcwr ? loadSum(28) / 4 : 0
  acwrValue = (hasEnoughHistoryForAcwr && chronicLoadValue > 0) ? acuteLoadValue / chronicLoadValue : null
  const highRisk = acwrValue !== null && acwrValue > 1.5

  // Rest days count as 0, not skipped - monotony measures variation across
  // the whole week, and a rest day lowering it is the entire point
  last7DailyLoad = []
  for (let i = 6; i >= 0; i--) {
    const dateStr = toDateStrOv(addDaysOv(new Date(), -i))
    last7DailyLoad.push({ dateStr, load: dailyLoad[dateStr] || 0 })
  }
  const mean7 = last7DailyLoad.reduce((sum, d) => sum + d.load, 0) / 7
  const stddev7 = Math.sqrt(last7DailyLoad.reduce((sum, d) => sum + (d.load - mean7) ** 2, 0) / 7)
  monotonyValue = stddev7 > 0 ? mean7 / stddev7 : null
  strainValue = monotonyValue !== null ? acuteLoadValue * monotonyValue : null

  document.getElementById('statWeeklyLoad').textContent = acuteLoadValue > 0 ? Math.round(acuteLoadValue).toLocaleString() : '—'
  document.getElementById('statAcwr').textContent = acwrValue === null ? '—' : acwrValue.toFixed(2)
  const acwrRiskBadge = document.getElementById('statAcwrRisk')
  if (highRisk) {
    acwrRiskBadge.textContent = 'High Risk'
    acwrRiskBadge.className = 'stat-risk-badge'
    acwrRiskBadge.style.display = 'inline-block'
  } else if (!hasEnoughHistoryForAcwr && loadDates.length > 0) {
    acwrRiskBadge.textContent = 'Building History'
    acwrRiskBadge.className = 'stat-risk-badge neutral'
    acwrRiskBadge.style.display = 'inline-block'
  } else {
    acwrRiskBadge.style.display = 'none'
  }
  document.getElementById('statMonotony').textContent = monotonyValue === null ? '—' : monotonyValue.toFixed(2)
  document.getElementById('statStrain').textContent = strainValue === null ? '—' : Math.round(strainValue).toLocaleString()

  renderPainReports(sessions, dayInfoById)

  const updatedLabel = document.getElementById('overviewUpdatedLabel')
  if (updatedLabel) updatedLabel.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// The Overview tab's pain/injury inbox - unreviewed reports only (see
// wireRpeFlagFollowup in athlete-app/dashboard.js for how these get set).
// Reuses the same 90-day `sessions` fetch loadOverviewStats already made -
// no extra query. Known limitation, same as every other stat on this tab:
// a report older than that window with no coach visit in the meantime
// ages out of this list silently.
function renderPainReports(sessions, dayInfoById) {
  const section = document.getElementById('painReportsSection')
  const list = document.getElementById('painReportsList')
  const reports = sessions.filter(s => s.rpe_flag_reason === 'pain_injury' && !s.rpe_flag_reviewed_at)

  if (reports.length === 0) {
    section.style.display = 'none'
    return
  }

  section.style.display = 'block'
  list.innerHTML = reports.map(s => {
    const info = dayInfoById[s.program_day_id]
    const dateStr = info ? info.dateStr : s.local_date
    const name = info ? info.name : 'Workout'
    return `
      <div class="pain-report-row">
        <div class="pain-report-meta">${formatDisplayDate(dateStr)} — ${name} · RPE ${s.session_rpe}/10</div>
        <p class="pain-report-note">${escapeHtml(s.rpe_flag_note) || '<em>No description given</em>'}</p>
        <button type="button" class="unit-btn pain-report-review-btn" data-session-id="${s.id}">Mark Reviewed</button>
      </div>
    `
  }).join('')

  list.querySelectorAll('.pain-report-review-btn').forEach(btn => {
    btn.addEventListener('click', async function() {
      const row = btn.closest('.pain-report-row')
      btn.disabled = true
      btn.textContent = 'Marking...'

      const { error } = await supabase
        .from('workout_sessions')
        .update({ rpe_flag_reviewed_at: new Date().toISOString() })
        .eq('id', btn.dataset.sessionId)

      if (error) {
        console.log(error)
        customAlert('Something went wrong - please try again')
        btn.disabled = false
        btn.textContent = 'Mark Reviewed'
        return
      }

      row.remove()
      if (list.children.length === 0) section.style.display = 'none'
    })
  })
}

// Only used for user-entered free text rendered via innerHTML (the
// pain/injury note above) - every other string on this tab is either
// coach-authored or a fixed option, so this isn't applied everywhere
function escapeHtml(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// Opened by clicking the "Avg Duration (30d)" stat tile. Individual
// completed sessions (durationEvents, filled in by loadOverviewStats above),
// most recent first - a trend chart would hide which specific day ran long
function renderDurationModal() {
  const container = document.getElementById('durationList')

  if (durationEvents.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No completed workouts logged yet</p>'
    return
  }

  container.innerHTML = `
    <ul class="detail-list">
      ${durationEvents.map(e => `
        <li class="detail-row">
          <span>${e.dateStr} — ${e.name}</span>
          <span class="detail-row-value">${formatDurationOv(e.minutes)}</span>
        </li>
      `).join('')}
    </ul>
  `
}

document.getElementById('statDurationCard').addEventListener('click', function() {
  document.getElementById('durationDetailModal').classList.add('active')
  renderDurationModal()
})

document.getElementById('closeDurationModalBtn').addEventListener('click', function() {
  document.getElementById('durationDetailModal').classList.remove('active')
})

document.getElementById('statCompletionCard').addEventListener('click', function() {
  document.getElementById('completionDetailModal').classList.add('active')
})

document.getElementById('closeCompletionModalBtn').addEventListener('click', function() {
  document.getElementById('completionDetailModal').classList.remove('active')
})

// Chart.js sizes its canvas from rendered pixel dimensions, so it's only
// drawn once the modal is actually visible - same reasoning as the Metrics
// tab's lazy chart loading (see initTabs())
document.getElementById('statVolumeCard').addEventListener('click', function() {
  document.getElementById('volumeDetailModal').classList.add('active')

  const canvas = document.getElementById('volumeChart')
  const noDataMsg = document.getElementById('noVolumeMsg')
  const hasData = volumeChartData.values.some(v => v > 0)

  if (!hasData) {
    canvas.style.display = 'none'
    noDataMsg.style.display = 'block'
    return
  }

  canvas.style.display = 'block'
  noDataMsg.style.display = 'none'

  if (volumeChart) volumeChart.destroy()

  volumeChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: volumeChartData.labels,
      datasets: [{
        data: volumeChartData.values,
        backgroundColor: '#4a4a8e'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#aaaacc', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#aaaacc', font: { size: 10 } }, grid: { color: '#2a2a4e' } }
      }
    }
  })
})

document.getElementById('closeVolumeModalBtn').addEventListener('click', function() {
  document.getElementById('volumeDetailModal').classList.remove('active')
})

// ==========================================================================
// ---- TRAINING LOAD MODALS ----
// Weekly Load / ACWR / Monotony / Strain - all derived from
// last7DailyLoad/acuteLoadValue/chronicLoadValue/acwrValue/monotonyValue/
// strainValue, filled in by loadOverviewStats above. Same
// stat-item-clickable -> modal-overlay pattern as Duration/Completion/
// Volume above.
// ==========================================================================
function renderWeeklyLoadModal() {
  const container = document.getElementById('weeklyLoadList')
  container.innerHTML = `
    <ul class="detail-list">
      ${last7DailyLoad.map(d => `
        <li class="detail-row">
          <span>${d.dateStr}</span>
          <span class="detail-row-value">${d.load > 0 ? Math.round(d.load).toLocaleString() : '—'}</span>
        </li>
      `).join('')}
    </ul>
  `
}

document.getElementById('statWeeklyLoadCard').addEventListener('click', function() {
  document.getElementById('weeklyLoadDetailModal').classList.add('active')
  renderWeeklyLoadModal()
})

document.getElementById('closeWeeklyLoadModalBtn').addEventListener('click', function() {
  document.getElementById('weeklyLoadDetailModal').classList.remove('active')
})

document.getElementById('statAcwrCard').addEventListener('click', function() {
  document.getElementById('acwrDetailModal').classList.add('active')
  document.getElementById('statAcuteLoad').textContent = acuteLoadValue > 0 ? Math.round(acuteLoadValue).toLocaleString() : '—'
  document.getElementById('statChronicLoad').textContent = chronicLoadValue > 0 ? Math.round(chronicLoadValue).toLocaleString() : '—'
  document.getElementById('statAcwrDetail').textContent = acwrValue === null ? '—' : acwrValue.toFixed(2)
  const acwrNote = document.getElementById('acwrInsufficientNote')
  if (acwrValue === null && daysOfLoadHistoryValue > 0 && daysOfLoadHistoryValue < 28) {
    acwrNote.textContent = `Needs 28 days of rated training history to calculate a reliable ratio — ${daysOfLoadHistoryValue} day${daysOfLoadHistoryValue === 1 ? '' : 's'} so far.`
    acwrNote.style.display = 'block'
  } else {
    acwrNote.style.display = 'none'
  }
})

document.getElementById('closeAcwrModalBtn').addEventListener('click', function() {
  document.getElementById('acwrDetailModal').classList.remove('active')
})

document.getElementById('statMonotonyCard').addEventListener('click', function() {
  document.getElementById('monotonyDetailModal').classList.add('active')
})

document.getElementById('closeMonotonyModalBtn').addEventListener('click', function() {
  document.getElementById('monotonyDetailModal').classList.remove('active')
})

document.getElementById('statStrainCard').addEventListener('click', function() {
  document.getElementById('strainDetailModal').classList.add('active')
})

document.getElementById('closeStrainModalBtn').addEventListener('click', function() {
  document.getElementById('strainDetailModal').classList.remove('active')
})

// ==========================================================================
// ---- ATHLETE NOTES ----
// Dated notes log: each "Add" creates a new row in athlete_notes (never
// overwrites), so past notes stay visible with the date they were written.
// Mirrors the Bodyweight pattern - a "latest entry" preview in the header,
// full history + edit/delete in the "View all" modal.
// ==========================================================================
let currentNoteEntry = null

// Shows the single most recent note in the profile header
async function loadLatestNote() {
  const { data } = await supabase
    .from('athlete_notes')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })
    .limit(1)

  const preview = document.getElementById('latestNotePreview')

  if (!data || data.length === 0) {
    preview.innerHTML = '<p class="no-bodyweight-data">No notes yet</p>'
    return
  }

  const latest = data[0]
  preview.innerHTML = `
    <p class="latest-note-date">${formatDisplayDate(latest.date)}</p>
    <p class="latest-note-text">${latest.note}</p>
  `
}

document.getElementById('addNoteBtn').addEventListener('click', function() {
  document.getElementById('noteDate').valueAsDate = new Date()
  document.getElementById('noteText').value = ''
  document.getElementById('addNoteModal').classList.add('active')
})

document.getElementById('closeAddNoteBtn').addEventListener('click', function() {
  document.getElementById('addNoteModal').classList.remove('active')
})

document.getElementById('cancelAddNoteBtn').addEventListener('click', function() {
  document.getElementById('addNoteModal').classList.remove('active')
})

document.getElementById('saveNoteBtn').addEventListener('click', async function() {
  const date = document.getElementById('noteDate').value
  const note = document.getElementById('noteText').value.trim()

  if (!date || !note) { customAlert('Please fill in date and note'); return }

  const { error } = await supabase
    .from('athlete_notes')
    .insert([{ athlete_id: parseInt(athleteId), date, note }])

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  document.getElementById('addNoteModal').classList.remove('active')
  loadLatestNote()
})

document.getElementById('viewNotesBtn').addEventListener('click', function() {
  document.getElementById('notesListModal').classList.add('active')
  loadNotesList()
})

document.getElementById('closeNotesListBtn').addEventListener('click', function() {
  document.getElementById('notesListModal').classList.remove('active')
})

// Fetches and renders every note for this athlete, newest first
async function loadNotesList() {
  const { data } = await supabase
    .from('athlete_notes')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })

  const list = document.getElementById('notesList')

  if (!data || data.length === 0) {
    list.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No notes yet</p>'
    return
  }

  list.innerHTML = data.map(n => `
    <div class="note-entry">
      <div class="note-entry-header">
        <span class="note-entry-date">${formatDisplayDate(n.date)}</span>
        <div>
          <button class="btn-edit-entry" data-note-id="${n.id}">✏</button>
          <button class="btn-delete-measurement" data-note-id="${n.id}">🗑</button>
        </div>
      </div>
      <p class="note-entry-text">${n.note}</p>
    </div>
  `).join('')

  list.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', function() {
      const noteId = parseInt(this.dataset.noteId)
      currentNoteEntry = data.find(n => n.id === noteId)
      document.getElementById('editNoteDate').value = currentNoteEntry.date
      document.getElementById('editNoteText').value = currentNoteEntry.note
      document.getElementById('editNoteModal').classList.add('active')
    })
  })

  list.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const noteId = parseInt(this.dataset.noteId)
      if (!(await customConfirm('Delete this note?'))) return

      const { error } = await supabase
        .from('athlete_notes')
        .delete()
        .eq('id', noteId)

      if (error) { customAlert('Something went wrong'); return }

      loadNotesList()
      loadLatestNote()
    })
  })
}

document.getElementById('cancelEditNoteBtn').addEventListener('click', function() {
  document.getElementById('editNoteModal').classList.remove('active')
})

document.getElementById('saveEditNoteBtn').addEventListener('click', async function() {
  const date = document.getElementById('editNoteDate').value
  const note = document.getElementById('editNoteText').value.trim()

  if (!date || !note) { customAlert('Please fill in date and note'); return }

  const { error } = await supabase
    .from('athlete_notes')
    .update({ date, note })
    .eq('id', currentNoteEntry.id)

  if (error) { customAlert('Something went wrong'); return }

  document.getElementById('editNoteModal').classList.remove('active')
  loadNotesList()
  loadLatestNote()
})

// ==========================================================================
// ---- UNIT CONVERSION HELPERS ----
// Converts stored values (always in a base unit, e.g. cm) into whatever
// display unit the user has chosen (in / ft), and back again for saving.
// ==========================================================================
function convertValue(value, displayUnit) {
  if (!displayUnit || !value) return { text: value, unit: displayUnit || '' }

  if (displayUnit === 'in') {
    const inches = (value / 2.54).toFixed(1)
    return { text: inches, unit: 'in' }
  }

  if (displayUnit === 'ft') {
    const totalInches = value / 2.54
    const feet = Math.floor(totalInches / 12)
    const inches = Math.round(totalInches % 12)
    return { text: `${feet}'${inches}"`, unit: '' }
  }

  return { text: value, unit: displayUnit }
}

function convertInput(value, displayUnit) {
  if (!displayUnit || !value) return value
  if (displayUnit === 'in') return +(value * 2.54).toFixed(1)
  if (displayUnit === 'ft') return +(value * 30.48).toFixed(1)
  return value
}
// ==========================================================================
// ---- LOAD ALL AVAILABLE METRICS ----
// Loads the full catalog of metric types (e.g. "Vertical Jump", "Zone 2 Run")
// from the DB and populates the "add metric" dropdown with them.
// ==========================================================================
async function loadAllMetrics() {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('metrics')
    .select('*')
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading metrics:', error)
    customAlert('Something went wrong loading metrics - check your connection and try again')
    return
  }

allMetrics = data

  // Fill the metric dropdown
  const select = document.getElementById('metricSelect')
  data.forEach(metric => {
    const option = document.createElement('option')
    option.value = metric.id
    option.textContent = `${metric.name} (${metric.unit})`
    select.appendChild(option)
  })
}

// ==========================================================================
// ---- LOAD ATHLETE'S ASSIGNED METRICS ----
// Loads only the metrics this specific athlete is being tracked on, joins in
// the metric definition (name/unit/type) from allMetrics, then renders them.
// ==========================================================================
async function loadAthleteMetrics() {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('athlete_metrics')
    .select('*')
    .eq('athlete_id', athleteId)
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading athlete metrics:', error)
    customAlert('Something went wrong loading tracked metrics - check your connection and try again')
    return
  }

  // Add metric details to each athlete_metric
  athleteMetrics = data.map(am => {
    return {
      ...am,
      metrics: allMetrics.find(m => m.id === am.metric_id)
    }
  })
  renderMetrics()
  loadStatsBar()
}

// ==========================================================================
// ---- RENDER METRICS ON SCREEN ----
// The big one: builds the metrics grid, grouped by category. For each
// metric it loads recent measurements, works out the "latest value" text,
// computes a % change badge, draws the mini graph, and wires up all the
// buttons (record / delete / open details) for that card.
// ==========================================================================
 async function renderMetrics() {
  const list = document.getElementById('metricsList')
  list.innerHTML = ''

  if (athleteMetrics.length === 0) {
    list.innerHTML = '<p class="no-metrics">No metrics added yet — click "+ Add Metric" to start tracking!</p>'
    return
  }

  // Every tracked metric's last 3 months of measurements, fetched in ONE
  // query instead of one query per metric (and reused below for the
  // mini-graphs too, instead of fetching the exact same data a second
  // time) - this used to be up to 2-3 sequential database round-trips per
  // tracked metric, which made this tab noticeably slow to open with more
  // than a few metrics tracked.
  const metricIds = athleteMetrics.map(am => am.metrics.id)
  const threeMonthsAgo = new Date()
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
  const fromDate = threeMonthsAgo.toISOString().split('T')[0]

  const { data: recentMeasurements } = await fetchWithRetry((signal) => supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .in('metric_id', metricIds)
    .gte('date', fromDate)
    .order('date', { ascending: true })
    .abortSignal(signal)
  )

  const measurementsByMetric = {}
  for (const m of recentMeasurements || []) {
    if (!measurementsByMetric[m.metric_id]) measurementsByMetric[m.metric_id] = []
    measurementsByMetric[m.metric_id].push(m)
  }

  // Zone2 metrics need their FULL history (not just 3 months) for the
  // 30-vs-60-day comparison below - same one-query-for-everyone approach,
  // and only run at all if there's actually a Zone2 metric tracked
  const zone2MetricIds = athleteMetrics.filter(am => am.metrics.type === 'zone2').map(am => am.metrics.id)
  const zone2AllByMetric = {}
  if (zone2MetricIds.length > 0) {
    const { data: allZone2Measurements } = await fetchWithRetry((signal) => supabase
      .from('measurements')
      .select('*')
      .eq('athlete_id', athleteId)
      .in('metric_id', zone2MetricIds)
      .order('date', { ascending: false })
      .abortSignal(signal)
    )

    for (const m of allZone2Measurements || []) {
      if (!zone2AllByMetric[m.metric_id]) zone2AllByMetric[m.metric_id] = []
      zone2AllByMetric[m.metric_id].push(m)
    }
  }

  // Group metrics by category
  const categories = {}
  for (const am of athleteMetrics) {
    const category = am.metrics?.category || 'Other'
    if (!categories[category]) categories[category] = []
    categories[category].push(am)
  }

  // Render each category
  for (const [category, items] of Object.entries(categories)) {
    const categorySection = document.createElement('div')
    categorySection.classList.add('metric-category')
    categorySection.innerHTML = `<h4 class="category-title">${category}</h4>`

    const grid = document.createElement('div')
    grid.classList.add('metrics-grid')

    for (const am of items) {
      const metric = am.metrics
      const measurements = measurementsByMetric[metric.id] || []

      const item = document.createElement('div')
      item.classList.add('metric-item')
      item.dataset.metricId = metric.id

     const latest = measurements.length > 0 ? measurements[measurements.length - 1] : null
      let latestText = 'No measurements yet'
      let changeHTML = ''

      if (latest) {
        // --- Build the "Latest: ..." text, differently per metric type ---
        if (metric.type === 'pogo') {
          const converted = convertValue(latest.height, metric.display_unit)
          latestText = `Height: ${converted.text}${converted.unit} · GCT: ${latest.ground_contact}ms · RSI: ${latest.rsi}`
        } else if (metric.type === 'zone2') {
          latestText = `Score: ${latest.value}`
        } else {
          const converted = convertValue(latest.value, metric.display_unit)
          latestText = `${converted.text} ${converted.unit}`
        }

        // --- Calculate % change badge (▲/▼ x%) shown next to the metric name ---
        if (metric.type === 'zone2') {
          // Zone2: compare average score of last 30 days vs the 30 days before that
          const allZone2 = zone2AllByMetric[metric.id] || []

          if (allZone2.length >= 2) {
            const now = new Date()
            const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
            const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

            const last30 = allZone2.filter(m => m.date >= thirtyDaysAgo)
            const prev30 = allZone2.filter(m => m.date >= sixtyDaysAgo && m.date < thirtyDaysAgo)

            if (last30.length > 0 && prev30.length > 0) {
              const avg30 = last30.reduce((sum, m) => sum + m.value, 0) / last30.length
              const avgPrev = prev30.reduce((sum, m) => sum + m.value, 0) / prev30.length
              const pct = +(((avg30 - avgPrev) / avgPrev) * 100).toFixed(1)
              const isPositive = metric.higher_is_better ? pct > 0 : pct < 0
              const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
              const arrow = pct > 0 ? '▲' : '▼'
changeHTML = `<span class="metric-change ${cssClass}" style="cursor:pointer" data-explain-type="zone2" data-metric-type="${metric.type}" data-metric-name="${metric.name}" data-avg30="${avg30.toFixed(3)}" data-avgprev="${avgPrev.toFixed(3)}" data-pct="${pct}" data-higher="${metric.higher_is_better}">${arrow} ${Math.abs(pct)}%</span>`            }
          }
        } else {
          // All other metric types: compare latest value vs avg of previous 5 entries
          const getValue = m => metric.type === 'pogo' ? m.rsi : m.value
          const latestVal = getValue(latest)

          if (measurements.length >= 2) {
            const previous = measurements.slice(0, -1).slice(-5)
            const avgPrev = previous.reduce((sum, m) => sum + getValue(m), 0) / previous.length
            const pct = +(((latestVal - avgPrev) / avgPrev) * 100).toFixed(1)
            const isPositive = metric.higher_is_better ? pct > 0 : pct < 0
            const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
            const arrow = pct > 0 ? '▲' : '▼'
changeHTML = `<span class="metric-change ${cssClass}" style="cursor:pointer" data-explain-type="simple" data-metric-type="${metric.type}" data-metric-name="${metric.name}" data-latest="${latestVal}" data-avgprev="${avgPrev.toFixed(3)}" data-pct="${pct}" data-higher="${metric.higher_is_better}" data-unit="${metric.display_unit || metric.unit}">${arrow} ${Math.abs(pct)}%</span>`          }
        }
      }

      // --- Build the card's HTML: header, latest value, mini-graph placeholder ---
      item.innerHTML = `
        <div class="metric-item-header">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
            <h4>${metric.name}</h4>
            ${changeHTML}
          </div>
          <div style="display:flex; align-items:center; gap:8px">
            <button class="btn-record" data-metric-id="${metric.id}">+ Record</button>
            <button class="btn-delete-metric" data-athlete-metric-id="${am.id}">🗑</button>
          </div>
        </div>
        <p class="metric-latest">Latest: ${latestText}</p>
        <div class="metric-graph-area">
          ${measurements && measurements.length > 1 ? `
            <canvas id="mini-graph-${metric.id}"></canvas>
            <p class="graph-hint">Click to expand</p>
          ` : '<p style="color:#4a4a8e;font-size:12px">Add 2+ measurements to see graph</p>'}
        </div>
      `

      grid.appendChild(item)
    }

    categorySection.appendChild(grid)
    list.appendChild(categorySection)
  }

  // --- Wire up "+ Record" buttons: open the measurement modal for that metric ---
  document.querySelectorAll('.btn-record').forEach(btn => {
    btn.addEventListener('click', function() {
      const metricId = parseInt(this.dataset.metricId)
      currentMetric = allMetrics.find(m => m.id === metricId)
      openMeasurementModal()
    })
  })

  // --- Wire up "delete metric" buttons: unassign a metric from this athlete ---
  document.querySelectorAll('.btn-delete-metric').forEach(btn => {
    btn.addEventListener('click', async function() {
      const athleteMetricId = parseInt(this.dataset.athleteMetricId)
      if (!(await customConfirm('Remove this metric from the athlete?'))) return

      const { error } = await supabase
        .from('athlete_metrics')
        .delete()
        .eq('id', athleteMetricId)

      if (error) { console.log('Error deleting metric:', error); customAlert('Something went wrong'); return }

      loadAthleteMetrics()
    })
  })

  // --- Wire up "delete measurement" buttons (used elsewhere in the UI) ---
  document.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const measurementId = parseInt(this.dataset.measurementId)
      if (!(await customConfirm('Delete this measurement?'))) return

      const { error } = await supabase
        .from('measurements')
        .delete()
        .eq('id', measurementId)

      if (error) { console.log('Error deleting measurement:', error); customAlert('Something went wrong'); return }

      loadAthleteMetrics()
    })
  })

  // --- Draw the small trend chart (Chart.js) inside each metric card ---
  // Reuses measurementsByMetric (fetched once, up top) instead of querying
  // the same 3-months-of-measurements data a second time per metric
  for (const am of athleteMetrics) {
    const metric = am.metrics
    const canvas = document.getElementById(`mini-graph-${metric.id}`)
    if (!canvas) continue

    const graphData = measurementsByMetric[metric.id] || []
    if (graphData.length < 2) continue

    const labels = graphData.map(m => m.date)
    const values = graphData.map(m => metric.type === 'pogo' ? m.rsi : m.value)

    new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: '#4a4a8e',
          backgroundColor: 'rgba(74, 74, 142, 0.1)',
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.3,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: { display: false }
        }
      }
    })

    // Clicking the mini graph opens the full-size graph modal
    canvas.addEventListener('click', function() {
      openGraphModal(metric)
    })
  }

  // --- Clicking anywhere on a metric card (except buttons/canvas/change badge)
  //     opens the full entries list for that metric; clicking the % change
  //     badge instead opens the "explain this change" breakdown ---
  document.querySelectorAll('.metric-item').forEach(item => {
    item.addEventListener('click', function(e) {
      if (e.target.classList.contains('btn-record') ||
          e.target.classList.contains('btn-delete-metric') ||
          e.target.tagName === 'CANVAS') return

      if (e.target.classList.contains('metric-change')) {
        openChangeExplain(e.target)
        return
      }

      const metricId = parseInt(this.dataset.metricId)
      const metric = allMetrics.find(m => m.id === metricId)
      openEntriesModal(metric)
    })
  })
}

// ==========================================================================
// ---- OPEN MEASUREMENT MODAL ----
// Shows/hides the right input fields (simple value / pogo jump / zone2 run)
// depending on the metric type, then opens the "record measurement" modal.
// ==========================================================================

function openMeasurementModal() {
  document.getElementById('measurementModalTitle').textContent =
    `Record — ${currentMetric.name}`

  // Set today's date as default
  document.getElementById('measurementDate').valueAsDate = new Date()

  // Show right fields based on metric type
if (currentMetric.type === 'pogo') {
    document.getElementById('simpleFields').style.display = 'none'
    document.getElementById('pogoFields').style.display = 'block'
    document.getElementById('zone2Fields').style.display = 'none'
    const pogoUnit = currentMetric.display_unit || 'cm'
    document.getElementById('pogoHeightLabel').textContent = `Height (${pogoUnit})`
  } else if (currentMetric.type === 'zone2') {
    document.getElementById('simpleFields').style.display = 'none'
    document.getElementById('pogoFields').style.display = 'none'
    document.getElementById('zone2Fields').style.display = 'block'
  } else {
    document.getElementById('simpleFields').style.display = 'block'
    document.getElementById('pogoFields').style.display = 'none'
    document.getElementById('zone2Fields').style.display = 'none'

    // Simple numeric metrics can display as a single value or as feet+inches
    if (currentMetric.display_unit === 'ft') {
      document.getElementById('singleValueGroup').style.display = 'none'
      document.getElementById('feetInchesGroup').style.display = 'block'
    } else {
      document.getElementById('singleValueGroup').style.display = 'block'
      document.getElementById('feetInchesGroup').style.display = 'none'
      document.getElementById('valueLabel').textContent =
        `${currentMetric.name} (${currentMetric.display_unit || currentMetric.unit})`
    }
  }

  document.getElementById('addMeasurementModal').classList.add('active')
}

// ==========================================================================
// ---- ADD METRIC MODAL ----
// Modal for assigning an existing metric (from the dropdown) to this athlete.
// ==========================================================================
document.getElementById('addMetricBtn').addEventListener('click', function() {
  document.getElementById('addMetricModal').classList.add('active')
})

document.getElementById('cancelMetricBtn').addEventListener('click', function() {
  document.getElementById('addMetricModal').classList.remove('active')
})

document.getElementById('saveMetricBtn').addEventListener('click', async function() {
  const metricId = parseInt(document.getElementById('metricSelect').value)

  if (!metricId) {
    customAlert('Please select a metric')
    return
  }

  const { error } = await supabase
    .from('athlete_metrics')
    .insert([{
      athlete_id: parseInt(athleteId),
      metric_id: metricId
    }])

  if (error) {
    console.log('Error adding metric:', error)
    customAlert('Something went wrong')
    return
  }

  document.getElementById('addMetricModal').classList.remove('active')
  loadAthleteMetrics()
})

// ==========================================================================
// ---- MEASUREMENT MODAL ----
// Saves a new measurement entry, building the right payload shape depending
// on whether this is a pogo jump, a zone2 run, or a simple value metric.
// ==========================================================================
document.getElementById('cancelMeasurementBtn').addEventListener('click', function() {
  document.getElementById('addMeasurementModal').classList.remove('active')
})

document.getElementById('saveMeasurementBtn').addEventListener('click', async function() {
  const date = document.getElementById('measurementDate').value

  if (!date) {
    customAlert('Please select a date')
    return
  }

  let insertData = {
    athlete_id: parseInt(athleteId),
    metric_id: currentMetric.id,
    date: date,
    notes: document.getElementById('measurementNotes').value
  }

  if (currentMetric.type === 'pogo') {
    insertData.height = convertInput(parseFloat(document.getElementById('pogoHeight').value), currentMetric.display_unit)
    insertData.ground_contact = parseFloat(document.getElementById('pogoGroundContact').value)
    insertData.rsi = parseFloat(document.getElementById('pogoRSI').value)
  } else if (currentMetric.type === 'zone2') {
    // Zone2 "efficiency score" = 1000 / (pace × heart rate) — lower pace & bpm is better
    const paceMin = parseFloat(document.getElementById('zone2PaceMin').value) || 0
    const paceSec = parseFloat(document.getElementById('zone2PaceSec').value) || 0
    const pace = paceMin + (paceSec / 60)
    const bpm = parseFloat(document.getElementById('zone2BPM').value)
    const distance = parseFloat(document.getElementById('zone2Distance').value)
    const durMin = parseFloat(document.getElementById('zone2DurMin').value) || 0
    const durSec = parseFloat(document.getElementById('zone2DurSec').value) || 0
    const duration = durMin + (durSec / 60)
    const score = +(1000 / (pace * bpm)).toFixed(3)
    insertData.pace = pace
    insertData.bpm = bpm
    insertData.distance = distance
    insertData.duration = duration
    insertData.value = score
  } else {
    let rawValue
    if (currentMetric.display_unit === 'ft') {
      const feet = parseFloat(document.getElementById('measurementFeet').value) || 0
      const inches = parseFloat(document.getElementById('measurementInches').value) || 0
      rawValue = feet + (inches / 12)
    } else {
      rawValue = parseFloat(document.getElementById('measurementValue').value)
    }
    insertData.value = convertInput(rawValue, currentMetric.display_unit)
  }

  const { error } = await supabase
    .from('measurements')
    .insert([insertData])

  if (error) {
    console.log('Error saving measurement:', error)
    customAlert('Something went wrong')
    return
  }

  document.getElementById('addMeasurementModal').classList.remove('active')
  loadAthleteMetrics()
})
// ==========================================================================
// ---- STATS BAR ----
// Fills in the top summary row: total entries logged, number of metrics
// tracked, how recently the athlete last logged something, and how many
// personal records (PRs) were set this month.
// ==========================================================================
async function loadStatsBar() {
  // Get all measurements for this athlete
  const { data: allMeasurements, error } = await fetchWithRetry((signal) => supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })
    .abortSignal(signal)
  )

  if (error) { console.log('Error loading stats bar:', error) }
  if (!allMeasurements) return

  allMeasurementsCache = allMeasurements // so the stats-bar detail modals can reuse this without re-querying

  // Total entries
  document.getElementById('statEntries').textContent = allMeasurements.length

  // Metrics tracked
  document.getElementById('statMetrics').textContent = athleteMetrics.length

  // Last updated
  if (allMeasurements.length > 0) {
    const lastDate = new Date(allMeasurements[0].date)
    const today = new Date()
    const diffDays = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24))
    if (diffDays === 0) {
      document.getElementById('statLastUpdated').textContent = 'Today'
    } else if (diffDays === 1) {
      document.getElementById('statLastUpdated').textContent = 'Yesterday'
    } else {
      document.getElementById('statLastUpdated').textContent = `${diffDays}d ago`
    }
  }

  // PRs in the last 30 days: walk each metric's measurements oldest-to-newest,
  // tracking the running best value. Any entry that beats the running best
  // counts as a PR - except the very first entry ever logged for a metric,
  // since it has no earlier value to compare against and can't be a "record".
  const now = new Date()
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  let prCount = 0
  prEvents = [] // reset the module-level list the PR overview modal reads from

  for (const am of athleteMetrics) {
    const metric = am.metrics
    if (!metric) continue

    // Get all measurements for this metric, oldest first, so we can track the running best
    const metricMeasurements = allMeasurements
      .filter(m => m.metric_id === metric.id)
      .sort((a, b) => a.date.localeCompare(b.date))

    if (metricMeasurements.length < 2) continue // need a baseline entry + at least one challenger

    const getValue = m => metric.type === 'pogo' ? m.rsi : m.value
    const higherIsBetter = metric.higher_is_better

    // First entry is just the baseline - it can never be a PR itself
    let best = getValue(metricMeasurements[0])

    for (let i = 1; i < metricMeasurements.length; i++) {
      const entry = metricMeasurements[i]
      const value = getValue(entry)
      const isNewBest = higherIsBetter ? value > best : value < best

      if (isNewBest) {
        if (entry.date >= thirtyDaysAgo) {
          prCount++
          // Keep the metric + entry so the PR overview modal can display and group it
          prEvents.push({ metric, entry })
        }
        best = value
      }
    }
  }

  document.getElementById('statPRs').textContent = prCount
}

// ==========================================================================
// ---- PR OVERVIEW MODAL ----
// Opened by clicking the "PRs (last 30 days)" stat tile. Shows prEvents
// (filled in by loadStatsBar above) grouped by category, then by individual
// metric, with each metric's PRs listed chronologically (oldest first) so
// repeat PRs on the same metric read as a clear progression.
// ==========================================================================
document.getElementById('statPRsCard').addEventListener('click', function() {
  document.getElementById('prModal').classList.add('active')
  renderPRModal()
})

document.getElementById('closePRModalBtn').addEventListener('click', function() {
  document.getElementById('prModal').classList.remove('active')
})

// Same value-formatting rules used by the "All Entries" table, per metric type
function formatMeasurementValue(metric, entry) {
  if (metric.type === 'pogo') {
    const converted = convertValue(entry.height, metric.display_unit)
    return `RSI ${entry.rsi} (H: ${converted.text}${converted.unit}, GCT: ${entry.ground_contact}ms)`
  } else if (metric.type === 'zone2') {
    return `Score: ${entry.value}`
  } else {
    const converted = convertValue(entry.value, metric.display_unit)
    return `${converted.text} ${converted.unit}`
  }
}

// Shared category order for all "grouped by category" detail modals -
// known categories first in this fixed order, anything unrecognized
// falls back to the end, alphabetically
function sortCategories(categoryNames) {
  const categoryOrder = ['Jumps', 'Sprints', 'Strength', 'Cardio']
  return categoryNames.sort((a, b) => {
    const ai = categoryOrder.indexOf(a)
    const bi = categoryOrder.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

function renderPRModal() {
  const container = document.getElementById('prList')

  if (prEvents.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No PRs broken in the last 30 days</p>'
    return
  }

  // Group PR events: category -> metric name -> array of {metric, entry}
  const byCategory = {}
  for (const ev of prEvents) {
    const category = ev.metric.category || 'Other'
    const metricName = ev.metric.name
    if (!byCategory[category]) byCategory[category] = {}
    if (!byCategory[category][metricName]) byCategory[category][metricName] = []
    byCategory[category][metricName].push(ev)
  }

  const categories = sortCategories(Object.keys(byCategory))

  container.innerHTML = categories.map(category => `
    <div class="detail-category">
      <h3 class="category-title">${category}</h3>
      ${Object.keys(byCategory[category]).sort().map(metricName => {
        // Chronological (oldest first) so multiple PRs on the same metric show progression
        const events = byCategory[category][metricName].sort((a, b) => a.entry.date.localeCompare(b.entry.date))
        return `
          <div class="detail-group">
            <h4 class="detail-group-title">${metricName}</h4>
            <ul class="detail-list">
              ${events.map(ev => `
                <li class="detail-row">
                  <span>${ev.entry.date}</span>
                  <span class="detail-row-value">${formatMeasurementValue(ev.metric, ev.entry)}</span>
                </li>
              `).join('')}
            </ul>
          </div>
        `
      }).join('')}
    </div>
  `).join('')
}

// ==========================================================================
// ---- METRICS TRACKED MODAL ----
// Opened by clicking the "Metrics tracked" stat tile. Lists every metric
// currently assigned to this athlete, grouped by category.
// ==========================================================================
document.getElementById('statMetricsCard').addEventListener('click', function() {
  document.getElementById('metricsTrackedModal').classList.add('active')
  renderMetricsTrackedModal()
})

document.getElementById('closeMetricsTrackedModalBtn').addEventListener('click', function() {
  document.getElementById('metricsTrackedModal').classList.remove('active')
})

function renderMetricsTrackedModal() {
  const container = document.getElementById('metricsTrackedList')

  if (athleteMetrics.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No metrics tracked yet</p>'
    return
  }

  // Group tracked metrics by category
  const byCategory = {}
  for (const am of athleteMetrics) {
    const metric = am.metrics
    if (!metric) continue
    const category = metric.category || 'Other'
    if (!byCategory[category]) byCategory[category] = []
    byCategory[category].push(metric)
  }

  const categoryTypeLabels = { simple: 'Simple', pogo: 'Pogo', zone2: 'Zone 2' }
  const categories = sortCategories(Object.keys(byCategory))

  container.innerHTML = categories.map(category => `
    <div class="detail-category">
      <h3 class="category-title">${category}</h3>
      <ul class="detail-list">
        ${byCategory[category].sort((a, b) => a.name.localeCompare(b.name)).map(metric => `
          <li class="detail-row">
            <span>${metric.name}</span>
            <span class="detail-row-value">${categoryTypeLabels[metric.type] || metric.type}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('')
}

// ==========================================================================
// ---- TOTAL ENTRIES MODAL ----
// Opened by clicking the "Total entries" stat tile. Shows how many
// measurements are logged per metric, grouped by category.
// ==========================================================================
document.getElementById('statEntriesCard').addEventListener('click', function() {
  document.getElementById('totalEntriesModal').classList.add('active')
  renderTotalEntriesModal()
})

document.getElementById('closeTotalEntriesModalBtn').addEventListener('click', function() {
  document.getElementById('totalEntriesModal').classList.remove('active')
})

function renderTotalEntriesModal() {
  const container = document.getElementById('totalEntriesList')

  if (allMeasurementsCache.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries logged yet</p>'
    return
  }

  // Count entries per metric, grouped by category (skip metrics with 0 entries)
  const byCategory = {}
  for (const am of athleteMetrics) {
    const metric = am.metrics
    if (!metric) continue
    const count = allMeasurementsCache.filter(m => m.metric_id === metric.id).length
    if (count === 0) continue
    const category = metric.category || 'Other'
    if (!byCategory[category]) byCategory[category] = []
    byCategory[category].push({ metric, count })
  }

  const categories = sortCategories(Object.keys(byCategory))

  container.innerHTML = categories.map(category => `
    <div class="detail-category">
      <h3 class="category-title">${category}</h3>
      <ul class="detail-list">
        ${byCategory[category].sort((a, b) => a.metric.name.localeCompare(b.metric.name)).map(({ metric, count }) => `
          <li class="detail-row">
            <span>${metric.name}</span>
            <span class="detail-row-value">${count} ${count === 1 ? 'entry' : 'entries'}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('')
}

// ==========================================================================
// ---- LAST UPDATED / RECENT ACTIVITY MODAL ----
// Opened by clicking the "Last updated" stat tile. Reverse-chronological
// feed of every entry logged, newest first, across all metrics.
// ==========================================================================
document.getElementById('statLastUpdatedCard').addEventListener('click', function() {
  document.getElementById('lastUpdatedModal').classList.add('active')
  recentActivityPage = 0 // always start back at the newest entries when reopening
  renderLastUpdatedModal()
})

document.getElementById('closeLastUpdatedModalBtn').addEventListener('click', function() {
  document.getElementById('lastUpdatedModal').classList.remove('active')
})

// Formats a stored 'YYYY-MM-DD' date string as e.g. "Jul 23, 2026"
function formatDisplayDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// How many entries per page (21-40, 41-60, etc), and which page we're currently on
const RECENT_ACTIVITY_PAGE_SIZE = 20
let recentActivityPage = 0

function renderLastUpdatedModal() {
  const container = document.getElementById('lastUpdatedList')

  if (allMeasurementsCache.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries logged yet</p>'
    return
  }

  // Map metric_id -> metric so each measurement can show its metric's name and formatted value
  const metricById = {}
  for (const am of athleteMetrics) {
    if (am.metrics) metricById[am.metrics.id] = am.metrics
  }

  const sorted = [...allMeasurementsCache].sort((a, b) => b.date.localeCompare(a.date))

  const start = recentActivityPage * RECENT_ACTIVITY_PAGE_SIZE
  const end = start + RECENT_ACTIVITY_PAGE_SIZE
  const pageEntries = sorted.slice(start, end)
  const hasPrev = recentActivityPage > 0
  const hasNext = end < sorted.length

  // Group same-day entries together under one date heading, so the date
  // isn't repeated on every row and same-day entries are easy to see as a batch
  const byDate = {}
  const dateOrder = []
  for (const m of pageEntries) {
    if (!byDate[m.date]) { byDate[m.date] = []; dateOrder.push(m.date) }
    byDate[m.date].push(m)
  }

  container.innerHTML = `
    ${dateOrder.map(date => `
      <div class="detail-group">
        <h4 class="detail-group-title">${formatDisplayDate(date)}</h4>
        <ul class="detail-list">
          ${byDate[date].map(m => {
            const metric = metricById[m.metric_id]
            if (!metric) return ''
            return `
              <li class="detail-row">
                <span>${metric.name}</span>
                <span class="detail-row-value">${formatMeasurementValue(metric, m)}</span>
              </li>
            `
          }).join('')}
        </ul>
      </div>
    `).join('')}
    <div class="pagination-row">
      ${hasPrev ? '<button class="pagination-btn" id="prevActivityBtn">← Previous</button>' : '<span></span>'}
      <span class="pagination-label">${start + 1}–${Math.min(end, sorted.length)} of ${sorted.length}</span>
      ${hasNext ? '<button class="pagination-btn" id="nextActivityBtn">Next →</button>' : '<span></span>'}
    </div>
  `

  if (hasPrev) {
    document.getElementById('prevActivityBtn').addEventListener('click', function() {
      recentActivityPage--
      renderLastUpdatedModal()
    })
  }

  if (hasNext) {
    document.getElementById('nextActivityBtn').addEventListener('click', function() {
      recentActivityPage++
      renderLastUpdatedModal()
    })
  }
}

// ==========================================================================
// ---- GRAPH MODAL ----
// Full-size Chart.js graph for one metric, with 1M/3M/1Y/All time filters.
// ==========================================================================
let fullChart = null
let currentGraphMetric = null
let currentGraphMonths = 1 // remembers the active time filter, so the bodyweight toggle can redraw without needing it passed in again
let showBodyweightOverlay = false

async function openGraphModal(metric) {
  currentGraphMetric = metric
  document.getElementById('graphModalTitle').textContent = metric.name
  document.getElementById('graphModal').classList.add('active')

  // Set 1M as default active filter
  document.querySelectorAll('.time-filter-btn[data-months]').forEach(btn => btn.classList.remove('active'))
  document.querySelector('.time-filter-btn[data-months="1"]').classList.add('active')

  // Bodyweight overlay always starts off when opening a graph, so it's
  // never confusingly left on for a metric you didn't turn it on for
  showBodyweightOverlay = false
  document.getElementById('bodyweightOverlayToggle').checked = false

  await loadGraphData(1)
}

// Fetches measurements for the selected time range and (re)draws the chart
async function loadGraphData(months) {
  currentGraphMonths = months

  let query = supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .eq('metric_id', currentGraphMetric.id)
    .order('date', { ascending: true })

  if (months > 0) {
    const fromDate = new Date()
    fromDate.setMonth(fromDate.getMonth() - months)
    query = query.gte('date', fromDate.toISOString().split('T')[0])
  }

  const { data } = await query

  // For Zone 2 metrics, show total km run within the selected time filter above the graph
  const periodStatEl = document.getElementById('graphPeriodStat')
  if (currentGraphMetric.type === 'zone2') {
    const periodLabels = { 1: 'last month', 3: 'last 3 months', 6: 'last 6 months', 12: 'last year', 0: 'all time' }
    const totalKm = data ? data.reduce((sum, m) => sum + (m.distance || 0), 0).toFixed(1) : '0.0'
    periodStatEl.textContent = `${totalKm} km run · ${periodLabels[months]}`
  } else {
    periodStatEl.textContent = ''
  }

  // % change badge next to the title, recalculated for whichever time range
  // is currently selected: compares the average of the selected period
  // (e.g. the last 6 months, already loaded as `data` above) to the average
  // of the same-length period immediately before it (the 6 months before
  // that). "All" has no equivalent "previous" period to compare against, so
  // it falls back to splitting all-time data into an earlier half vs a
  // recent half instead.
  const changeStatEl = document.getElementById('graphChangeStat')
  const periodBadgeLabels = { 1: '1M', 3: '3M', 6: '6M', 12: '1Y', 0: 'All' }
  const getValue = m => currentGraphMetric.type === 'pogo' ? m.rsi : m.value

  let currentPeriodData = data
  let previousPeriodData = null

  if (months > 0) {
    const currentStart = new Date()
    currentStart.setMonth(currentStart.getMonth() - months)
    const previousStart = new Date()
    previousStart.setMonth(previousStart.getMonth() - months * 2)

    const { data: prevData } = await supabase
      .from('measurements')
      .select('*')
      .eq('athlete_id', athleteId)
      .eq('metric_id', currentGraphMetric.id)
      .gte('date', previousStart.toISOString().split('T')[0])
      .lt('date', currentStart.toISOString().split('T')[0])

    previousPeriodData = prevData
  } else if (data && data.length >= 2) {
    const half = Math.floor(data.length / 2)
    previousPeriodData = data.slice(0, half)
    currentPeriodData = data.slice(half)
  }

  if (!currentPeriodData || currentPeriodData.length === 0 || !previousPeriodData || previousPeriodData.length === 0) {
    changeStatEl.innerHTML = ''
  } else {
    const currentAvg = currentPeriodData.reduce((sum, m) => sum + getValue(m), 0) / currentPeriodData.length
    const previousAvg = previousPeriodData.reduce((sum, m) => sum + getValue(m), 0) / previousPeriodData.length
    const pct = +(((currentAvg - previousAvg) / previousAvg) * 100).toFixed(1)
    const higherIsBetter = currentGraphMetric.higher_is_better
    const isPositive = higherIsBetter ? pct > 0 : pct < 0
    const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
    const arrow = pct > 0 ? '▲' : '▼'

    changeStatEl.innerHTML = `<span class="metric-change ${cssClass}" style="cursor:pointer" data-explain-type="period" data-metric-type="${currentGraphMetric.type}" data-metric-name="${currentGraphMetric.name}" data-period-label="${periodBadgeLabels[months]}" data-first-avg="${previousAvg.toFixed(3)}" data-second-avg="${currentAvg.toFixed(3)}" data-pct="${pct}" data-higher="${higherIsBetter}" data-unit="${currentGraphMetric.display_unit || currentGraphMetric.unit}">${arrow} ${Math.abs(pct)}%</span>`

    const badge = changeStatEl.querySelector('.metric-change')
    badge.addEventListener('click', function() { openChangeExplain(badge) })
  }

  if (!data || data.length === 0) {
    if (fullChart) { fullChart.destroy(); fullChart = null }
    return
  }

  if (showBodyweightOverlay) {
    await renderGraphWithBodyweightOverlay(data, months)
  } else {
    renderGraphRaw(data)
  }
}

// Shared dark-theme tooltip styling for both graph render functions below.
// `extra` can add/override fields (e.g. custom callbacks.label).
function themedTooltipOptions(extra) {
  return Object.assign({
    backgroundColor: '#1a1a2e',
    titleColor: '#ffffff',
    bodyColor: '#ffffff',
    borderColor: '#2a2a4e',
    borderWidth: 1,
    padding: 10,
    displayColors: true
  }, extra)
}

// Default view: this metric's own values in their own unit (cm, score, RSI, etc)
function renderGraphRaw(data) {
  const labels = data.map(m => m.date)
  const values = data.map(m => currentGraphMetric.type === 'pogo' ? m.rsi : m.value)

  if (fullChart) fullChart.destroy()

  const ctx = document.getElementById('fullGraph').getContext('2d')
  fullChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: currentGraphMetric.name,
        data: values,
        borderColor: '#4a4a8e',
        backgroundColor: 'rgba(74, 74, 142, 0.12)',
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: '#4a4a8e',
        tension: 0.35,
        cubicInterpolationMode: 'monotone',
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: themedTooltipOptions()
      },
      scales: {
        x: {
          ticks: { color: '#aaaacc' },
          grid: { color: '#2a2a4e' }
        },
        y: {
          ticks: { color: '#aaaacc' },
          grid: { color: '#2a2a4e' }
        }
      }
    }
  })
}

// Bodyweight overlay view: the metric (cm, score, RSI...) and bodyweight
// (kg) are completely different scales, so plotting both in their raw units
// on one axis - or bolting on a second y-axis - would be misleading. Instead
// both are indexed to "% change from the first value in this time range",
// which puts them on one shared, honest axis. The hover tooltip still shows
// each line's real value (metric in its own unit, bodyweight in kg/lbs), so
// the % is just how they're drawn, not how they're read.
async function renderGraphWithBodyweightOverlay(data, months) {
  let bwQuery = supabase
    .from('bodyweight')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: true })

  let fromDateStr = null
  if (months > 0) {
    const fromDate = new Date()
    fromDate.setMonth(fromDate.getMonth() - months)
    fromDateStr = fromDate.toISOString().split('T')[0]
    bwQuery = bwQuery.gte('date', fromDateStr)
  }

  const { data: bwData } = await bwQuery

  // Also grab the last bodyweight entry logged BEFORE this window, so if
  // nothing was logged during the selected range the line still carries
  // forward the athlete's last known weight instead of just disappearing
  let carryInWeight = null
  if (fromDateStr) {
    const { data: priorData } = await supabase
      .from('bodyweight')
      .select('weight')
      .eq('athlete_id', athleteId)
      .lt('date', fromDateStr)
      .order('date', { ascending: false })
      .limit(1)
    if (priorData && priorData.length > 0) carryInWeight = priorData[0].weight
  }

  const getMetricValue = m => currentGraphMetric.type === 'pogo' ? m.rsi : m.value

  // Combined, sorted list of every date either series has an entry on, so
  // both lines plot on the same x-axis even though their entries don't
  // line up 1-to-1 (metric-index gap and bodyweight-log dates rarely match)
  const allDates = [...new Set([...data.map(m => m.date), ...(bwData || []).map(b => b.date)])].sort()

  // --- Metric series: indexed to % change from the first value shown ---
  const metricBaseline = getMetricValue(data[0])
  const metricByEntry = {}
  data.forEach(m => { metricByEntry[m.date] = m })
  const metricSeries = allDates.map(d => {
    const entry = metricByEntry[d]
    return entry ? +(((getMetricValue(entry) - metricBaseline) / metricBaseline) * 100).toFixed(2) : null
  })

  // --- Bodyweight series: carry the last known weight forward across dates
  // with no new entry, so the line stays flat/continuous instead of gapping
  // out when nothing was logged during part (or all) of the selected range ---
  const bwByDate = {}
  if (bwData) bwData.forEach(b => { bwByDate[b.date] = b.weight })

  const bwBaseline = carryInWeight !== null ? carryInWeight : (bwData && bwData[0] ? bwData[0].weight : null)

  let lastKnownWeight = carryInWeight
  const bwRawByDate = {}
  allDates.forEach(d => {
    if (d in bwByDate) lastKnownWeight = bwByDate[d]
    bwRawByDate[d] = lastKnownWeight
  })
  const bwSeries = bwBaseline === null
    ? allDates.map(() => null)
    : allDates.map(d => bwRawByDate[d] === null ? null : +(((bwRawByDate[d] - bwBaseline) / bwBaseline) * 100).toFixed(2))

  if (fullChart) fullChart.destroy()

  const ctx = document.getElementById('fullGraph').getContext('2d')
  fullChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: allDates,
      datasets: [
        {
          label: currentGraphMetric.name,
          data: metricSeries,
          borderColor: '#4a4a8e',
          backgroundColor: 'rgba(74, 74, 142, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#4a4a8e',
          tension: 0.35,
          cubicInterpolationMode: 'monotone',
          fill: false,
          spanGaps: true
        },
        {
          label: 'Bodyweight',
          data: bwSeries,
          borderColor: '#e0a458',
          backgroundColor: 'rgba(224, 164, 88, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#e0a458',
          tension: 0.35,
          cubicInterpolationMode: 'monotone',
          fill: false,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: '#aaaacc' } },
        tooltip: themedTooltipOptions({
          callbacks: {
            // Show each line's real underlying value instead of the plotted
            // % - the % is only how the two share one axis visually
            label: function(context) {
              const date = context.label
              if (context.dataset.label === 'Bodyweight') {
                const raw = bwRawByDate[date]
                if (raw === null || raw === undefined) return 'Bodyweight: no data'
                const display = bodyweightUnit === 'lbs' ? (raw * 2.20462).toFixed(1) : raw.toFixed(1)
                return `Bodyweight: ${display} ${bodyweightUnit}`
              }
              const entry = metricByEntry[date]
              if (!entry) return `${currentGraphMetric.name}: no data`
              return `${currentGraphMetric.name}: ${formatMeasurementValue(currentGraphMetric, entry)}`
            }
          }
        })
      },
      scales: {
        x: {
          ticks: { color: '#aaaacc' },
          grid: { color: '#2a2a4e' }
        },
        y: {
          ticks: { color: '#aaaacc', callback: v => `${v}%` },
          grid: { color: '#2a2a4e' },
          title: { display: true, text: '% change from period start', color: '#aaaacc' }
        }
      }
    }
  })
}

document.getElementById('closeGraphBtn').addEventListener('click', function() {
  document.getElementById('graphModal').classList.remove('active')
  if (fullChart) { fullChart.destroy(); fullChart = null }
})

document.getElementById('bodyweightOverlayToggle').addEventListener('change', async function() {
  showBodyweightOverlay = this.checked
  await loadGraphData(currentGraphMonths)
})

// Switching the 1M/3M/1Y/All buttons re-loads the graph for that range
document.querySelectorAll('.time-filter-btn[data-months]').forEach(btn => {
  btn.addEventListener('click', async function() {
    document.querySelectorAll('.time-filter-btn[data-months]').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    const months = parseInt(this.dataset.months)
    await loadGraphData(months)
  })
})
// ==========================================================================
// ---- CREATE NEW METRIC ----
// Lets the user define a brand-new metric type (name/unit/type/category),
// save it to the DB, and immediately select it in the "add metric" dropdown.
// ==========================================================================
document.getElementById('createNewMetricBtn').addEventListener('click', function() {
  document.getElementById('addMetricModal').classList.remove('active')
  document.getElementById('createMetricModal').classList.add('active')
})

document.getElementById('cancelCreateMetricBtn').addEventListener('click', function() {
  document.getElementById('createMetricModal').classList.remove('active')
  document.getElementById('addMetricModal').classList.add('active')
})

document.getElementById('saveNewMetricBtn').addEventListener('click', async function() {
  const name = document.getElementById('newMetricName').value.trim()
  const unit = document.getElementById('newMetricUnit').value.trim()
  const type = document.getElementById('newMetricType').value

  if (!name || !unit) {
    customAlert('Please fill in both name and unit')
    return
  }

  const category = document.getElementById('newMetricCategory').value
  const { data, error } = await supabase
    .from('metrics')
    .insert([{ name, unit, type, category }])
    .select()

  if (error) {
    console.log('Error creating metric:', error)
    customAlert('Something went wrong')
    return
  }

  // Add new metric to allMetrics and dropdown
  allMetrics.push(data[0])
  const select = document.getElementById('metricSelect')
  const option = document.createElement('option')
  option.value = data[0].id
  option.textContent = `${data[0].name} (${data[0].unit})`
  select.appendChild(option)
  select.value = data[0].id

  // Clear form
  document.getElementById('newMetricName').value = ''
  document.getElementById('newMetricUnit').value = ''

  // Go back to add metric modal
  document.getElementById('createMetricModal').classList.remove('active')
  document.getElementById('addMetricModal').classList.add('active')

  customAlert(`"${name}" created and selected!`)
})
// ==========================================================================
// ---- ENTRIES MODAL ----
// Full history table for one metric: lists every measurement, with edit
// and delete actions per row.
// ==========================================================================
let currentEditEntry = null
let currentEntriesMetric = null

async function openEntriesModal(metric) {
  currentEntriesMetric = metric
  document.getElementById('entriesModalTitle').textContent = `${metric.name} — All Entries`
  document.getElementById('entriesModal').classList.add('active')

  await loadEntries(metric)
}

// Fetches and renders the entries table for a given metric
async function loadEntries(metric) {
  const { data, error } = await supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .eq('metric_id', metric.id)
    .order('date', { ascending: false })

  const list = document.getElementById('entriesList')

  if (!data || data.length === 0) {
    list.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries yet</p>'
    return
  }

  list.innerHTML = `
    <table class="entries-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Value</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${data.map(m => {
          let valueText = ''
        if (metric.type === 'pogo') {
            const converted = convertValue(m.height, metric.display_unit)
            valueText = `H: ${converted.text}${converted.unit} · GCT: ${m.ground_contact}ms · RSI: ${m.rsi}`
          } else if (metric.type === 'zone2') {
            valueText = `Score: ${m.value}`
          } else {
            const converted = convertValue(m.value, metric.display_unit)
            valueText = `${converted.text} ${converted.unit}`
          }
          return `<tr>
            <td>${m.date}</td>
            <td>${valueText}</td>
            <td>${m.notes || '—'}</td>
            <td>
              <button class="btn-edit-entry" data-entry-id="${m.id}">✏</button>
              <button class="btn-delete-measurement" data-measurement-id="${m.id}">🗑</button>
            </td>
          </tr>`
        }).join('')}
      </tbody>
    </table>
  `

  // Delete listener
  list.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const measurementId = parseInt(this.dataset.measurementId)
      if (!(await customConfirm('Delete this entry?'))) return

      const { error } = await supabase
        .from('measurements')
        .delete()
        .eq('id', measurementId)

      if (error) { customAlert('Something went wrong'); return }

      await loadEntries(metric)
      loadAthleteMetrics()
    })
  })

  // Edit listener
  list.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', async function() {
      const entryId = parseInt(this.dataset.entryId)
      const entry = data.find(m => m.id === entryId)
      openEditEntryModal(entry, metric)
    })
  })
}

// Populates the "edit entry" modal fields based on the metric type, then opens it
function openEditEntryModal(entry, metric) {
  currentEditEntry = entry
  document.getElementById('editEntryDate').value = entry.date
  document.getElementById('editEntryNotes').value = entry.notes || ''

  if (metric.type === 'pogo') {
    document.getElementById('editSimpleFields').style.display = 'none'
    document.getElementById('editPogoFields').style.display = 'block'
    document.getElementById('editZone2Fields').style.display = 'none'
    const converted = convertValue(entry.height, metric.display_unit)
    document.getElementById('editPogoHeight').value = converted.text || ''
    document.getElementById('editPogoGroundContact').value = entry.ground_contact || ''
    document.getElementById('editPogoRSI').value = entry.rsi || ''
  } else if (metric.type === 'zone2') {
    document.getElementById('editSimpleFields').style.display = 'none'
    document.getElementById('editPogoFields').style.display = 'none'
    document.getElementById('editZone2Fields').style.display = 'block'
   const paceMin = Math.floor(entry.pace || 0)
    const paceSec = Math.round(((entry.pace || 0) - paceMin) * 60)
    document.getElementById('editZone2PaceMin').value = paceMin
    document.getElementById('editZone2PaceSec').value = paceSec
    document.getElementById('editZone2BPM').value = entry.bpm || ''
    document.getElementById('editZone2Distance').value = entry.distance || ''
    const durMin = Math.floor(entry.duration || 0)
    const durSec = Math.round(((entry.duration || 0) - durMin) * 60)
    document.getElementById('editZone2DurMin').value = durMin
    document.getElementById('editZone2DurSec').value = durSec
  } else {
    document.getElementById('editSimpleFields').style.display = 'block'
    document.getElementById('editPogoFields').style.display = 'none'
    document.getElementById('editZone2Fields').style.display = 'none'
    if (metric.display_unit === 'ft') {
      document.getElementById('editSingleValueGroup').style.display = 'none'
      document.getElementById('editFeetInchesGroup').style.display = 'block'
      const totalInches = (entry.value / 2.54)
      const feet = Math.floor(totalInches / 12)
      const inches = +(totalInches % 12).toFixed(1)
      document.getElementById('editEntryFeet').value = feet
      document.getElementById('editEntryInches').value = inches
    } else {
      document.getElementById('editSingleValueGroup').style.display = 'block'
      document.getElementById('editFeetInchesGroup').style.display = 'none'
      document.getElementById('editValueLabel').textContent = `${metric.name} (${metric.display_unit || metric.unit})`
      const converted = convertValue(entry.value, metric.display_unit)
      document.getElementById('editEntryValue').value = converted.text || ''
    }
  }

  document.getElementById('editEntryModal').classList.add('active')
}

document.getElementById('closeEntriesBtn').addEventListener('click', function() {
  document.getElementById('entriesModal').classList.remove('active')
})

document.getElementById('cancelEditEntryBtn').addEventListener('click', function() {
  document.getElementById('editEntryModal').classList.remove('active')
})

// Saves edits to an existing measurement, rebuilding the payload per metric type
document.getElementById('saveEditEntryBtn').addEventListener('click', async function() {
  const date = document.getElementById('editEntryDate').value
  if (!date) { customAlert('Please select a date'); return }

  let updateData = {
    date,
    notes: document.getElementById('editEntryNotes').value
  }

 if (currentEntriesMetric.type === 'pogo') {
    updateData.height = convertInput(parseFloat(document.getElementById('editPogoHeight').value), currentEntriesMetric.display_unit)
    updateData.ground_contact = parseFloat(document.getElementById('editPogoGroundContact').value)
    updateData.rsi = parseFloat(document.getElementById('editPogoRSI').value)
  } else if (currentEntriesMetric.type === 'zone2') {
    const paceMin = parseFloat(document.getElementById('editZone2PaceMin').value) || 0
    const paceSec = parseFloat(document.getElementById('editZone2PaceSec').value) || 0
    const pace = paceMin + (paceSec / 60)
    const bpm = parseFloat(document.getElementById('editZone2BPM').value)
    const distance = parseFloat(document.getElementById('editZone2Distance').value)
    const durMin = parseFloat(document.getElementById('editZone2DurMin').value) || 0
    const durSec = parseFloat(document.getElementById('editZone2DurSec').value) || 0
    const duration = durMin + (durSec / 60)
    updateData.pace = pace
    updateData.bpm = bpm
    updateData.distance = distance
    updateData.duration = duration
    updateData.value = +(1000 / (pace * bpm)).toFixed(3)
  } else {
    let rawValue
   if (currentEntriesMetric.display_unit === 'ft') {
      const feet = parseFloat(document.getElementById('editEntryFeet').value) || 0
      const inches = parseFloat(document.getElementById('editEntryInches').value) || 0
      rawValue = feet + (inches / 12)
    } else {
      rawValue = parseFloat(document.getElementById('editEntryValue').value)
    }
    updateData.value = convertInput(rawValue, currentEntriesMetric.display_unit)
  }

  const { error } = await supabase
    .from('measurements')
    .update(updateData)
    .eq('id', currentEditEntry.id)

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  document.getElementById('editEntryModal').classList.remove('active')
  await loadEntries(currentEntriesMetric)
  loadAthleteMetrics()
})
// ==========================================================================
// ---- EDIT ATHLETE INFO ----
// Saves changes made in the "edit athlete" modal (name, DOB, gender, height,
// email). Weight is not edited here - see the Bodyweight feature for that.
// Email is what links this athlete row to their own login once they sign up
// in the athlete app (see claim_athlete_by_email in sql-history.sql).
// ==========================================================================
document.getElementById('closeEditAthleteBtn').addEventListener('click', function() {
  document.getElementById('editAthleteModal').classList.remove('active')
})

document.getElementById('cancelEditAthleteBtn').addEventListener('click', function() {
  document.getElementById('editAthleteModal').classList.remove('active')
})

document.getElementById('saveEditAthleteBtn').addEventListener('click', async function() {
  const name = document.getElementById('editAthleteName').value.trim()
  const dob = document.getElementById('editAthleteDOB').value
  const gender = document.getElementById('editAthleteGender').value
  const height = parseInt(document.getElementById('editAthleteHeight').value)
  // Empty -> null, not '' - the email column has a "no duplicates" rule in
  // the database, and two blank emails would otherwise count as duplicates
  const email = document.getElementById('editAthleteEmail').value.trim() || null

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

  document.getElementById('editAthleteModal').classList.remove('active')

  // Only a newly-added or changed email should trigger a fresh invite -
  // resaving unrelated fields shouldn't re-send one every time
  if (email && email !== previousEmail) {
    const inviteError = await sendInviteEmail(email, name)
    if (inviteError) {
      console.log('Error sending invite:', inviteError)
      customAlert('Athlete saved, but the invite email failed to send. Use "Resend Invite" or "Copy Invite Link" to try again.')
    }
  }

  loadAthlete()
})
// ==========================================================================
// ---- BODYWEIGHT ----
// Loads and draws the bodyweight trend chart on the profile header, and
// handles logging a new bodyweight entry.
// ==========================================================================
let bodyweightChart = null
let bodyweightUnit = 'kg'

async function loadBodyweightGraph() {
  const { data, error } = await supabase
    .from('bodyweight')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: true })

  const canvas = document.getElementById('bodyweightGraph')
  const noDataMsg = document.getElementById('noBodyweightMsg')

  if (!data || data.length === 0) {
    canvas.style.display = 'none'
    noDataMsg.style.display = 'block'
    return
  }

  noDataMsg.style.display = 'none'
  canvas.style.display = 'block'

  if (bodyweightChart) bodyweightChart.destroy()

  bodyweightChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map(d => d.date),
     datasets: [{
        // Convert stored kg values to lbs on the fly if the user has lbs selected
        data: data.map(d => bodyweightUnit === 'kg' ? d.weight : +(d.weight * 2.20462).toFixed(1)),
        borderColor: '#4a4a8e',
        backgroundColor: 'rgba(74, 74, 142, 0.1)',
        borderWidth: 2,
        pointRadius: 3,
        tension: 0.3,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: {
          ticks: { color: '#aaaacc', font: { size: 10 } },
          grid: { color: '#2a2a4e' }
        }
      }
    }
  })
}

document.getElementById('addBodyweightBtn').addEventListener('click', function() {
  document.getElementById('bodyweightDate').valueAsDate = new Date()
  document.getElementById('bodyweightModal').classList.add('active')
})

document.getElementById('closeBodyweightBtn').addEventListener('click', function() {
  document.getElementById('bodyweightModal').classList.remove('active')
})

document.getElementById('cancelBodyweightBtn').addEventListener('click', function() {
  document.getElementById('bodyweightModal').classList.remove('active')
})

// Saves a new bodyweight entry; always stores in kg regardless of input unit
document.getElementById('saveBodyweightBtn').addEventListener('click', async function() {
  const date = document.getElementById('bodyweightDate').value
  const rawWeight = parseFloat(document.getElementById('bodyweightValue').value)
  const inputUnit = document.getElementById('bodyweightInputUnit').value
  const weight = inputUnit === 'lbs' ? +(rawWeight / 2.20462).toFixed(2) : rawWeight
  const notes = document.getElementById('bodyweightNotes').value

  if (!date || !weight) { customAlert('Please fill in date and weight'); return }

  const { error } = await supabase
    .from('bodyweight')
    .insert([{ athlete_id: parseInt(athleteId), date, weight, notes }])

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  document.getElementById('bodyweightModal').classList.remove('active')
  document.getElementById('bodyweightValue').value = ''
  document.getElementById('bodyweightNotes').value = ''
  loadBodyweightGraph()
})
// ==========================================================================
// ---- BODYWEIGHT UNIT TOGGLE ----
// Switches the bodyweight display (and re-draws the chart) between kg/lbs.
// Note: values are always stored in kg — this only changes how they're shown.
// ==========================================================================
document.getElementById('bwKgBtn').addEventListener('click', function() {
  bodyweightUnit = 'kg'
  document.getElementById('bwKgBtn').classList.add('active')
  document.getElementById('bwLbsBtn').classList.remove('active')
  loadBodyweightGraph()
})

document.getElementById('bwLbsBtn').addEventListener('click', function() {
  bodyweightUnit = 'lbs'
  document.getElementById('bwLbsBtn').classList.add('active')
  document.getElementById('bwKgBtn').classList.remove('active')
  loadBodyweightGraph()
})
// ==========================================================================
// ---- BODYWEIGHT ENTRIES ----
// Full history table for bodyweight logs, with edit/delete per row (mirrors
// the metric ENTRIES MODAL above, but for the bodyweight table).
// ==========================================================================
let currentBWEntry = null

document.getElementById('viewBWEntriesBtn').addEventListener('click', function() {
  document.getElementById('bwEntriesModal').classList.add('active')
  loadBWEntries()
})

document.getElementById('closeBWEntriesBtn').addEventListener('click', function() {
  document.getElementById('bwEntriesModal').classList.remove('active')
})

async function loadBWEntries() {
  const { data, error } = await supabase
    .from('bodyweight')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })

  const list = document.getElementById('bwEntriesList')

  if (!data || data.length === 0) {
    list.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries yet</p>'
    return
  }

  list.innerHTML = `
    <table class="entries-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Weight</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${data.map(m => `
          <tr>
            <td>${m.date}</td>
            <td>${bodyweightUnit === 'lbs' ? +(m.weight * 2.20462).toFixed(1) + ' lbs' : m.weight + ' kg'}</td>
            <td>${m.notes || '—'}</td>
            <td>
              <button class="btn-edit-entry" data-entry-id="${m.id}">✏</button>
              <button class="btn-delete-measurement" data-entry-id="${m.id}">🗑</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `

  list.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const entryId = parseInt(this.dataset.entryId)
      if (!(await customConfirm('Delete this entry?'))) return

      const { error } = await supabase
        .from('bodyweight')
        .delete()
        .eq('id', entryId)

      if (error) { customAlert('Something went wrong'); return }

      loadBWEntries()
      loadBodyweightGraph()
    })
  })

  list.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', function() {
      const entryId = parseInt(this.dataset.entryId)
      currentBWEntry = data.find(m => m.id === entryId)
      document.getElementById('editBWDate').value = currentBWEntry.date
      document.getElementById('editBWValue').value = currentBWEntry.weight
      document.getElementById('editBWUnit').value = 'kg'
      document.getElementById('editBWNotes').value = currentBWEntry.notes || ''
      document.getElementById('editBWEntryModal').classList.add('active')
    })
  })
}

document.getElementById('cancelEditBWBtn').addEventListener('click', function() {
  document.getElementById('editBWEntryModal').classList.remove('active')
})

document.getElementById('saveEditBWBtn').addEventListener('click', async function() {
  const date = document.getElementById('editBWDate').value
  const rawWeight = parseFloat(document.getElementById('editBWValue').value)
  const unit = document.getElementById('editBWUnit').value
  const weight = unit === 'lbs' ? +(rawWeight / 2.20462).toFixed(2) : rawWeight
  const notes = document.getElementById('editBWNotes').value

  if (!date || !weight) { customAlert('Please fill in date and weight'); return }

  const { error } = await supabase
    .from('bodyweight')
    .update({ date, weight, notes })
    .eq('id', currentBWEntry.id)

  if (error) { customAlert('Something went wrong'); return }

  document.getElementById('editBWEntryModal').classList.remove('active')
  loadBWEntries()
  loadBodyweightGraph()
})
// ==========================================================================
// ---- % CHANGE EXPLANATION ----
// Opens a small modal that explains how the ▲/▼ % change badge on a metric
// card was calculated (which numbers were compared and why).
// ==========================================================================
function openChangeExplain(el) {
  const type = el.dataset.explainType
  const metricName = el.dataset.metricName
  const pct = parseFloat(el.dataset.pct)
  const higher = el.dataset.higher === 'true'
  const isPositive = higher ? pct > 0 : pct < 0
  const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
  const arrow = pct > 0 ? '▲' : '▼'

  document.getElementById('changeExplainTitle').textContent = `${metricName} — Change Breakdown`

  let content = ''

  if (type === 'zone2') {
    // Zone2 breakdown: last-30-days avg vs previous-30-days avg
    const avg30 = parseFloat(el.dataset.avg30)
    const avgPrev = parseFloat(el.dataset.avgprev)
 content = `
      <div class="change-explain-row">
        <span class="change-explain-label">Last 30 days avg score</span>
        <span class="change-explain-value">${avg30}</span>
      </div>
      <div class="change-explain-row">
        <span class="change-explain-label">Previous 30 days avg score</span>
        <span class="change-explain-value">${avgPrev}</span>
      </div>
      <div class="change-explain-result metric-change ${cssClass}">
        ${arrow} ${Math.abs(pct)}% change in efficiency
      </div>
      <p style="color:#aaaacc; font-size:12px; margin-top:12px; text-align:center">
        Score = 1000 ÷ (pace × BPM) — higher is better
      </p>
    `
 } else if (type === 'period') {
    // Full graph modal breakdown: for a fixed window (1M/3M/6M/1Y), compares
    // that period's avg to the same-length period right before it. "All" has
    // no equivalent "previous" period, so it falls back to an earlier-half
    // vs recent-half split of the whole history instead.
    const periodLabel = el.dataset.periodLabel
    const isAllTime = periodLabel === 'All'
    const previousAvg = parseFloat(el.dataset.firstAvg)
    const currentAvg = parseFloat(el.dataset.secondAvg)
    const unit = el.dataset.unit
    const isPogo = el.dataset.metricType === 'pogo'
    const isZone2 = el.dataset.metricType === 'zone2'

    const formatVal = v => isZone2 || isPogo ? v : `${convertValue(v, unit).text} ${convertValue(v, unit).unit}`.trim()
    const valueLabel = isZone2 ? 'score' : isPogo ? 'RSI' : 'value'
    const previousLabel = isAllTime ? `Earlier half avg ${valueLabel}` : `Previous ${periodLabel} avg ${valueLabel}`
    const currentLabel = isAllTime ? `Recent half avg ${valueLabel}` : `This ${periodLabel} avg ${valueLabel}`

    content = `
      <div class="change-explain-row">
        <span class="change-explain-label">${previousLabel}</span>
        <span class="change-explain-value">${formatVal(previousAvg)}</span>
      </div>
      <div class="change-explain-row">
        <span class="change-explain-label">${currentLabel}</span>
        <span class="change-explain-value">${formatVal(currentAvg)}</span>
      </div>
      <div class="change-explain-result metric-change ${cssClass}">
        ${arrow} ${Math.abs(pct)}% within the ${periodLabel} view
      </div>
      <p style="color:#aaaacc; font-size:12px; margin-top:12px; text-align:center">
        ${isAllTime
          ? 'All time has no earlier equivalent period, so this compares the earlier half of the athlete’s history to the more recent half.'
          : `Compares the selected ${periodLabel} period to the ${periodLabel} right before it.`}
        Change the time filter above to see a different range.
        ${higher ? ' Higher is better for this metric.' : ' Lower is better for this metric.'}
      </p>
    `
  } else {
    // Simple/pogo breakdown: latest entry vs avg of previous 5 entries
    const latest = parseFloat(el.dataset.latest)
    const avgPrev = parseFloat(el.dataset.avgprev)
    const unit = el.dataset.unit
    const isPogo = el.dataset.metricType === 'pogo'

    const convertedLatest = isPogo ? { text: latest, unit: '' } : convertValue(latest, unit)
    const convertedAvg = isPogo ? { text: avgPrev, unit: '' } : convertValue(avgPrev, unit)
    const displayLatest = `${convertedLatest.text} ${convertedLatest.unit}`.trim()
    const displayAvg = `${convertedAvg.text} ${convertedAvg.unit}`.trim()
    const valueLabel = isPogo ? 'RSI Score' : 'Latest entry'
    const avgLabel = isPogo ? 'Avg RSI of previous 5 entries' : 'Avg of previous 5 entries'

    content = `
      <div class="change-explain-row">
        <span class="change-explain-label">${valueLabel}</span>
        <span class="change-explain-value">${displayLatest}</span>
      </div>
      <div class="change-explain-row">
        <span class="change-explain-label">${avgLabel}</span>
        <span class="change-explain-value">${displayAvg}</span>
      </div>
      <div class="change-explain-result metric-change ${cssClass}">
        ${arrow} ${Math.abs(pct)}% vs previous 5 entries
      </div>
      <p style="color:#aaaacc; font-size:12px; margin-top:12px; text-align:center">
        ${higher ? 'Higher is better for this metric' : 'Lower is better for this metric'}
      </p>
    `
  }

  document.getElementById('changeExplainContent').innerHTML = content
  document.getElementById('changeExplainModal').classList.add('active')
}

document.getElementById('closeChangeExplainBtn').addEventListener('click', function() {
  document.getElementById('changeExplainModal').classList.remove('active')
})

// ==========================================================================
// ---- PDF PROGRESS REPORT ----
// "Generate Report" button at the top of the Metrics tab opens a checklist
// of sections (only ones with real logged data are offered) + a 1/3/6/9/12
// month picker, then builds a PDF client-side with jsPDF and opens it in a
// new tab. No saved template - the checklist is picked fresh every time.
// ==========================================================================

document.getElementById('generateReportBtn').addEventListener('click', openReportBuilderModal)

document.getElementById('closeReportBuilderModalBtn').addEventListener('click', function() {
  document.getElementById('reportBuilderModal').classList.remove('active')
})

document.getElementById('reportSectionChecklist').addEventListener('click', function(e) {
  const btn = e.target.closest('.chip-btn')
  if (!btn) return
  const key = btn.dataset.key
  if (reportSelectedSections.has(key)) {
    reportSelectedSections.delete(key)
    btn.classList.remove('selected')
  } else {
    reportSelectedSections.add(key)
    btn.classList.add('selected')
  }
})

document.getElementById('reportMonthsRow').addEventListener('click', function(e) {
  const btn = e.target.closest('.time-filter-btn')
  if (!btn) return
  document.querySelectorAll('#reportMonthsRow .time-filter-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  reportSelectedMonths = parseInt(btn.dataset.months)
})

document.getElementById('generatePdfBtn').addEventListener('click', generateReportPDF)

async function openReportBuilderModal() {
  document.getElementById('reportBuilderModal').classList.add('active')
  document.getElementById('reportSectionChecklist').innerHTML = '<p class="no-metrics">Checking available data...</p>'
  reportDataCache = await fetchReportData()
  if (!reportDataCache) {
    document.getElementById('reportBuilderModal').classList.remove('active')
    return
  }
  reportSelectedSections = new Set(reportDataCache.availableSections.map(s => s.key))
  renderReportChecklist()
}

// One batch of unbounded-history queries, cached in reportDataCache for the
// lifetime of one modal-open - both the eligibility checklist AND the final
// PDF read from this same cache, filtered to whichever date range the coach
// picks, so there's exactly one round-trip to Supabase per report attempt.
async function fetchReportData() {
  const [
    { data: programs, error: programsError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    fetchWithRetry((signal) => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises!exercise_id(id, name, type, tracks_weight, foot_contacts, intensity_tier))))')
      .eq('athlete_id', athleteId)
      .eq('is_template', false)
      .abortSignal(signal)
    ),
    fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('*')
      .eq('athlete_id', athleteId)
      .not('ended_at', 'is', null)
      .order('started_at', { ascending: true })
      .abortSignal(signal)
    )
  ])

  if (programsError || sessionsError) {
    console.log('Error loading report data:', programsError || sessionsError)
    customAlert('Something went wrong loading report data - check your connection and try again')
    return null
  }

  // Same workoutEntries/peInfoById shape loadOverviewStats already builds,
  // just unbounded (no 90-day cap) since PR baselines and a 12-month report
  // both need full history
  const workoutEntries = [] // { dateStr, exercises }
  const peInfoById = {} // program_exercise_id -> joined exercises row
  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        const dateStr = day.date_override || resolveDateOv(program.start_date, week.week_number, day.day_number)
        workoutEntries.push({ dateStr, exercises: day.program_exercises })
        for (const pe of day.program_exercises) {
          if (pe.exercises) peInfoById[pe.id] = pe.exercises
        }
      }
    }
  }

  const peIds = Object.keys(peInfoById)
  let logSets = []
  if (peIds.length > 0) {
    const { data, error } = await fetchWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .select('*')
      .in('program_exercise_id', peIds)
      .not('completed_at', 'is', null)
      .order('date', { ascending: true })
      .abortSignal(signal)
    )
    if (error) {
      console.log('Error loading report log sets:', error)
      customAlert('Something went wrong loading report data - check your connection and try again')
      return null
    }
    logSets = data || []
  }

  // Eligibility - a section is only offered if the athlete actually has
  // qualifying data, anywhere in their history
  const availableSections = []
  for (const am of athleteMetrics) {
    if (!am.metrics) continue
    if (allMeasurementsCache.some(m => m.metric_id === am.metrics.id)) {
      availableSections.push({ key: `metric:${am.metrics.id}`, label: am.metrics.name, kind: 'metric', metric: am.metrics })
    }
  }
  if (sessions.length > 0) {
    availableSections.push({ key: 'overview', label: 'Workout Overview', kind: 'overview' })
  }
  if (logSets.some(s => { const ex = peInfoById[s.program_exercise_id]; return ex && ex.type === 'plyometric' && ex.foot_contacts })) {
    availableSections.push({ key: 'plyo', label: 'Plyometric Load', kind: 'plyo' })
  }

  return { workoutEntries, peInfoById, logSets, sessions, availableSections }
}

function renderReportChecklist() {
  const container = document.getElementById('reportSectionChecklist')
  if (reportDataCache.availableSections.length === 0) {
    container.innerHTML = '<p class="no-metrics">No logged data yet for this athlete - nothing to report on.</p>'
    return
  }
  container.innerHTML = reportDataCache.availableSections.map(s => `
    <button type="button" class="chip-btn selected" data-key="${s.key}">${s.label}</button>
  `).join('')
}

// { from, to } is the chosen report window; { prevFrom, prevTo } is the
// immediately-preceding period of equal length, used for the "vs previous
// period" deltas that make this read as a progress report, not a snapshot
function buildReportRange(months) {
  const to = new Date()
  const from = new Date(to)
  from.setMonth(from.getMonth() - months)
  const prevTo = new Date(from)
  prevTo.setDate(prevTo.getDate() - 1)
  const prevFrom = new Date(prevTo)
  prevFrom.setMonth(prevFrom.getMonth() - months)
  return {
    from: toDateStrOv(from), to: toDateStrOv(to),
    prevFrom: toDateStrOv(prevFrom), prevTo: toDateStrOv(prevTo)
  }
}

// ---- Section calculators - pure functions, no DOM/network, operate on the
// already-fetched reportDataCache plus a date range from buildReportRange ----

// Same rule completionRate() (loadOverviewStats) uses, generalized from a
// fixed windowDays to an arbitrary [from, to] range - including the "today
// isn't over yet" exception, so a report window ending today (as every
// report window does, see buildReportRange) doesn't count an unfinished
// same-day workout as missed
function completionRateForRange(workoutEntries, logSetsByPE, from, to) {
  const todayStr = toDateStrOv(new Date())
  let scheduled = 0
  let completed = 0
  for (const entry of workoutEntries) {
    if (entry.dateStr < from || entry.dateStr > to) continue
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
  return scheduled === 0 ? null : Math.round((completed / scheduled) * 100)
}

function volumeForRange(logSets, peInfoById, from, to) {
  return logSets
    .filter(s => s.date >= from && s.date <= to && peInfoById[s.program_exercise_id] && peInfoById[s.program_exercise_id].tracks_weight)
    .reduce((sum, s) => sum + setVolumeOv(s), 0)
}

function durationStatsForRange(sessions, from, to) {
  const inRange = sessions.filter(s => s.local_date >= from && s.local_date <= to)
  if (inRange.length === 0) return null
  const totalMinutes = inRange.reduce((sum, s) => sum + (new Date(s.ended_at) - new Date(s.started_at)) / 60000, 0)
  return Math.round(totalMinutes / inRange.length)
}

function computeWorkoutOverviewSection(cache, range) {
  const logSetsByPE = {}
  for (const row of cache.logSets) {
    if (!logSetsByPE[row.program_exercise_id]) logSetsByPE[row.program_exercise_id] = []
    logSetsByPE[row.program_exercise_id].push(row)
  }
  return {
    completion: completionRateForRange(cache.workoutEntries, logSetsByPE, range.from, range.to),
    prevCompletion: completionRateForRange(cache.workoutEntries, logSetsByPE, range.prevFrom, range.prevTo),
    volumeKg: Math.round(volumeForRange(cache.logSets, cache.peInfoById, range.from, range.to)),
    prevVolumeKg: Math.round(volumeForRange(cache.logSets, cache.peInfoById, range.prevFrom, range.prevTo)),
    avgDurationMin: durationStatsForRange(cache.sessions, range.from, range.to),
    prevAvgDurationMin: durationStatsForRange(cache.sessions, range.prevFrom, range.prevTo)
  }
}

// Same 30-days-vs-previous-30-days formula the Metrics tab's zone2 change
// badge uses (renderMetrics()), so the report's % always matches the app's
function zone2ChangePct(allForMetric) {
  const now = new Date()
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const last30 = allForMetric.filter(m => m.date >= thirtyDaysAgo)
  const prev30 = allForMetric.filter(m => m.date >= sixtyDaysAgo && m.date < thirtyDaysAgo)
  if (last30.length === 0 || prev30.length === 0) return null
  const avg30 = last30.reduce((sum, m) => sum + m.value, 0) / last30.length
  const avgPrev = prev30.reduce((sum, m) => sum + m.value, 0) / prev30.length
  if (!avgPrev) return null
  return +(((avg30 - avgPrev) / avgPrev) * 100).toFixed(1)
}

// Same "latest vs avg of previous 5 entries" formula the Metrics tab uses
// for every non-zone2 metric type - also always matches the app's number
function simpleChangePct(allForMetric, getValue) {
  if (allForMetric.length < 2) return null
  const latestVal = getValue(allForMetric[allForMetric.length - 1])
  const previous = allForMetric.slice(0, -1).slice(-5)
  const avgPrev = previous.reduce((sum, m) => sum + getValue(m), 0) / previous.length
  if (!avgPrev) return null
  return +(((latestVal - avgPrev) / avgPrev) * 100).toFixed(1)
}

// Converts a metric's raw stored values into whatever unit actually gets
// charted, so the trend chart's axis is never in a different unit than the
// headline "Latest" tile next to it (ft/in display units aren't directly
// plottable as feet'inches" text, so both chart as inches instead)
function chartUnitAndValues(metric, rawValues) {
  if (metric.type === 'pogo') return { unit: 'RSI', values: rawValues }
  if (metric.type === 'zone2') return { unit: 'Score', values: rawValues }
  const displayUnit = metric.display_unit
  if (displayUnit === 'in' || displayUnit === 'ft') {
    return { unit: 'in', values: rawValues.map(v => +(v / 2.54).toFixed(1)) }
  }
  return { unit: displayUnit || '', values: rawValues }
}

// "Latest" + its % change always reuse the exact same formulas/history the
// Metrics tab itself uses (see zone2ChangePct/simpleChangePct above), so
// they can never disagree with what the coach already sees there - only
// the trend chart is actually scoped to the chosen report window
function computeCustomMetricSection(metric, range) {
  const allForMetric = allMeasurementsCache
    .filter(m => m.metric_id === metric.id)
    .sort((a, b) => a.date.localeCompare(b.date))

  if (allForMetric.length === 0) return { metric, hasData: false }

  const getValue = m => metric.type === 'pogo' ? m.rsi : m.value
  const latestValue = getValue(allForMetric[allForMetric.length - 1])
  const pct = metric.type === 'zone2' ? zone2ChangePct(allForMetric) : simpleChangePct(allForMetric, getValue)

  const inRange = allForMetric.filter(m => m.date >= range.from && m.date <= range.to)
  const { unit: chartUnit, values: chartValues } = chartUnitAndValues(metric, inRange.map(getValue))

  return { metric, hasData: true, latestValue, pct, dates: inRange.map(m => m.date), chartValues, chartUnit }
}

// Same formula as the athlete app's per-session plyo load (foot_contacts x
// intensity multiplier x completed sets), summed per date across the whole
// report window, plus the equal-length prior period for a delta callout
function computePlyoSection(cache, range) {
  const multiplier = { low: 1, moderate: 1.5, high: 2 }
  const byDate = {}
  for (const s of cache.logSets) {
    const ex = cache.peInfoById[s.program_exercise_id]
    if (!ex || ex.type !== 'plyometric' || !ex.foot_contacts) continue
    const load = ex.foot_contacts * (multiplier[ex.intensity_tier] || 1)
    byDate[s.date] = (byDate[s.date] || 0) + load
  }

  const inRangeDates = Object.keys(byDate).filter(d => d >= range.from && d <= range.to).sort()
  const prevDates = Object.keys(byDate).filter(d => d >= range.prevFrom && d <= range.prevTo)

  return {
    hasData: inRangeDates.length > 0,
    dates: inRangeDates,
    values: inRangeDates.map(d => Math.round(byDate[d])),
    totalInRange: Math.round(inRangeDates.reduce((sum, d) => sum + byDate[d], 0)),
    totalPrev: Math.round(prevDates.reduce((sum, d) => sum + byDate[d], 0))
  }
}

// Loads an image from this same origin (the TBFlog logo) and re-draws it
// onto a canvas so it can be embedded in the PDF as a data URL - resolves
// null on any failure so a broken/slow logo load never blocks the report
function loadImageAsDataUrl(url) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      resolve({ dataUrl: canvas.toDataURL('image/png'), width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// Same value+unit formatting the Metrics tab cards already use
// (renderMetrics()) - pogo shows "RSI", zone2 shows "Score", everything
// else goes through convertValue() for its real display unit (cm/kg/etc)
function formatMetricValue(metric, value) {
  if (metric.type === 'pogo') return `${value} RSI`
  if (metric.type === 'zone2') return `Score: ${value}`
  const converted = convertValue(value, metric.display_unit)
  return converted.unit ? `${converted.text} ${converted.unit}` : `${converted.text}`
}

// Renders a Chart.js line chart into a throwaway off-screen canvas (never
// attached to the page, so this never disturbs what's visible on the
// Metrics tab), forces a white background (these charts are transparent by
// default against this app's dark theme, which would look wrong on a white
// PDF page), and returns the new y-cursor position after placing the image.
// devicePixelRatio is forced to 2 since an off-screen canvas never picked
// up the real screen's DPR on its own, and the chart title is baked
// straight into the image so the report doesn't need a separate caption.
function drawTrendChart(doc, labels, values, title, margin, y, pageWidth, heightMm) {
  // Canvas is built at EXACTLY the same aspect ratio as the box it'll be
  // placed into below - addImage stretches to fit whatever width/height
  // it's given, so any mismatch here previously showed up as a visibly
  // squashed/compressed chart
  const boxWidthMm = pageWidth - margin * 2
  const canvasWidth = 1000
  const canvasHeight = Math.round(canvasWidth / (boxWidthMm / heightMm))
  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#4a4a8e',
        backgroundColor: 'rgba(74,74,142,0.12)',
        fill: true,
        tension: 0.35,
        borderWidth: 3,
        pointRadius: 0
      }]
    },
    options: {
      responsive: false,
      animation: false,
      devicePixelRatio: 2,
      layout: { padding: { top: 6, right: 10, bottom: 2, left: 4 } },
      plugins: {
        legend: { display: false },
        title: { display: !!title, text: title, color: '#333333', font: { size: 15, weight: 'bold' }, padding: { bottom: 10 } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#888888', font: { size: 11 }, autoSkip: true, maxTicksLimit: 6 } },
        y: { grid: { color: '#eeeeee' }, ticks: { color: '#888888', font: { size: 11 } } }
      }
    },
    plugins: [{
      id: 'whiteBackground',
      beforeDraw: (c) => {
        const ctx = c.canvas.getContext('2d')
        ctx.save()
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.restore()
      }
    }]
  })

  const imgData = chart.toBase64Image()
  chart.destroy()

  doc.addImage(imgData, 'PNG', margin, y, pageWidth - margin * 2, heightMm)
  return y + heightMm + 4
}

async function generateReportPDF() {
  if (!reportDataCache) return
  if (!window.jspdf) {
    customAlert('The PDF library is still loading - please try again in a moment.')
    return
  }

  const range = buildReportRange(reportSelectedMonths)
  const MONTHS_LABELS = { 1: 'Last Month', 3: 'Last 3 Months', 6: 'Last 6 Months', 9: 'Last 9 Months', 12: 'Last 12 Months' }
  const periodLabel = MONTHS_LABELS[reportSelectedMonths] || `Last ${reportSelectedMonths} Months`

  const btn = document.getElementById('generatePdfBtn')
  btn.disabled = true
  btn.textContent = 'Generating…'

  try {
    const logo = await loadImageAsDataUrl('logo.png')

    const { jsPDF } = window.jspdf
    const doc = new jsPDF()
    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    const margin = 15
    let y = margin

    // Spacing constants, shared between the actual drawing code below and
    // the per-section height estimates sectionBlock() uses to decide
    // whether a whole section (heading + stats + chart) needs to move to
    // the next page together - keeping these in one place means the
    // estimate can never drift out of sync with what's actually drawn
    const HEADING_H = 8, HEADING_GAP = 3
    const TILE_H = 26, TILE_GAP = 6
    const CHART_H = 62, CHART_GAP = 5
    const EMPTY_LINE_H = 8
    const SECTION_GAP = 3
    const HEADING_TOTAL = HEADING_H + HEADING_GAP
    const TILE_TOTAL = TILE_H + TILE_GAP
    const CHART_TOTAL = CHART_H + CHART_GAP

    function ensureSpace(blockHeight) {
      if (y + blockHeight > pageHeight - margin) {
        doc.addPage()
        y = margin
      }
    }

    // Reserves room for an ENTIRE section (heading + stats + chart) in one
    // go, so a section only ever splits across a page break if it's too
    // tall to fit on any single page - never mid-way, e.g. heading+stats on
    // one page and its chart alone on the next
    function sectionBlock(totalHeight, drawFn) {
      if (totalHeight <= pageHeight - margin * 2) ensureSpace(totalHeight)
      drawFn()
    }

    // Colored banner bar, white bold text - reads as a real report section
    // divider rather than a plain bold line of text
    function heading(text) {
      ensureSpace(HEADING_TOTAL)
      doc.setFillColor(74, 74, 142)
      doc.rect(margin, y, pageWidth - margin * 2, HEADING_H, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(12)
      doc.setTextColor(255, 255, 255)
      doc.text(text, margin + 3, y + 5.5)
      doc.setTextColor(0, 0, 0)
      y += HEADING_TOTAL
    }

    // Boxed "stat card" tiles, same visual idea as the app's own .stat-item
    // tiles on the Overview/Metrics tabs - laid out left-aligned at a fixed
    // width so a single tile doesn't stretch awkwardly across the page.
    // The % change is drawn big and bold, since "did this go up or down" is
    // meant to be readable at a glance, not squinted at.
    function statTiles(items) {
      const tileWidth = 50
      const gap = 4
      ensureSpace(TILE_TOTAL)
      items.forEach((item, i) => {
        const x = margin + i * (tileWidth + gap)
        doc.setDrawColor(210, 210, 220)
        doc.setLineWidth(0.3)
        doc.roundedRect(x, y, tileWidth, TILE_H, 2, 2, 'S')

        doc.setFont('helvetica', 'bold')
        doc.setFontSize(12.5)
        doc.setTextColor(30, 30, 50)
        doc.text(String(item.value), x + tileWidth / 2, y + 9, { align: 'center' })

        doc.setFont('helvetica', 'normal')
        doc.setFontSize(7.5)
        doc.setTextColor(120, 120, 130)
        doc.text(item.label, x + tileWidth / 2, y + 14, { align: 'center' })

        if (item.delta) {
          // deltaPositive (when given) overrides the sign-based color guess,
          // since a metric can be "lower is better" - a negative change on
          // those should read green, not red, matching the app's own rule
          let isUp, isDown
          if (item.deltaPositive === true) { isUp = true; isDown = false }
          else if (item.deltaPositive === false) { isUp = false; isDown = true }
          else { isUp = item.delta.startsWith('+'); isDown = item.delta.startsWith('-') }
          doc.setFont('helvetica', 'bold')
          doc.setFontSize(11)
          if (isUp) doc.setTextColor(40, 140, 90)
          else if (isDown) doc.setTextColor(190, 70, 70)
          else doc.setTextColor(120, 120, 130)
          doc.text(item.delta, x + tileWidth / 2, y + 21, { align: 'center' })
          doc.setFont('helvetica', 'normal')
        }
      })
      doc.setTextColor(0, 0, 0)
      y += TILE_TOTAL
    }

    function emptyStateLine(text) {
      ensureSpace(EMPTY_LINE_H)
      doc.setFont('helvetica', 'italic')
      doc.setFontSize(9.5)
      doc.setTextColor(140, 140, 150)
      doc.text(text, margin, y)
      doc.setTextColor(0, 0, 0)
      doc.setFont('helvetica', 'normal')
      y += EMPTY_LINE_H
    }

    // jsPDF's built-in fonts don't support the ▲/▼ characters used
    // elsewhere in the app (they're outside WinAnsi encoding and render as
    // garbled glyphs, e.g. a stray superscript mark next to the %) - a
    // leading +/- sign is fully supported and reads just as clearly
    function deltaText(current, previous) {
      if (previous == null || current == null || previous === 0) return null
      const pct = Math.round(((current - previous) / Math.abs(previous)) * 100)
      if (pct === 0) return null
      return `${pct > 0 ? '+' : ''}${pct}%`
    }

    // ---- Header: logo + athlete name/title on the left, the chosen time
    // period as its own large callout on the right (so which period this
    // report covers is visible at a glance, not buried in small print) ----
    const logoHeight = 22
    let logoWidth = 0
    if (logo) {
      logoWidth = (logo.width / logo.height) * logoHeight
      doc.addImage(logo.dataUrl, 'PNG', margin, y, logoWidth, logoHeight)
    }
    const textX = margin + (logo ? logoWidth + 7 : 0)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(18)
    doc.setTextColor(30, 30, 50)
    doc.text(currentAthlete ? currentAthlete.name : 'Athlete', textX, y + 8)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(74, 74, 142)
    doc.text('PHYSICAL ABILITY REPORT', textX, y + 14)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(130, 130, 140)
    doc.text(`Generated ${toDateStrOv(new Date())}`, textX, y + 19.5)

    // Right-aligned period callout - the single biggest piece of text in
    // the header, since "which period is this" is the first thing a coach
    // should be able to tell at a glance
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(20)
    doc.setTextColor(74, 74, 142)
    doc.text(periodLabel, pageWidth - margin, y + 10, { align: 'right' })

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(130, 130, 140)
    doc.text(`${range.from} to ${range.to}`, pageWidth - margin, y + 16, { align: 'right' })

    doc.setTextColor(0, 0, 0)
    y += logoHeight + 6

    doc.setDrawColor(74, 74, 142)
    doc.setLineWidth(0.8)
    doc.line(margin, y, pageWidth - margin, y)
    y += 9

    for (const section of reportDataCache.availableSections) {
      if (!reportSelectedSections.has(section.key)) continue

      if (section.kind === 'overview') {
        const s = computeWorkoutOverviewSection(reportDataCache, range)
        sectionBlock(HEADING_TOTAL + TILE_TOTAL + SECTION_GAP, () => {
          heading('Workout Overview')
          statTiles([
            { label: 'Completion Rate', value: s.completion === null ? '—' : `${s.completion}%`, delta: deltaText(s.completion, s.prevCompletion) },
            { label: 'Total Volume', value: `${s.volumeKg.toLocaleString()}kg`, delta: deltaText(s.volumeKg, s.prevVolumeKg) },
            { label: 'Avg Session Duration', value: s.avgDurationMin === null ? '—' : formatDurationOv(s.avgDurationMin), delta: deltaText(s.avgDurationMin, s.prevAvgDurationMin) }
          ])
          y += SECTION_GAP
        })
      } else if (section.kind === 'plyo') {
        const s = computePlyoSection(reportDataCache, range)
        // A trend line needs at least 2 points IN THIS WINDOW - a short
        // window (e.g. 1 month) legitimately has 0 or 1 some of the time,
        // which isn't a bug, so say so instead of just showing nothing
        const hasChart = s.values.length > 1
        sectionBlock(HEADING_TOTAL + TILE_TOTAL + (hasChart ? CHART_TOTAL : EMPTY_LINE_H) + SECTION_GAP, () => {
          heading('Plyometric Load')
          statTiles([{ label: 'Total Load', value: s.totalInRange.toLocaleString(), delta: deltaText(s.totalInRange, s.totalPrev) }])
          if (hasChart) y = drawTrendChart(doc, s.dates, s.values, 'Plyometric Load Trend', margin, y, pageWidth, CHART_H)
          else emptyStateLine('Not enough data in this period to chart a trend.')
          y += SECTION_GAP
        })
      } else if (section.kind === 'metric') {
        const s = computeCustomMetricSection(section.metric, range)
        if (!s.hasData) {
          sectionBlock(HEADING_TOTAL + EMPTY_LINE_H + SECTION_GAP, () => {
            heading(section.metric.name)
            emptyStateLine('No data logged yet.')
            y += SECTION_GAP
          })
        } else {
          const hasChart = s.chartValues.length > 1
          const pctDelta = s.pct === null ? null : `${s.pct > 0 ? '+' : ''}${s.pct}%`
          const deltaPositive = s.pct === null || s.pct === 0 ? undefined : (section.metric.higher_is_better ? s.pct > 0 : s.pct < 0)
          sectionBlock(HEADING_TOTAL + TILE_TOTAL + (hasChart ? CHART_TOTAL : EMPTY_LINE_H) + SECTION_GAP, () => {
            heading(section.metric.name)
            statTiles([{ label: 'Latest', value: formatMetricValue(section.metric, s.latestValue), delta: pctDelta, deltaPositive }])
            if (hasChart) {
              const title = `${section.metric.name} Trend${s.chartUnit ? ' (' + s.chartUnit + ')' : ''}`
              y = drawTrendChart(doc, s.dates, s.chartValues, title, margin, y, pageWidth, CHART_H)
            } else {
              emptyStateLine('Not enough data in this period to chart a trend.')
            }
            y += SECTION_GAP
          })
        }
      }
    }

    const blobUrl = doc.output('bloburl')
    window.open(blobUrl, '_blank')
    document.getElementById('reportBuilderModal').classList.remove('active')
  } catch (err) {
    console.log('Error generating report PDF:', err)
    customAlert('Something went wrong generating the PDF - please try again')
  } finally {
    btn.disabled = false
    btn.textContent = '📄 Generate PDF'
  }
}