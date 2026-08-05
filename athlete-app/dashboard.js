// ==========================================================================
// ATHLETE DASHBOARD
// Works out which of 4 states a logged-in athlete is in (same as before -
// see checkAccountState), then for a real linked athlete lands on a Week
// view: a welcome header + a 7-day strip for the current week (next week
// unlocks only if the coach turned on can_preview_next_week for this
// athlete). Tapping a day opens a read-only preview of that day's
// exercises; tapping "Start Workout" (today only) begins a guided,
// one-exercise-at-a-time flow that records a real start/end time
// (workout_sessions). Checking a set is one-way (never un-checks) and
// retries on save failure instead of losing what was logged.
//
// Mirrors the shape of the coach's athlete-calendar.js (same nested query,
// same date-math helpers) but duplicated rather than imported - this is a
// separate mini-app with its own Supabase client (see athleteClient.js).
// ==========================================================================
import { supabase } from './athleteClient.js'

const pageContent = document.getElementById('pageContent')
const pageWrap = document.querySelector('.athlete-app-page')
const cardWrap = document.querySelector('.athlete-app-card')

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'index.html'
}

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'index.html'
})

// Guarded on athlete being loaded - the button's in the header, so it's on
// screen even during the brief "Loading..." state before athlete exists
document.getElementById('settingsBtn').addEventListener('click', function() {
  if (athlete) renderSettings()
})

document.getElementById('weeklyRecapCloseBtn').addEventListener('click', function() {
  document.getElementById('weeklyRecapModal').classList.remove('active')
})

let athlete = null
let entriesByDate = {} // 'YYYY-MM-DD' -> array of { program, week, day }
let logSetsByPE = {} // program_exercise_id -> array of exercise_log_sets rows, sorted by set_number
let openSessionsByDayId = {} // program_days.id -> in-progress workout_sessions row (ended_at is null)
let completedSessionsByDayId = {} // program_days.id -> most recently-ended workout_sessions row
let restTimerInterval = null
let currentWeekStart = null // Date (Monday) of the currently-shown week, for "back to week"

checkAccountState()

async function checkAccountState() {
  const { data: profile, error: profileError } = await saveWithRetry((signal) => supabase
    .from('profiles')
    .select('role, name')
    .eq('id', session.user.id)
    .single()
    .abortSignal(signal)
  )

  if (profileError || !profile || profile.role !== 'athlete') {
    renderWrongRole()
    return
  }

  const { data: foundAthlete } = await saveWithRetry((signal) => supabase
    .from('athletes')
    .select('id, name, can_preview_next_week, weight_unit, weekly_recap_enabled')
    .eq('user_id', session.user.id)
    .maybeSingle()
    .abortSignal(signal)
  )

  if (foundAthlete) {
    athlete = foundAthlete
    await loadTrainingData()
    renderWeekView(startOfWeek(new Date()))
    maybeShowWeeklyRecap()
    flushPendingQueue() // not awaited - picks up anything left over from a previous session
    flushPendingSessionEnds()
    return
  }

  // Not linked yet - try to auto-link by matching the signup email against
  // an unclaimed athlete row (see claim_athlete_by_email() in the database)
  const { error: claimError } = await supabase.rpc('claim_athlete_by_email')

  if (!claimError) {
    window.location.reload()
    return
  }

  renderWaitingToBeLinked()
}

function renderWrongRole() {
  pageContent.innerHTML = `
    <h2>Wrong login</h2>
    <p>This is the athlete login, and this account isn't set up as an athlete. If you're a coach, use the main TBFlog login instead.</p>
    <button class="btn-save" id="signOutBtn">Sign Out</button>
  `
  document.getElementById('signOutBtn').addEventListener('click', async function() {
    await supabase.auth.signOut()
    window.location.href = 'index.html'
  })
}

function renderWaitingToBeLinked() {
  pageContent.innerHTML = `
    <h2>Almost there</h2>
    <p>Your coach hasn't linked your account yet. Once they've added your email to your athlete profile, click below to try again.</p>
    <button class="btn-save" id="retryBtn">Try Again</button>
  `
  document.getElementById('retryBtn').addEventListener('click', checkAccountState)
}

// A place for per-athlete settings that live outside the coach-editable
// Settings tab (which is on the coach's own athlete page) - this one is
// self-service, for things the athlete should be able to change themselves.
// Weekly recap here is opt-in only for now - actually sending one is a
// separate, bigger piece of work (not built yet), this just captures the
// preference so it's ready to use once that exists.
function renderSettings() {
  pageContent.innerHTML = `
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
    <button class="btn-cancel" id="backFromSettingsBtn" style="margin-top:20px">Go Back</button>
  `

  document.getElementById('backFromSettingsBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
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
}

// ==========================================================================
// ---- DATE HELPERS ----
// Same timezone-safe parsing convention used throughout the app
// (new Date(dateStr + 'T00:00:00')) - building YYYY-MM-DD strings by hand
// rather than via .toISOString(), which re-introduces an off-by-one bug.
// ==========================================================================
function toDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseDateStr(dateStr) {
  return new Date(dateStr + 'T00:00:00')
}

function formatDisplayDate(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
}

function formatShortDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function resolveDate(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStr(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStr(result)
}

function startOfWeek(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day // shift back to Monday
  d.setDate(d.getDate() + diff)
  return d
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function trainingDisplayName(entry) {
  if (entry.program.is_adhoc) return entry.program.name || 'Training'
  return entry.day.label || ('Day ' + entry.day.day_number)
}

// ==========================================================================
// ---- WEIGHT UNITS ----
// Weight is always STORED in kg (the app-wide metric-units rule) - these
// only convert for display/typing. kgToLbs/lbsToKg are the raw conversion,
// formatWeight is what render code should call: converts kg into whichever
// unit it's given and rounds to 1 decimal so the input doesn't fill up with
// long floating-point tails (e.g. 100kg -> 220.5 lbs, not 220.46226218).
// ==========================================================================
function kgToLbs(kg) { return kg * 2.2046226218 }
function lbsToKg(lbs) { return lbs / 2.2046226218 }

function formatWeight(kg, unit) {
  if (kg == null) return null
  const val = unit === 'lbs' ? kgToLbs(kg) : kg
  return Math.round(val * 10) / 10
}

// The inverse of formatWeight - what a set row uses to turn a typed number
// (in whatever unit that row is currently set to) back into kg before it's
// ever saved, so the database never has to know a set was entered in lbs
function weightToKg(value, unit) {
  return unit === 'lbs' ? lbsToKg(value) : value
}

// ==========================================================================
// ---- LOAD TRAINING DATA ----
// One nested query for the whole schedule, one flat query for every set
// this athlete has logged, one flat query for any in-progress workout
// session - small datasets for a solo coach's athlete, no date filtering.
// ==========================================================================
async function loadTrainingData() {
  // These 3 queries don't depend on each other's results, so they fire
  // together instead of waiting on each other one at a time - on a slow
  // connection this also means one retry sequence doesn't delay the start
  // of the other two
  const [
    { data, error },
    { data: logSets, error: logError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    saveWithRetry((signal) => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises(name, category, type, video_url, foot_contacts, intensity_tier, tracks_weight, is_timed, is_unilateral))))')
      .eq('athlete_id', athlete.id)
      .eq('is_template', false)
      .abortSignal(signal)
    ),
    saveWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .select('*')
      .eq('athlete_id', athlete.id)
      .abortSignal(signal)
    ),
    saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('*')
      .eq('athlete_id', athlete.id)
      .abortSignal(signal)
    )
  ])

  if (error) { console.log('Error loading training data:', error); return }
  if (logError) { console.log('Error loading logged sets:', logError); return }
  if (sessionsError) { console.log('Error loading sessions:', sessionsError); return }

  entriesByDate = {}
  for (const program of data) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        const dateStr = resolveDate(program.start_date, week.week_number, day.day_number)
        if (!entriesByDate[dateStr]) entriesByDate[dateStr] = []
        entriesByDate[dateStr].push({ program, week, day })
      }
    }
  }

  logSetsByPE = {}
  for (const row of logSets) {
    if (!logSetsByPE[row.program_exercise_id]) logSetsByPE[row.program_exercise_id] = []
    logSetsByPE[row.program_exercise_id].push(row)
  }
  for (const peId in logSetsByPE) {
    logSetsByPE[peId].sort((a, b) => a.set_number - b.set_number)
  }

  openSessionsByDayId = {}
  completedSessionsByDayId = {}
  for (const s of sessions) {
    if (!s.ended_at) {
      openSessionsByDayId[s.program_day_id] = s
      continue
    }
    // Keep the most recently-ended one per day, in case a workout got
    // started and finished more than once for the same day
    const existing = completedSessionsByDayId[s.program_day_id]
    if (!existing || s.ended_at > existing.ended_at) completedSessionsByDayId[s.program_day_id] = s
  }

  // Re-apply anything still waiting in the local outbox on top of the
  // server data just loaded - a set that hasn't synced yet should still
  // show as checked/unchecked after a reload, not silently reset
  applyPendingQueueLocally()
}

// A program_exercise only ever resolves to one calendar date, so scanning
// the in-memory tree by id (instead of an extra query) is enough
function findPE(peId) {
  for (const dateStr in entriesByDate) {
    for (const entry of entriesByDate[dateStr]) {
      const pe = entry.day.program_exercises.find(p => p.id === peId)
      if (pe) return pe
    }
  }
  return null
}

// "Every prescribed set across every exercise scheduled has a completed_at"
function dayIsFullyLogged(entries) {
  if (entries.length === 0) return false
  let totalSets = 0
  let doneSets = 0
  for (const entry of entries) {
    for (const pe of entry.day.program_exercises) {
      const prescribed = pe.prescribed_sets || 1
      totalSets += prescribed
      const logged = logSetsByPE[pe.id] || []
      doneSets += logged.filter(s => s.completed_at && s.set_number <= prescribed).length
    }
  }
  return totalSets > 0 && doneSets >= totalSets
}

// "12/10/8 reps @ 50kg" when only reps vary across sets, "12@40kg, 10@45kg,
// 8@50kg" for a real pyramid (both reps and weight differ per set). Returns
// null when this exercise has no per-set targets yet, so targetLine() can
// fall back to its old single-value summary for pre-pyramid data.
function formatSetTargets(setTargets, isTimed, tracksWeight) {
  if (!setTargets || setTargets.length === 0) return null
  const unit = athlete.weight_unit || 'kg'
  if (isTimed && !tracksWeight) return setTargets.map(s => s.reps || '-').join(' / ')
  if (isTimed && tracksWeight) return setTargets.map(s => `${s.reps || '-'}${s.weight != null ? ' @ ' + formatWeight(s.weight, unit) + unit : ''}`).join(', ')
  const sameWeight = setTargets.every(s => s.weight === setTargets[0].weight)
  if (sameWeight) {
    const reps = setTargets.map(s => s.reps || '-').join('/')
    return `${reps} reps${setTargets[0].weight != null ? ' @ ' + formatWeight(setTargets[0].weight, unit) + unit : ''}`
  }
  return setTargets.map(s => `${s.reps || '-'}${s.weight != null ? '@' + formatWeight(s.weight, unit) + unit : ''}`).join(', ')
}

function targetLine(pe) {
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const setTargetsText = formatSetTargets(pe.set_targets, isTimed, tracksWeight)
  const parts = []
  if (setTargetsText) {
    parts.push(setTargetsText)
  } else {
    if (pe.prescribed_sets) parts.push(`${pe.prescribed_sets} sets`)
    if (pe.prescribed_reps) parts.push(isTimed ? pe.prescribed_reps : `${pe.prescribed_reps} reps`)
    if (pe.prescribed_weight && tracksWeight) parts.push(`${formatWeight(pe.prescribed_weight, athlete.weight_unit)}${athlete.weight_unit || 'kg'}`)
  }
  if (pe.extra_fields) {
    for (const [k, v] of Object.entries(pe.extra_fields)) parts.push(`${k}: ${v}`)
  }
  return parts.join(' × ')
}

// ==========================================================================
// ---- INLINE VIDEO ----
// YouTube thumbnails/embeds are available at predictable URLs from just the
// video id, no API key needed. Other hosts fall back to opening a new tab.
// Tapping a thumbnail swaps it for a playing embed right in place - no
// overlay/modal covering the screen.
// ==========================================================================
function getYouTubeThumbnail(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg` : null
}

function getYouTubeEmbedUrl(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://www.youtube.com/embed/${match[1]}?autoplay=1` : null
}

function playInlineVideo(containerEl, url) {
  if (!url) return
  const embedUrl = getYouTubeEmbedUrl(url)
  if (!embedUrl) { window.open(url, '_blank'); return }
  containerEl.innerHTML = `<iframe src="${embedUrl}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`
}

// ==========================================================================
// ---- WEEK VIEW (default landing) ----
// ==========================================================================
function renderWeekView(weekStart) {
  clearRestTimer()
  currentWeekStart = weekStart
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  // Next should stay enabled all the way back up from any past week, not
  // just when weekStart happens to be exactly today's week - it only locks
  // once you'd step past the furthest week this athlete is allowed to see
  const realCurrentWeekStart = startOfWeek(new Date())
  const maxAllowedWeekStart = athlete.can_preview_next_week ? addDays(realCurrentWeekStart, 7) : realCurrentWeekStart
  const nextEnabled = toDateStr(weekStart) < toDateStr(maxAllowedWeekStart)

  const todayStr = toDateStr(new Date())
  const days = []
  for (let i = 0; i < 7; i++) days.push(addDays(weekStart, i))

  const cardsHtml = days.map(date => {
    const dateStr = toDateStr(date)
    const entries = entriesByDate[dateStr] || []
    const names = [...new Set(entries.map(trainingDisplayName))]
    const done = dayIsFullyLogged(entries)

    const classes = ['week-day-card']
    if (dateStr === todayStr) classes.push('today')
    if (done) classes.push('done')

    return `
      <div class="${classes.join(' ')}" data-date="${dateStr}">
        <span class="week-day-name">${DAY_NAMES[date.getDay() === 0 ? 6 : date.getDay() - 1]}</span>
        <span class="week-day-number">${date.getDate()}</span>
        ${names.map(name => `<span class="week-day-badge">${done ? '✓ ' : ''}${name}</span>`).join('')}
      </div>
    `
  }).join('')

  const pendingCount = loadPendingQueue().length

  pageContent.innerHTML = `
    <div class="welcome-header">
      <h2>Welcome back, ${athlete.name}</h2>
      <p>Here's your training for the week</p>
    </div>
    ${renderSyncBannerHtml(pendingCount)}
    <div class="week-nav-row">
      <button class="btn-cancel" id="weekPrevBtn">← Prev</button>
      <h3>${formatShortDate(days[0])} – ${formatShortDate(days[6])}</h3>
      <button class="btn-cancel" id="weekNextBtn" ${nextEnabled ? '' : 'disabled'}>Next →</button>
    </div>
    <div class="week-strip">${cardsHtml}</div>
  `

  document.querySelectorAll('.week-day-card').forEach(cardEl => {
    cardEl.addEventListener('click', function() { renderDayPreview(cardEl.dataset.date) })
  })

  document.getElementById('weekPrevBtn').addEventListener('click', function() {
    renderWeekView(addDays(weekStart, -7))
  })
  document.getElementById('weekNextBtn').addEventListener('click', function() {
    if (nextEnabled) renderWeekView(addDays(weekStart, 7))
  })

  wireSyncBanner(function() { renderWeekView(weekStart) })
}

// ==========================================================================
// ---- SYNC STATUS BANNER ----
// Makes the pending-save queue visible instead of silent - a set that
// hasn't reached the server yet shows up here with the ACTUAL error from
// the last failed attempt (not just an invisible tooltip, which doesn't
// work on touch anyway) and a manual "Retry now" button. Shown on the week
// view since that's what's on screen right after finishing a workout.
// ==========================================================================
function renderSyncBannerHtml(pendingCount) {
  if (pendingCount === 0) return ''

  const withError = loadPendingQueue().find(e => e.lastError)
  const errorLine = withError ? `Last error: ${withError.lastError}` : 'Still trying automatically in the background.'

  return `
    <div class="sync-banner" id="syncBanner">
      <div>
        <strong>${pendingCount} set${pendingCount === 1 ? '' : 's'} not synced yet</strong>
        <div class="sync-banner-detail">${errorLine}</div>
      </div>
      <div style="display:flex; gap:8px">
        <button type="button" class="btn-cancel" id="syncRetryBtn">Retry Now</button>
        <button type="button" class="btn-cancel" id="syncDismissBtn">Dismiss</button>
      </div>
    </div>
  `
}

function wireSyncBanner(onDone) {
  const retryBtn = document.getElementById('syncRetryBtn')
  const dismissBtn = document.getElementById('syncDismissBtn')
  if (!retryBtn) return

  retryBtn.addEventListener('click', async function() {
    retryBtn.disabled = true
    retryBtn.textContent = 'Retrying...'
    await flushPendingQueue()
    onDone()
  })

  // Only offered as a last resort once retrying keeps failing - this
  // permanently throws away whatever wasn't saved, since there's no other
  // way to clear a stuck queue from a phone (no browser console access
  // there the way there is on desktop)
  dismissBtn.addEventListener('click', async function() {
    const count = loadPendingQueue().length
    const ok = await customConfirm(`Discard ${count} unsynced set${count === 1 ? '' : 's'}? They never saved to the server, so this can't be undone - only do this if you don't need this data.`)
    if (!ok) return
    savePendingQueueToStorage([])
    onDone()
  })
}

// ==========================================================================
// ---- WEEKLY RECAP POPUP ----
// Shows a "here's what you did last week" popup at most once per week, the
// first time the athlete opens the app that week (not an actual push
// notification - see the weekly_recap_enabled setting's comment for why).
// Tracked in localStorage rather than the database since it's purely a
// "have I already shown this on this device" flag, not something the coach
// or any other device needs to know about.
// ==========================================================================
function maybeShowWeeklyRecap() {
  if (!athlete.weekly_recap_enabled) return

  const thisWeekKey = toDateStr(startOfWeek(new Date()))
  if (localStorage.getItem('tbflog-recap-shown-week') === thisWeekKey) return

  const lastWeekStart = addDays(startOfWeek(new Date()), -7)
  const stats = computeWeekRecap(lastWeekStart)
  localStorage.setItem('tbflog-recap-shown-week', thisWeekKey)

  // Nothing happened last week (e.g. a brand new athlete) - showing an
  // empty recap isn't useful, so skip the popup but still mark it seen
  if (stats.totalWorkouts === 0 && stats.totalSets === 0) return

  showWeeklyRecapModal(stats)
}

function computeWeekRecap(weekStart) {
  let totalWorkouts = 0
  let totalSets = 0
  let totalReps = 0
  let totalDurationMs = 0

  for (let i = 0; i < 7; i++) {
    const dateStr = toDateStr(addDays(weekStart, i))
    const entries = entriesByDate[dateStr] || []
    for (const entry of entries) {
      const session = completedSessionsByDayId[entry.day.id]
      if (!session) continue // only count workouts that were actually finished

      totalWorkouts++
      totalDurationMs += new Date(session.ended_at) - new Date(session.started_at)

      for (const pe of entry.day.program_exercises) {
        const sets = (logSetsByPE[pe.id] || []).filter(s => s.completed_at)
        totalSets += sets.length
        for (const s of sets) {
          const reps = parseInt(s.actual_reps)
          if (!isNaN(reps)) totalReps += reps
        }
      }
    }
  }

  return { totalWorkouts, totalSets, totalReps, totalDurationMs }
}

// A little tiered feel-good message rather than one fixed line - a quiet
// week gets encouragement to jump back in, not silence or a guilt trip
function pickRecapMessage(totalWorkouts) {
  if (totalWorkouts === 0) return "A quiet week - let's get back into it this week 💪"
  if (totalWorkouts <= 2) return 'Nice work getting sessions in - keep building on it!'
  return 'Great consistency last week - keep it up! 🔥'
}

function showWeeklyRecapModal(stats) {
  const durationMin = Math.round(stats.totalDurationMs / 60000)
  const durationText = durationMin >= 60 ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m` : `${durationMin}m`

  document.getElementById('weeklyRecapBody').innerHTML = `
    <div class="workout-summary-stats" style="flex-wrap:wrap; gap:20px">
      <div><div class="workout-summary-stat-value">${stats.totalWorkouts}</div><div class="workout-summary-stat-label">Workouts</div></div>
      <div><div class="workout-summary-stat-value">${stats.totalSets}</div><div class="workout-summary-stat-label">Sets</div></div>
      <div><div class="workout-summary-stat-value">${stats.totalReps}</div><div class="workout-summary-stat-label">Reps</div></div>
      <div><div class="workout-summary-stat-value">${durationText}</div><div class="workout-summary-stat-label">Time</div></div>
    </div>
    <p style="margin-top:20px; color:#aaaacc; text-align:center">${pickRecapMessage(stats.totalWorkouts)}</p>
  `
  document.getElementById('weeklyRecapModal').classList.add('active')
}

// ==========================================================================
// ---- DAY PREVIEW (read-only, no logging inputs) ----
// ==========================================================================
function renderDayPreview(dateStr) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const isToday = dateStr === toDateStr(new Date())
  const entries = entriesByDate[dateStr] || []

  const bodyHtml = entries.length === 0
    ? '<p class="no-metrics">Rest day — nothing scheduled</p>'
    : entries.map(entry => renderDayPreviewGroup(entry, isToday)).join('')

  pageContent.innerHTML = `
    <div class="day-view-header">
      <h2>${isToday ? 'Today' : formatDisplayDate(dateStr)}</h2>
      <button class="btn-cancel" id="backToWeekBtn">Go Back</button>
    </div>
    ${isToday ? `<p class="day-view-date">${formatDisplayDate(dateStr)}</p>` : ''}
    ${renderSyncBannerHtml(loadPendingQueue().length)}
    <div id="dayPreviewBody">${bodyHtml}</div>
  `

  document.getElementById('backToWeekBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

  wireSyncBanner(function() { renderDayPreview(dateStr) })

  document.getElementById('dayPreviewBody').addEventListener('click', function(e) {
    const thumbBtn = e.target.closest('[data-video-url]')
    if (thumbBtn) playInlineVideo(thumbBtn, thumbBtn.dataset.videoUrl)
  })

  entries.forEach(entry => {
    const startBtn = document.getElementById('startWorkoutBtn-' + entry.day.id)
    if (startBtn) startBtn.addEventListener('click', function() { startWorkout(entry, dateStr) })

    const summaryBtn = document.getElementById('viewSummaryBtn-' + entry.day.id)
    if (summaryBtn) summaryBtn.addEventListener('click', function() {
      renderWorkoutSummary(completedSessionsByDayId[entry.day.id], entry)
    })
  })
}

function renderDayPreviewGroup(entry, isToday) {
  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  const openSession = openSessionsByDayId[entry.day.id]
  const completedSession = completedSessionsByDayId[entry.day.id]

  // "Active" = today, with nothing ended yet - keep the preview clean (no
  // logged-value clutter) right up until Start/Continue is pressed. Once a
  // session's been explicitly ended, or the day's in the past, show what
  // was actually logged instead - that's the useful thing to see by then.
  const isActive = isToday && !completedSession
  const showLoggedValues = !isActive

  let actionButton = ''
  if (exercises.length > 0) {
    if (completedSession && !openSession) {
      actionButton = `<button type="button" class="start-workout-btn" id="viewSummaryBtn-${entry.day.id}">📋 View Summary</button>`
    } else if (isToday) {
      actionButton = `<button type="button" class="start-workout-btn" id="startWorkoutBtn-${entry.day.id}">${openSession ? '▶ Continue Workout' : '▶ Start Workout'}</button>`
    }
  }

  return `
    <div class="detail-group">
      <h4 class="detail-group-title">${trainingDisplayName(entry)}</h4>
      ${exercises.map(pe => renderDayPreviewExercise(pe, showLoggedValues)).join('')}
      ${actionButton}
    </div>
  `
}

function renderDayPreviewExercise(pe, showLogged) {
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const target = targetLine(pe)

  let loggedText = ''
  if (showLogged) {
    const sets = (logSetsByPE[pe.id] || []).filter(s => s.completed_at).sort((a, b) => a.set_number - b.set_number)
    loggedText = sets.map(s => {
      const repsPart = isTimed ? (s.actual_reps || '-') : `${s.actual_reps || '-'} reps`
      const weightPart = tracksWeight && s.actual_weight != null ? ' @ ' + formatWeight(s.actual_weight, athlete.weight_unit) + (athlete.weight_unit || 'kg') : ''
      return repsPart + weightPart
    }).join(', ')
  }

  return `
    <div class="day-preview-exercise">
      <button type="button" class="day-preview-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="day-preview-thumb-placeholder">🏋</span>'}
      </button>
      <div class="day-preview-info">
        <div class="day-preview-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${target ? `<div class="day-preview-target">Target: ${target}</div>` : ''}
        ${loggedText ? `<div class="day-preview-logged">Logged: ${loggedText}</div>` : ''}
      </div>
    </div>
  `
}

// ==========================================================================
// ---- ACTIVE WORKOUT (one exercise at a time) ----
// ==========================================================================
async function findOrCreateSession(programDayId) {
  const { data: existing, error: findError } = await saveWithRetry((signal) => supabase
    .from('workout_sessions')
    .select('*')
    .eq('program_day_id', programDayId)
    .eq('athlete_id', athlete.id)
    .is('ended_at', null)
    .maybeSingle()
    .abortSignal(signal)
  )

  if (findError) { console.log(findError) }
  if (existing) return existing

  const { data: newSession, error: insertError } = await saveWithRetry((signal) => supabase
    .from('workout_sessions')
    .insert([{ program_day_id: programDayId, athlete_id: athlete.id }])
    .select()
    .single()
    .abortSignal(signal)
  )

  if (insertError) { console.log(insertError); customAlert('Something went wrong starting the workout'); throw insertError }
  return newSession
}

// Resumes at the first exercise whose prescribed sets aren't all logged yet
// - derived from already-loaded logSetsByPE, no extra column needed
function findResumeIndex(exercises) {
  for (let i = 0; i < exercises.length; i++) {
    const pe = exercises[i]
    const prescribed = pe.prescribed_sets || 1
    const logged = (logSetsByPE[pe.id] || []).filter(s => s.completed_at && s.set_number <= prescribed)
    if (logged.length < prescribed) return i
  }
  return Math.max(exercises.length - 1, 0)
}

// Renders the first exercise immediately - findResumeIndex only needs data
// already loaded in memory, no network required. findOrCreateSession does
// need a round trip (look up an in-progress session, or create one), but
// nothing on screen actually needs the session row until End Workout is
// pressed, so it's kicked off in the background instead of being awaited
// here - awaiting it first was the actual cause of "pressing Start Workout
// does nothing for a second or more", especially on a slow connection.
function startWorkout(entry, dateStr) {
  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  if (exercises.length === 0) { customAlert('No exercises in this training'); return }

  const sessionPromise = findOrCreateSession(entry.day.id).then(function(session) {
    openSessionsByDayId[entry.day.id] = session
    return session
  })
  const resumeIndex = findResumeIndex(exercises)
  renderActiveExercise(entry, dateStr, exercises, resumeIndex, sessionPromise)
}

// direction: 1 when arriving from a Next/swipe-left (new slide enters from
// the right), -1 from Previous/swipe-right (enters from the left), omitted
// for the very first exercise shown (no animation, nothing to slide from)
function renderActiveExercise(entry, dateStr, exercises, index, sessionPromise, direction) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const pe = exercises[index]
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const isLast = index === exercises.length - 1
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)

  const loggedSets = logSetsByPE[pe.id] || []
  const rowCount = Math.max(pe.prescribed_sets || 1, loggedSets.length)
  let rowsHtml = ''
  for (let setNumber = 1; setNumber <= rowCount; setNumber++) {
    const logged = loggedSets.find(s => s.set_number === setNumber)
    const isExtra = setNumber > (pe.prescribed_sets || 0)
    rowsHtml += renderSetRow(pe, setNumber, logged, isTimed, tracksWeight, isExtra)
  }

  pageContent.innerHTML = `
    <p class="active-exercise-progress">Exercise ${index + 1} of ${exercises.length}</p>
    <div id="activeExerciseCard" class="workout-slide" data-pe-id="${pe.id}">
      <button type="button" class="active-exercise-thumb" id="activeExerciseThumbBtn" ${videoUrl ? '' : 'disabled'}>
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="active-exercise-thumb-placeholder">🏋</span>'}
      </button>
      <div class="active-exercise-title">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
      ${pe.notes ? `<p class="exercise-log-notes">${pe.notes}</p>` : ''}
      <div class="set-rows" data-pe-id="${pe.id}">${rowsHtml}</div>
      <button type="button" class="add-set-btn" data-action="add-set">+ Add Set</button>
    </div>
    <p class="swipe-hint"><span class="swipe-hint-arrow">‹</span> Swipe for next exercise <span class="swipe-hint-arrow">›</span></p>
    <div id="restTimerBar" class="rest-timer-bar"></div>
  `

  document.getElementById('activeExerciseThumbBtn').addEventListener('click', function() {
    playInlineVideo(this, videoUrl)
  })

  wireExerciseCardEvents('activeExerciseCard', dateStr)

  attachSwipeHandlers(
    function onSwipeLeft() {
      if (isLast) renderEndOfWorkoutSlide(entry, dateStr, exercises, sessionPromise, 1)
      else renderActiveExercise(entry, dateStr, exercises, index + 1, sessionPromise, 1)
    },
    // Passing null (instead of a function that no-ops on index 0) matters:
    // attachSwipeHandlers plays the slide-out-off-screen animation whenever
    // a callback is present at all, whether or not it actually goes
    // anywhere - on the first exercise that meant the card would slide
    // fully off screen and just leave a blank gap, since there's no
    // previous exercise to replace it with.
    index > 0 ? function onSwipeRight() {
      renderActiveExercise(entry, dateStr, exercises, index - 1, sessionPromise, -1)
    } : null
  )

  mountSlide(direction)
}

// Reached by pressing Next (or swiping left) on the last exercise - the
// only place "End Workout" lives now, instead of a persistent link on
// every slide
function renderEndOfWorkoutSlide(entry, dateStr, exercises, sessionPromise, direction) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  pageContent.innerHTML = `
    <p class="active-exercise-progress">Workout Complete</p>
    <div class="workout-summary workout-slide">
      <h2>Nice work 💪</h2>
      <p style="color:#aaaacc">That's every exercise. Ready to finish up?</p>
      <button class="btn-save start-workout-btn" id="endWorkoutBtn">End Workout</button>
    </div>
    <p class="swipe-hint"><span class="swipe-hint-arrow">‹</span> Swipe to go back</p>
  `

  document.getElementById('endWorkoutBtn').addEventListener('click', function() {
    finishWorkout(entry, sessionPromise)
  })

  attachSwipeHandlers(
    null, // already the last slide, nothing to swipe forward to
    function onSwipeRight() {
      renderActiveExercise(entry, dateStr, exercises, exercises.length - 1, sessionPromise, -1)
    }
  )

  mountSlide(direction)
}

// ==========================================================================
// ---- SWIPE NAVIGATION ----
// Drags the current ".workout-slide" 1:1 with the finger, and snaps it out
// (then calls the nav callback) once a horizontal drag clears the
// threshold. Uses the Pointer Events API so touch, mouse, and pen all work
// through one code path. Pointer capture is only taken once a drag is
// confirmed horizontal - never on a plain tap - so taps on set-row inputs/
// buttons inside the slide are completely unaffected.
// ==========================================================================
function mountSlide(direction) {
  const slide = document.querySelector('.workout-slide')
  if (!slide || !direction) return
  slide.style.transition = 'none'
  slide.style.transform = `translateX(${direction * 100}%)`
  // Two rAFs: the first lets the browser paint the off-screen starting
  // position, the second then starts the transition to translateX(0)
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      slide.style.transition = 'transform 0.2s ease-out'
      slide.style.transform = 'translateX(0)'
      // Clear the transition once it's done so a later drag on this same
      // slide gets instant 1:1 tracking instead of fighting a leftover
      // animation duration
      setTimeout(function() { slide.style.transition = '' }, 220)
    })
  })
}

function attachSwipeHandlers(onSwipeLeft, onSwipeRight) {
  const slide = document.querySelector('.workout-slide')
  if (!slide) return

  let startX = 0
  let startY = 0
  let currentX = 0
  let dragging = false
  let horizontal = false

  slide.addEventListener('pointerdown', function(e) {
    if (e.target.closest('input, button, iframe, select, textarea')) return
    startX = e.clientX
    startY = e.clientY
    currentX = startX
    dragging = true
    horizontal = false
  })

  slide.addEventListener('pointermove', function(e) {
    if (!dragging) return
    currentX = e.clientX
    const deltaX = currentX - startX
    const deltaY = e.clientY - startY

    if (!horizontal) {
      if (Math.abs(deltaX) < 10) return
      if (Math.abs(deltaX) < Math.abs(deltaY) * 1.5) { dragging = false; return } // vertical scroll, not a swipe
      horizontal = true
      slide.classList.add('dragging')
      slide.style.transition = 'none'
      slide.setPointerCapture(e.pointerId)
    }

    slide.style.transform = `translateX(${deltaX}px)`
  })

  function endDrag(e) {
    if (!dragging) return
    dragging = false
    if (!horizontal) return
    slide.classList.remove('dragging')

    const deltaX = currentX - startX
    const threshold = 70

    if (deltaX <= -threshold && onSwipeLeft) {
      slideOut(-1, onSwipeLeft)
    } else if (deltaX >= threshold && onSwipeRight) {
      slideOut(1, onSwipeRight)
    } else {
      slide.style.transition = 'transform 0.2s ease-out'
      slide.style.transform = 'translateX(0)'
    }
  }

  function slideOut(direction, callback) {
    slide.style.transition = 'transform 0.18s ease-in'
    slide.style.transform = `translateX(${direction * 100}%)`
    setTimeout(callback, 180)
  }

  slide.addEventListener('pointerup', endDrag)
  slide.addEventListener('pointercancel', endDrag)
}

// Goes straight to the summary the instant this is confirmed - it's built
// entirely from data already in memory (logSetsByPE, entry), so there's
// nothing worth waiting on here. Both saves below happen in the
// background: flushPendingQueue for any not-yet-synced sets (already
// durable on its own), and saveSessionEnd for marking this session ended,
// which falls into its own durable queue (see PENDING SESSION-END QUEUE
// below) if the immediate attempt fails - so a bad connection just means
// that timestamp syncs a little late, invisibly, instead of blocking the
// athlete with an error the way a single unprotected save used to.
async function finishWorkout(entry, session) {
  if (!(await customConfirm('Finish this workout?'))) return

  // session is the promise kicked off back in startWorkout - by now (after
  // swiping through the whole workout) it's almost always already resolved,
  // so this await is normally instant
  session = await session

  const endedAt = new Date().toISOString()
  const finishedSession = { ...session, ended_at: endedAt }

  // Update local state directly instead of a full loadTrainingData()
  // reload - the week view (reached via the summary's Done button) needs
  // this day to show "View Summary" instead of "Continue Workout" right
  // away, without waiting on a fresh fetch
  completedSessionsByDayId[entry.day.id] = finishedSession
  delete openSessionsByDayId[entry.day.id]

  clearTimeout(flushTimer) // don't wait out the debounce - flush what's pending right now
  flushPendingQueue() // not awaited - runs in the background regardless
  saveSessionEnd(session.id, endedAt) // not awaited

  renderWorkoutSummary(finishedSession, entry)
}

function renderWorkoutSummary(finishedSession, entry) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const durationMs = new Date(finishedSession.ended_at) - new Date(finishedSession.started_at)
  const durationMin = Math.floor(durationMs / 60000)
  const durationSec = Math.floor((durationMs % 60000) / 1000)
  const durationText = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSec}s`
  // Rounded minutes, not the exact floor above - both the >180 cap check and
  // the edit input default work in whole minutes, not minutes+seconds
  const durationMinRounded = Math.round(durationMs / 60000)
  const needsDurationReview = durationMinRounded > 180

  // Volume = actual_weight x actual_reps, summed across every completed set
  // logged for this day's exercises - skips sets whose reps didn't parse as
  // a plain number (duration text, rep ranges left un-edited, etc.), and
  // skips any exercise that doesn't track weight at all
  let totalVolume = 0
  for (const pe of entry.day.program_exercises) {
    if (!pe.exercises || !pe.exercises.tracks_weight) continue
    const sets = logSetsByPE[pe.id] || []
    for (const s of sets) {
      if (!s.completed_at || s.actual_weight == null) continue
      const reps = parseInt(s.actual_reps)
      if (!isNaN(reps)) totalVolume += reps * s.actual_weight
    }
  }

  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  const breakdownHtml = exercises.map(pe => {
    const isTimed = pe.exercises && pe.exercises.is_timed
    const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
    const isPlyo = pe.exercises && pe.exercises.type === 'plyometric'
    const sets = (logSetsByPE[pe.id] || []).filter(s => s.completed_at).sort((a, b) => a.set_number - b.set_number)
    if (sets.length === 0) return ''

    // foot_contacts/intensity_tier are fixed per exercise (set once in the
    // Exercise Library), not logged per set - plyo_load is just that fixed
    // rate applied across however many sets were actually completed today
    const plyoMultiplier = { low: 1, moderate: 1.5, high: 2 }[pe.exercises && pe.exercises.intensity_tier] || 1
    const plyoLoad = isPlyo ? (pe.exercises.foot_contacts || 0) * plyoMultiplier * sets.length : null

    return `
      <div class="detail-group">
        <h4 class="detail-group-title">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</h4>
        <div class="pr-badges" id="prBadges-${pe.id}"></div>
        ${plyoLoad != null ? `<p class="plyo-load-line">Plyo Load: ${Math.round(plyoLoad)}</p>` : ''}
        <ul class="detail-list">
          ${sets.map(s => `
            <li class="detail-row">
              <span>Set ${s.set_number}</span>
              <span class="detail-row-value">${(isTimed ? (s.actual_reps || '-') : `${s.actual_reps || '-'} reps`) + (tracksWeight && s.actual_weight != null ? ' @ ' + formatWeight(s.actual_weight, athlete.weight_unit) + (athlete.weight_unit || 'kg') : '')}</span>
            </li>
          `).join('')}
        </ul>
      </div>
    `
  }).join('')

  pageContent.innerHTML = `
    <div class="workout-summary">
      <h2>Workout Complete 💪</h2>
      <div class="workout-summary-stats">
        <div>
          <div class="workout-summary-stat-value">${durationText}</div>
          <div class="workout-summary-stat-label">Duration</div>
          <button type="button" class="duration-edit-btn" id="durationEditBtn">✏ Edit</button>
        </div>
        <div>
          <div class="workout-summary-stat-value">${Math.round(formatWeight(totalVolume, athlete.weight_unit))}${athlete.weight_unit || 'kg'}</div>
          <div class="workout-summary-stat-label">Total Volume</div>
        </div>
      </div>
      ${needsDurationReview ? `<p class="duration-warning">This looks long — ${durationMinRounded}m. Forget to stop the timer? Tap Edit to fix it.</p>` : ''}
      <div class="duration-edit-row" id="durationEditRow" style="display:none">
        <input type="number" id="durationEditInput" min="1" value="${durationMinRounded}">
        <span>minutes</span>
        <button type="button" class="btn-save" id="durationSaveBtn">Save</button>
        <button type="button" class="btn-cancel" id="durationCancelBtn">Cancel</button>
      </div>
    </div>

    <div class="rpe-picker">
      <p class="rpe-picker-label">How hard did this workout feel? (Session RPE)</p>
      <div class="rpe-picker-row" id="rpePickerRow">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button type="button" class="rpe-btn ${finishedSession.session_rpe === n ? 'selected' : ''}" data-rpe="${n}">${n}</button>`).join('')}
      </div>
      <p class="rpe-picker-hint">1 = very easy, 10 = maximal effort</p>
    </div>

    ${breakdownHtml || '<p class="no-metrics">Nothing logged</p>'}
    <button class="btn-save start-workout-btn" id="summaryDoneBtn">Done</button>
  `

  document.getElementById('summaryDoneBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

  wireSummaryRpePicker(finishedSession)
  wireSummaryDurationEdit(finishedSession, entry)
  // Not awaited - the summary above is already fully usable from data
  // already in memory, same reasoning as why Start Workout no longer waits
  // on a network round trip before rendering. PR badges patch in once ready.
  loadAndRenderPRBadges(finishedSession, entry)
}

// Tapping a number saves instantly - same optimistic + saveWithRetry
// pattern as checkSet/uncheckSet, since this is one tap of one value, not a
// multi-field form (the coach builders' "one Save button" rule doesn't
// apply here)
function wireSummaryRpePicker(session) {
  const row = document.getElementById('rpePickerRow')
  if (!row) return

  row.addEventListener('click', async function(e) {
    const btn = e.target.closest('.rpe-btn')
    if (!btn) return
    const rpe = parseInt(btn.dataset.rpe)

    row.querySelectorAll('.rpe-btn').forEach(b => b.classList.remove('selected'))
    btn.classList.add('selected')
    session.session_rpe = rpe

    const { error } = await saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .update({ session_rpe: rpe })
      .eq('id', session.id)
      .abortSignal(signal)
    )

    if (error) {
      console.log(error)
      customAlert('Something went wrong saving your effort rating: ' + describeError(error))
    }
  })
}

// A correction, not part of the tap-to-log flow - reveals a plain minutes
// input rather than editing the raw timestamps directly, since athletes
// think in "it took about 50 minutes," not clock times
function wireSummaryDurationEdit(session, entry) {
  const editBtn = document.getElementById('durationEditBtn')
  const editRow = document.getElementById('durationEditRow')
  const input = document.getElementById('durationEditInput')
  const saveBtn = document.getElementById('durationSaveBtn')
  const cancelBtn = document.getElementById('durationCancelBtn')
  if (!editBtn) return

  editBtn.addEventListener('click', function() {
    editBtn.style.display = 'none'
    editRow.style.display = 'flex'
    input.focus()
  })

  cancelBtn.addEventListener('click', function() {
    editRow.style.display = 'none'
    editBtn.style.display = ''
  })

  saveBtn.addEventListener('click', async function() {
    const minutes = parseInt(input.value)
    if (isNaN(minutes) || minutes < 1) { customAlert('Enter a duration of at least 1 minute'); return }

    saveBtn.disabled = true
    saveBtn.textContent = 'Saving...'

    const newEndedAt = new Date(new Date(session.started_at).getTime() + minutes * 60000).toISOString()
    const { data, error } = await saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .update({ ended_at: newEndedAt })
      .eq('id', session.id)
      .select()
      .single()
      .abortSignal(signal)
    )

    if (error) {
      console.log(error)
      customAlert('Something went wrong saving the corrected duration: ' + describeError(error))
      saveBtn.disabled = false
      saveBtn.textContent = 'Save'
      return
    }

    // Re-render from scratch - recomputes the duration text/warning and
    // re-runs PR detection against the (now differently-dated) session
    renderWorkoutSummary(data, entry)
  })
}

// ==========================================================================
// ---- PR DETECTION ----
// Compares this session against every OTHER session ever logged for the
// same underlying exercise (matched by exercise_id, so history carries
// across different programs/weeks a coach has assigned it in - not just
// program_exercise_id, which is a new row every time it's reprogrammed).
// ==========================================================================

// Epley formula - the standard estimated-1RM most lifting apps use, since
// it fairly compares a heavy low-rep set against a lighter high-rep set,
// which comparing raw heaviest weight alone can't do
function estimatedOneRM(weight, reps) {
  return weight * (1 + reps / 30)
}

// One session's aggregate stats for one exercise, from its completed sets
function sessionExerciseStats(sets) {
  let volume = 0, totalReps = 0, maxWeight = 0, maxOneRM = 0
  for (const s of sets) {
    const reps = parseInt(s.actual_reps)
    const hasReps = !isNaN(reps)
    if (hasReps) totalReps += reps
    if (s.actual_weight != null) {
      if (s.actual_weight > maxWeight) maxWeight = s.actual_weight
      if (hasReps) {
        volume += reps * s.actual_weight
        const oneRM = estimatedOneRM(s.actual_weight, reps)
        if (oneRM > maxOneRM) maxOneRM = oneRM
      }
    }
  }
  return { volume, totalReps, maxWeight, maxOneRM, setCount: sets.length }
}

async function loadAndRenderPRBadges(session, entry) {
  const exerciseIds = [...new Set(entry.day.program_exercises.map(pe => pe.exercise_id))]
  if (exerciseIds.length === 0) return

  // Every program_exercises row (across every program/week this athlete has
  // ever had) that's ever pointed at one of today's exercises - RLS already
  // scopes this to the athlete's own programs
  const { data: pastPEs, error: peError } = await fetchWithRetry((signal) => supabase
    .from('program_exercises')
    .select('id, exercise_id')
    .in('exercise_id', exerciseIds)
    .abortSignal(signal)
  )
  if (peError) { console.log(peError); return }

  const exerciseIdByPEId = {}
  for (const pe of pastPEs) exerciseIdByPEId[pe.id] = pe.exercise_id
  const allPEIds = pastPEs.map(pe => pe.id)
  if (allPEIds.length === 0) return

  const { data: pastSets, error: setsError } = await fetchWithRetry((signal) => supabase
    .from('exercise_log_sets')
    .select('*')
    .in('program_exercise_id', allPEIds)
    .not('completed_at', 'is', null)
    .abortSignal(signal)
  )
  if (setsError) { console.log(setsError); return }

  // One bucket per (exercise_id, date) - a proxy for "one session", the
  // same date-based grouping this app already uses elsewhere (there's no
  // workout_sessions link on exercise_log_sets to group by directly)
  const buckets = {}
  for (const s of pastSets) {
    const exerciseId = exerciseIdByPEId[s.program_exercise_id]
    const key = `${exerciseId}|${s.date}`
    if (!buckets[key]) buckets[key] = []
    buckets[key].push(s)
  }

  const todayStr = toDateStr(new Date(session.started_at))

  for (const pe of entry.day.program_exercises) {
    const todayKey = `${pe.exercise_id}|${todayStr}`
    const todaySets = buckets[todayKey] || []
    if (todaySets.length === 0) continue
    const todayStats = sessionExerciseStats(todaySets)

    let bestVolume = 0, bestReps = 0, bestWeight = 0, bestOneRM = 0, bestSets = 0
    let hasHistory = false
    for (const key in buckets) {
      if (key === todayKey || !key.startsWith(pe.exercise_id + '|')) continue
      hasHistory = true
      const stats = sessionExerciseStats(buckets[key])
      bestVolume = Math.max(bestVolume, stats.volume)
      bestReps = Math.max(bestReps, stats.totalReps)
      bestWeight = Math.max(bestWeight, stats.maxWeight)
      bestOneRM = Math.max(bestOneRM, stats.maxOneRM)
      bestSets = Math.max(bestSets, stats.setCount)
    }
    // Nothing to beat yet - a first-time exercise isn't a PR
    if (!hasHistory) continue

    const badges = []
    if (todayStats.volume > bestVolume) badges.push({ type: 'volume', label: 'Volume PR' })
    if (todayStats.maxWeight > bestWeight) badges.push({ type: 'weight', label: 'Weight PR' })
    if (todayStats.totalReps > bestReps) badges.push({ type: 'reps', label: 'Reps PR' })
    if (todayStats.setCount > bestSets) badges.push({ type: 'sets', label: 'Sets PR' })
    if (todayStats.maxOneRM > bestOneRM) badges.push({ type: 'onerm', label: 'Est. 1RM PR' })
    if (badges.length === 0) continue

    const container = document.getElementById(`prBadges-${pe.id}`)
    if (container) container.innerHTML = badges.map(b => `<span class="pr-badge pr-badge-${b.type}">🏆 ${b.label}</span>`).join('')
  }
}

// ==========================================================================
// ---- SET LOGGING ----
// Unchanged from the per-set logging built earlier - now dropped into the
// single active-exercise card above instead of an all-exercises list.
// ==========================================================================
function renderSetRow(pe, setNumber, logged, isTimed, tracksWeight, isExtra) {
  const checked = !!(logged && logged.completed_at)
  // Each set can have its own coach-set target now (a pyramid) - fall back
  // to the old shared prescribed_reps/prescribed_weight for sets beyond
  // what the coach targeted (an athlete-added extra set) or for
  // pre-pyramid data that has no set_targets at all
  const target = pe.set_targets && pe.set_targets[setNumber - 1]
  const repsVal = logged ? (logged.actual_reps || '') : ((target ? target.reps : pe.prescribed_reps) || '')
  // Each row starts out in the athlete's default unit (data-unit), but can
  // be flipped per-row with the unit toggle button below - actual_weight is
  // always stored in kg regardless of which unit was used to type it in
  const unit = athlete.weight_unit || 'kg'
  const weightKg = logged ? logged.actual_weight : (target ? target.weight : pe.prescribed_weight)
  const weightVal = weightKg != null ? formatWeight(weightKg, unit) : ''
  // Only flag warmup/failure sets - a plain "Main Set" on every row would
  // just be noise, since that's the default for most sets in a workout
  const setType = target && target.type && target.type !== 'main' ? target.type : null
  const typeLabel = setType === 'warmup' ? 'Warmup' : setType === 'failure' ? 'Failure' : ''
  const isUnilateral = pe.exercises && pe.exercises.is_unilateral
  const repsPlaceholder = (isTimed ? 'e.g. 45 sec' : 'reps') + (isUnilateral ? ' each side' : '')

  return `
    <div class="set-row ${checked ? 'completed' : ''}" data-set-number="${setNumber}" data-unit="${unit}">
      <span class="set-label">Set ${setNumber}${typeLabel ? `<span class="set-type-badge set-type-${setType}">${typeLabel}</span>` : ''}${isUnilateral ? '<span class="set-type-badge set-type-unilateral">Each Side</span>' : ''}</span>
      <input type="text" class="set-reps-input" value="${repsVal}" placeholder="${repsPlaceholder}" ${checked ? 'disabled' : ''}>
      ${tracksWeight ? `
        <input type="number" class="set-weight-input" value="${weightVal}" placeholder="${unit}" step="0.5" ${checked ? 'disabled' : ''}>
        <button type="button" class="set-unit-toggle" data-action="toggle-unit" title="Switch to ${unit === 'kg' ? 'lbs' : 'kg'}" ${checked ? 'disabled' : ''}>${unit}</button>
      ` : ''}
      <button type="button" class="set-check-btn ${checked ? 'checked' : ''}" data-action="check-set" title="${checked ? 'Undo' : 'Mark done'}">${checked ? '✓' : ''}</button>
      ${isExtra && !checked ? '<button type="button" class="set-remove-btn" data-action="remove-set" title="Remove set">✕</button>' : ''}
    </div>
  `
}

// Flips one row's kg/lbs display without changing the weight it represents
// - converts the number currently typed in so switching units relabels it
// instead of silently reinterpreting it (100kg staying "100" after a
// switch would quietly turn it into 100lbs, which is wrong)
function toggleRowUnit(rowEl) {
  const weightInput = rowEl.querySelector('.set-weight-input')
  const unitBtn = rowEl.querySelector('.set-unit-toggle')
  if (!weightInput || !unitBtn) return

  const currentUnit = rowEl.dataset.unit || 'kg'
  const nextUnit = currentUnit === 'kg' ? 'lbs' : 'kg'
  const typed = parseFloat(weightInput.value)
  if (!isNaN(typed)) {
    const kgVal = weightToKg(typed, currentUnit)
    weightInput.value = formatWeight(kgVal, nextUnit)
  }

  rowEl.dataset.unit = nextUnit
  weightInput.placeholder = nextUnit
  unitBtn.textContent = nextUnit
  unitBtn.title = `Switch to ${nextUnit === 'kg' ? 'lbs' : 'kg'}`
}

function wireExerciseCardEvents(containerId, dateStr) {
  document.getElementById(containerId).addEventListener('click', async function(e) {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const peId = document.getElementById(containerId).dataset.peId
    const row = btn.closest('.set-row')

    if (btn.dataset.action === 'add-set') {
      addSetRow(peId)
    } else if (btn.dataset.action === 'toggle-unit') {
      toggleRowUnit(row)
    } else if (btn.dataset.action === 'check-set') {
      const setNumber = parseInt(row.dataset.setNumber)
      if (row.classList.contains('completed')) {
        await uncheckSet(peId, setNumber, dateStr, row)
      } else {
        await checkSet(peId, setNumber, dateStr, row)
      }
    } else if (btn.dataset.action === 'remove-set') {
      row.remove()
    }
  })
}

function addSetRow(peId) {
  const pe = findPE(peId)
  if (!pe) return
  const rowsContainer = document.querySelector(`.set-rows[data-pe-id="${peId}"]`)
  const nextNumber = rowsContainer.children.length + 1
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  rowsContainer.insertAdjacentHTML('beforeend', renderSetRow(pe, nextNumber, null, isTimed, tracksWeight, true))
}

// Optimistic UI: the row flips to "checked" instantly, and logSetsByPE
// (the state every render reads from) is updated right away too - not just
// the DOM. Without that second part, swiping to another exercise before a
// slow save finished and then swiping back would re-render this row from
// stale data and show it as unchecked again, even though the tap "worked".
//
// A failed save never reverts what you tapped. It's also durable: every
// check/uncheck is written to a small localStorage queue *before* the
// network call even starts, so if the connection is bad enough that
// saveWithRetry (a few attempts with backoff and a per-attempt timeout)
// exhausts all its attempts - or the tab gets backgrounded/killed by the
// phone mid-retry, which a purely in-memory retry can't survive - the
// pending change is still sitting in the queue. It gets flushed again on
// the next page load and whenever the tab becomes visible again (see
// flushPendingQueue). Only once every attempt (live + later retries) has
// failed does the row get flagged "unsynced", and even then it stays as
// tapped rather than reverting.
// Upsert on (program_exercise_id, date, set_number) - re-checking an
// already-logged set updates it instead of creating a duplicate row.
async function checkSet(peId, setNumber, dateStr, rowEl) {
  const pe = findPE(peId)
  const repsInput = rowEl.querySelector('.set-reps-input')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const actualReps = repsInput.value.trim() || null
  // Convert whatever unit this row is currently showing back to kg - that's
  // the only thing that ever gets saved
  const rowUnit = rowEl.dataset.unit || 'kg'
  const actualWeight = weightInput ? (weightInput.value ? weightToKg(parseFloat(weightInput.value), rowUnit) : null) : null
  const removedBtn = rowEl.querySelector('.set-remove-btn')

  rowEl.classList.add('completed')
  rowEl.classList.remove('unsynced')
  repsInput.disabled = true
  if (weightInput) weightInput.disabled = true
  const checkBtn = rowEl.querySelector('.set-check-btn')
  checkBtn.textContent = '✓'
  checkBtn.classList.add('checked')
  checkBtn.title = 'Undo'
  if (removedBtn) removedBtn.remove()
  maybeStartRestTimer(pe, rowEl)

  const queueEntry = {
    program_exercise_id: peId,
    athlete_id: athlete.id,
    date: dateStr,
    set_number: setNumber,
    actual_reps: actualReps,
    actual_weight: actualWeight,
    completed_at: new Date().toISOString(),
    deleted: false
  }

  if (!logSetsByPE[peId]) logSetsByPE[peId] = []
  logSetsByPE[peId] = logSetsByPE[peId].filter(s => s.set_number !== setNumber)
  logSetsByPE[peId].push(queueEntry)

  queueUpsert(queueEntry)
  scheduleFlush()
}

// Same reasoning as checkSet - unchecks immediately, queues + schedules the
// delete, and only flags "unsynced" (staying visually unchecked) if every
// attempt fails, rather than silently snapping back to checked
function uncheckSet(peId, setNumber, dateStr, rowEl) {
  const pe = findPE(peId)
  const repsInput = rowEl.querySelector('.set-reps-input')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const checkBtn = rowEl.querySelector('.set-check-btn')
  const isExtra = setNumber > (pe.prescribed_sets || 0)

  rowEl.classList.remove('completed', 'unsynced')
  repsInput.disabled = false
  if (weightInput) weightInput.disabled = false
  checkBtn.textContent = ''
  checkBtn.classList.remove('checked')
  checkBtn.title = 'Mark done'
  if (isExtra && !rowEl.querySelector('.set-remove-btn')) {
    rowEl.insertAdjacentHTML('beforeend', '<button type="button" class="set-remove-btn" data-action="remove-set" title="Remove set">✕</button>')
  }
  logSetsByPE[peId] = (logSetsByPE[peId] || []).filter(s => s.set_number !== setNumber)

  const queueEntry = { program_exercise_id: peId, date: dateStr, set_number: setNumber, deleted: true }
  queueUpsert(queueEntry)
  scheduleFlush()
}

// ==========================================================================
// ---- PENDING SAVE QUEUE ----
// A tiny durable outbox in localStorage, keyed by (program_exercise_id,
// date, set_number) so only the latest action for a given set is ever
// queued. checkSet/uncheckSet write here before attempting to save, so the
// change survives even if the tab is killed mid-retry - flushPendingQueue
// picks up anything still sitting here on the next load or tab-foreground.
// ==========================================================================
function loadPendingQueue() {
  try {
    return JSON.parse(localStorage.getItem('tbflog-pending-sets') || '[]')
  } catch (e) {
    return []
  }
}

function savePendingQueueToStorage(queue) {
  try {
    localStorage.setItem('tbflog-pending-sets', JSON.stringify(queue))
  } catch (e) { /* storage full/unavailable - falls back to in-memory-only behavior for this session */ }
}

function queueKey(entry) {
  return `${entry.program_exercise_id}|${entry.date}|${entry.set_number}`
}

function queueUpsert(entry) {
  const queue = loadPendingQueue().filter(q => queueKey(q) !== queueKey(entry))
  queue.push(entry)
  savePendingQueueToStorage(queue)
}

function queueRemove(peId, dateStr, setNumber) {
  const target = queueKey({ program_exercise_id: peId, date: dateStr, set_number: setNumber })
  savePendingQueueToStorage(loadPendingQueue().filter(q => queueKey(q) !== target))
}

// Applies every still-pending queue entry onto logSetsByPE - called at the
// end of loadTrainingData() so a set that hasn't synced yet still shows as
// checked/unchecked after a fresh reload, instead of the server's
// (temporarily out of date) version winning
function applyPendingQueueLocally() {
  for (const entry of loadPendingQueue()) {
    if (entry.deleted) {
      logSetsByPE[entry.program_exercise_id] = (logSetsByPE[entry.program_exercise_id] || []).filter(s => s.set_number !== entry.set_number)
    } else {
      if (!logSetsByPE[entry.program_exercise_id]) logSetsByPE[entry.program_exercise_id] = []
      logSetsByPE[entry.program_exercise_id] = logSetsByPE[entry.program_exercise_id].filter(s => s.set_number !== entry.set_number)
      logSetsByPE[entry.program_exercise_id].push(entry)
    }
  }
}

// Checking/unchecking a set no longer saves it directly - it queues the
// change and calls scheduleFlush(), which debounces a run of taps into one
// batched request instead of one-per-tap. flushPendingQueue itself is also
// called directly (bypassing the debounce) from a few "catch up now"
// moments: page load, visibilitychange, the 20s interval below, the sync
// banner's Retry Now button, and finishWorkout. flushInFlight makes all of
// these safe to call at any time, even while another flush is already
// running - an overlapping call just queues one more run afterward instead
// of firing a second, competing request for the same rows. That overlap
// used to be exactly how two of these triggers could both fire an upsert
// for the same set at the same moment - the resulting Postgres row-lock
// contention is what caused the "canceling statement due to statement
// timeout" errors, not the RLS join chain (which resolves through primary-
// key lookups either way).
let flushTimer = null
let flushInFlight = false
let flushAgainNeeded = false
let firstQueuedAt = null

// Tapping a set schedules a flush ~1.5s later; each further tap within that
// window pushes it back out again, so a quick run of taps becomes one
// request - capped at 5s so a long flurry of taps still flushes promptly
// instead of being postponed indefinitely.
function scheduleFlush() {
  if (!firstQueuedAt) firstQueuedAt = Date.now()
  clearTimeout(flushTimer)
  const waitedTooLong = Date.now() - firstQueuedAt > 5000
  flushTimer = setTimeout(flushPendingQueue, waitedTooLong ? 0 : 1500)
}

// Sends every pending set as ONE batched upsert (instead of one request per
// set) so a whole workout's worth of taps costs a handful of round trips,
// not dozens - directly what was creating the lock contention above. Deletes
// (unchecked sets) can't be batched the same way (each is its own DELETE),
// but they're rare compared to checks, so they keep the older per-row path
// with LIMITED parallelism (3 at a time) - the same cap added after a real
// past incident where firing every entry at once (plain Promise.all) on a
// weak gym connection made a 14-set backlog blow past the per-attempt
// timeout and abort together ("AbortError: Fetch is aborted").
async function flushPendingQueue() {
  if (flushInFlight) { flushAgainNeeded = true; return }
  flushInFlight = true
  clearTimeout(flushTimer)
  firstQueuedAt = null
  try {
    const entries = loadPendingQueue()
    if (entries.length === 0) return

    const toSave = entries.filter(e => !e.deleted)
    const toDelete = entries.filter(e => e.deleted)

    if (toSave.length > 0) {
      const { data, error } = await saveWithRetry((signal) => supabase
        .from('exercise_log_sets')
        .upsert(toSave.map(function(e) {
          return {
            program_exercise_id: e.program_exercise_id,
            athlete_id: e.athlete_id,
            date: e.date,
            set_number: e.set_number,
            actual_reps: e.actual_reps,
            actual_weight: e.actual_weight,
            completed_at: e.completed_at
          }
        }), { onConflict: 'program_exercise_id,date,set_number' })
        .select()
        .abortSignal(signal)
      )
      if (!error) {
        for (const entry of toSave) {
          const saved = (data || []).find(d => d.program_exercise_id === entry.program_exercise_id && d.date === entry.date && d.set_number === entry.set_number)
          settleEntry(entry, true, null, saved)
        }
      } else {
        console.log(error)
        // One bad/orphaned row (e.g. its exercise got deleted mid-workout)
        // would otherwise block every other pending set from saving forever -
        // fall back to saving each individually, same as before batching
        await runWithConcurrencyLimit(toSave, 3, async function(entry) {
          const { data, error } = await performQueuedSave(entry)
          settleEntry(entry, !error, error, data && data[0])
        })
      }
    }

    await runWithConcurrencyLimit(toDelete, 3, async function(entry) {
      const { error } = await performQueuedSave(entry)
      settleEntry(entry, !error, error)
    })
  } finally {
    flushInFlight = false
    if (flushAgainNeeded) {
      flushAgainNeeded = false
      scheduleFlush()
    }
  }
}

// Reconciles one queue entry's outcome with the pending queue and, if the
// athlete hasn't already swiped away from it, the row on screen.
function settleEntry(entry, success, error, savedRow) {
  const rowEl = findSetRowEl(entry.program_exercise_id, entry.set_number)
  if (success) {
    queueRemove(entry.program_exercise_id, entry.date, entry.set_number)
    if (rowEl) rowEl.classList.remove('unsynced')
    if (!entry.deleted) {
      logSetsByPE[entry.program_exercise_id] = (logSetsByPE[entry.program_exercise_id] || []).filter(s => s.set_number !== entry.set_number)
      logSetsByPE[entry.program_exercise_id].push(savedRow || entry)
    }
  } else {
    entry.lastError = describeError(error)
    queueUpsert(entry)
    if (rowEl) {
      rowEl.classList.add('unsynced')
      const checkBtn = rowEl.querySelector('.set-check-btn')
      if (checkBtn) checkBtn.title = 'Not synced yet - will keep retrying automatically'
    }
  }
}

function findSetRowEl(peId, setNumber) {
  const container = document.querySelector(`.set-rows[data-pe-id="${peId}"]`)
  return container ? container.querySelector(`.set-row[data-set-number="${setNumber}"]`) : null
}

// Runs fn over items with at most `limit` in flight at once.
async function runWithConcurrencyLimit(items, limit, fn) {
  const queue = [...items]
  const workerCount = Math.min(limit, queue.length)
  const workers = new Array(workerCount).fill(null).map(async function() {
    while (queue.length > 0) {
      const item = queue.shift()
      await fn(item)
    }
  })
  await Promise.all(workers)
}

// ==========================================================================
// ---- PENDING SESSION-END QUEUE ----
// Same durable-retry idea as the set-logging queue above, but much smaller:
// just session_id -> ended_at. finishWorkout no longer waits on this save
// at all (the summary screen is built entirely from data already in
// memory), so a slow/killed connection never blocks the athlete - this
// queue is what makes that safe, by making sure the "ended" timestamp
// eventually reaches the server even if the first attempt fails.
// ==========================================================================
function loadPendingSessionEnds() {
  try {
    return JSON.parse(localStorage.getItem('tbflog-pending-session-ends') || '[]')
  } catch (e) {
    return []
  }
}

function savePendingSessionEndsToStorage(queue) {
  try {
    localStorage.setItem('tbflog-pending-session-ends', JSON.stringify(queue))
  } catch (e) { /* storage full/unavailable - falls back to in-memory-only behavior for this session */ }
}

function queueSessionEnd(sessionId, endedAt) {
  const queue = loadPendingSessionEnds().filter(e => e.session_id !== sessionId)
  queue.push({ session_id: sessionId, ended_at: endedAt })
  savePendingSessionEndsToStorage(queue)
}

// Tries to save immediately; only falls into the durable queue if that
// attempt (already 3 tries via saveWithRetry) fails entirely - not awaited
// by finishWorkout, since nothing on screen needs this to finish
async function saveSessionEnd(sessionId, endedAt) {
  const { error } = await saveWithRetry((signal) => supabase
    .from('workout_sessions')
    .update({ ended_at: endedAt })
    .eq('id', sessionId)
    .abortSignal(signal)
  )
  if (error) {
    console.log(error)
    queueSessionEnd(sessionId, endedAt)
  }
}

async function flushPendingSessionEnds() {
  const queue = loadPendingSessionEnds()
  await runWithConcurrencyLimit(queue, 3, async function(entry) {
    const { error } = await saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .update({ ended_at: entry.ended_at })
      .eq('id', entry.session_id)
      .abortSignal(signal)
    )
    if (!error) {
      savePendingSessionEndsToStorage(loadPendingSessionEnds().filter(e => e.session_id !== entry.session_id))
    }
  })
}

// Pulls a human-readable message out of whatever shape the failure came in
// as - a Supabase/PostgREST error object (.message), a thrown DOMException
// like AbortError (.message), or something unexpected (fall back to a raw
// dump so nothing is ever silently blank in the sync banner)
function describeError(error) {
  if (!error) return 'Unknown error'
  if (error.message) return error.message
  try { return JSON.stringify(error) } catch (e) { return String(error) }
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && athlete) {
    flushPendingQueue()
    flushPendingSessionEnds()
  }
})

// Belt-and-suspenders on top of the visibilitychange retry above: iOS kills
// a backgrounded tab's in-flight network requests the moment the screen
// locks or the app switches away (confirmed - a set saved instantly with
// the screen kept on and Chrome in the foreground, but consistently aborted
// otherwise). The one retry on returning to the tab can itself land in a
// bad moment (e.g. wifi still reconnecting right after unlock) and then just
// sits there until the athlete notices the banner and taps Retry Now. This
// keeps quietly trying every 20s in the background instead, only while the
// tab is actually visible (no point racing a request that's guaranteed to
// be killed anyway).
setInterval(function() {
  if (document.visibilityState !== 'visible' || !athlete) return
  if (loadPendingQueue().length > 0) flushPendingQueue()
  if (loadPendingSessionEnds().length > 0) flushPendingSessionEnds()
}, 20000)

function performQueuedSave(entry) {
  if (entry.deleted) {
    return saveWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .delete()
      .eq('program_exercise_id', entry.program_exercise_id)
      .eq('date', entry.date)
      .eq('set_number', entry.set_number)
      .abortSignal(signal)
    )
  }
  return saveWithRetry((signal) => supabase
    .from('exercise_log_sets')
    .upsert([{
      program_exercise_id: entry.program_exercise_id,
      athlete_id: entry.athlete_id,
      date: entry.date,
      set_number: entry.set_number,
      actual_reps: entry.actual_reps,
      actual_weight: entry.actual_weight,
      completed_at: entry.completed_at
    }], { onConflict: 'program_exercise_id,date,set_number' })
    .select()
    .abortSignal(signal)
  )
}

// Retries a Supabase call a few times with backoff before giving up.
// Each attempt is capped with an AbortController timeout - fetch() has no
// timeout by default, so a stalled (not failed, just stuck) connection
// would otherwise hang on a single attempt indefinitely instead of ever
// reaching a retry. Normalizes a thrown/aborted attempt into the same
// {data, error} shape as a normal Supabase response so this never throws -
// safe to await from anywhere, including in a loop from flushPendingQueue.
async function saveWithRetry(operationFactory, maxAttempts = 3) {
  let result = { data: null, error: null }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    try {
      result = await operationFactory(controller.signal)
    } catch (err) {
      result = { data: null, error: err }
    } finally {
      clearTimeout(timeoutId)
    }
    if (!result.error) return result
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, attempt * 2000))
    }
  }
  return result
}

// ==========================================================================
// ---- REST TIMER ----
// Only fires between sets, not after the last one - if the row just checked
// is the last row in its exercise's list, there's nothing to rest before.
// ==========================================================================
function maybeStartRestTimer(pe, rowEl) {
  // Each set can have its own rest now (shorter after a warmup set than
  // after a top set) - fall back to the exercise's old shared rest_seconds
  // for a set beyond what the coach targeted, or for pre-pyramid data
  const setNumber = parseInt(rowEl.dataset.setNumber)
  const target = pe.set_targets && pe.set_targets[setNumber - 1]
  const restSeconds = target && target.rest != null ? target.rest : pe.rest_seconds
  if (!restSeconds) return
  const rows = [...rowEl.parentElement.children]
  const isLastRow = rows[rows.length - 1] === rowEl
  if (isLastRow) return
  startRestTimer(restSeconds)
}

function startRestTimer(totalSeconds) {
  clearRestTimer()
  const bar = document.getElementById('restTimerBar')
  if (!bar) return

  let remaining = totalSeconds
  bar.style.display = 'flex'
  bar.innerHTML = `
    <span class="rest-timer-label">Rest</span>
    <span class="rest-timer-time" id="restTimerTime">${formatTimer(remaining)}</span>
    <button type="button" class="rest-timer-skip" id="restTimerSkipBtn">Skip</button>
  `
  document.getElementById('restTimerSkipBtn').addEventListener('click', clearRestTimer)

  restTimerInterval = setInterval(function() {
    remaining--
    if (remaining <= 0) {
      playRestDoneSound()
      clearRestTimer()
      return
    }
    const timeEl = document.getElementById('restTimerTime')
    if (timeEl) timeEl.textContent = formatTimer(remaining)
  }, 1000)
}

function clearRestTimer() {
  if (restTimerInterval) clearInterval(restTimerInterval)
  restTimerInterval = null
  const bar = document.getElementById('restTimerBar')
  if (bar) { bar.style.display = 'none'; bar.innerHTML = '' }
}

function formatTimer(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// A short beep via the Web Audio API (an oscillator, no external asset)
// plus a vibration where supported - either can silently no-op, the timer
// still visually hit zero either way
function playRestDoneSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.2, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
    osc.start()
    osc.stop(ctx.currentTime + 0.4)
  } catch (e) { /* audio isn't essential, ignore if unsupported/blocked */ }

  if (navigator.vibrate) navigator.vibrate(300)
}

