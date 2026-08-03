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

let athlete = null
let entriesByDate = {} // 'YYYY-MM-DD' -> array of { program, week, day }
let logSetsByPE = {} // program_exercise_id -> array of exercise_log_sets rows, sorted by set_number
let openSessionsByDayId = {} // program_days.id -> in-progress workout_sessions row (ended_at is null)
let completedSessionsByDayId = {} // program_days.id -> most recently-ended workout_sessions row
let restTimerInterval = null
let currentWeekStart = null // Date (Monday) of the currently-shown week, for "back to week"

checkAccountState()

async function checkAccountState() {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, name')
    .eq('id', session.user.id)
    .single()

  if (profileError || !profile || profile.role !== 'athlete') {
    renderWrongRole()
    return
  }

  const { data: foundAthlete } = await supabase
    .from('athletes')
    .select('id, name, can_preview_next_week, weight_unit')
    .eq('user_id', session.user.id)
    .maybeSingle()

  if (foundAthlete) {
    athlete = foundAthlete
    await loadTrainingData()
    renderWeekView(startOfWeek(new Date()))
    flushPendingQueue() // not awaited - picks up anything left over from a previous session
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
// Just weight units for now.
function renderSettings() {
  pageContent.innerHTML = `
    <div class="day-view-header">
      <h2>Settings</h2>
      <button class="header-link" id="backFromSettingsBtn">← Back</button>
    </div>
    <div class="form-group">
      <label>Weight units</label>
      <select id="weightUnitSelect">
        <option value="kg" ${athlete.weight_unit !== 'lbs' ? 'selected' : ''}>Kilograms (kg)</option>
        <option value="lbs" ${athlete.weight_unit === 'lbs' ? 'selected' : ''}>Pounds (lbs)</option>
      </select>
    </div>
    <p style="color:#aaaacc; font-size:14px">Changes how weights are shown and typed in when logging a workout. Everything's still saved the same either way, so switching anytime is safe - and you can always flip a single set to the other unit with the button next to its weight box.</p>
  `

  document.getElementById('backFromSettingsBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

  document.getElementById('weightUnitSelect').addEventListener('change', async function(e) {
    const newUnit = e.target.value
    const previousUnit = athlete.weight_unit
    athlete.weight_unit = newUnit // optimistic, same pattern used everywhere else in this file

    const { error } = await supabase
      .from('athletes')
      .update({ weight_unit: newUnit })
      .eq('id', athlete.id)

    if (error) {
      console.log(error)
      athlete.weight_unit = previousUnit
      e.target.value = previousUnit
      alert('Something went wrong saving that - try again')
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
  const { data, error } = await supabase
    .from('programs')
    .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises(name, category, type, video_url))))')
    .eq('athlete_id', athlete.id)
    .eq('is_template', false)

  if (error) { console.log('Error loading training data:', error); return }

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

  const { data: logSets, error: logError } = await supabase
    .from('exercise_log_sets')
    .select('*')
    .eq('athlete_id', athlete.id)

  if (logError) { console.log('Error loading logged sets:', logError); return }

  logSetsByPE = {}
  for (const row of logSets) {
    if (!logSetsByPE[row.program_exercise_id]) logSetsByPE[row.program_exercise_id] = []
    logSetsByPE[row.program_exercise_id].push(row)
  }
  for (const peId in logSetsByPE) {
    logSetsByPE[peId].sort((a, b) => a.set_number - b.set_number)
  }

  const { data: sessions, error: sessionsError } = await supabase
    .from('workout_sessions')
    .select('*')
    .eq('athlete_id', athlete.id)

  if (sessionsError) { console.log('Error loading sessions:', sessionsError); return }

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

function targetLine(pe) {
  const isTimed = pe.exercises && pe.exercises.type === 'timed'
  const parts = []
  if (pe.prescribed_sets) parts.push(`${pe.prescribed_sets} sets`)
  if (pe.prescribed_reps) parts.push(isTimed ? pe.prescribed_reps : `${pe.prescribed_reps} reps`)
  if (pe.prescribed_weight) parts.push(`${formatWeight(pe.prescribed_weight, athlete.weight_unit)}${athlete.weight_unit || 'kg'}`)
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

  pageContent.innerHTML = `
    <div class="welcome-header">
      <h2>Welcome back, ${athlete.name}</h2>
      <p>Here's your training for the week</p>
    </div>
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
      <button class="header-link" id="backToWeekBtn">← Week</button>
    </div>
    ${isToday ? `<p class="day-view-date">${formatDisplayDate(dateStr)}</p>` : ''}
    <div id="dayPreviewBody">${bodyHtml}</div>
  `

  document.getElementById('backToWeekBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

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
  const isTimed = pe.exercises && pe.exercises.type === 'timed'
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const target = targetLine(pe)

  let loggedText = ''
  if (showLogged) {
    const sets = (logSetsByPE[pe.id] || []).filter(s => s.completed_at).sort((a, b) => a.set_number - b.set_number)
    loggedText = sets.map(s => isTimed
      ? (s.actual_reps || '-')
      : `${s.actual_reps || '-'} reps${s.actual_weight != null ? ' @ ' + formatWeight(s.actual_weight, athlete.weight_unit) + (athlete.weight_unit || 'kg') : ''}`
    ).join(', ')
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
  const { data: existing, error: findError } = await supabase
    .from('workout_sessions')
    .select('*')
    .eq('program_day_id', programDayId)
    .eq('athlete_id', athlete.id)
    .is('ended_at', null)
    .maybeSingle()

  if (findError) { console.log(findError) }
  if (existing) return existing

  const { data: newSession, error: insertError } = await supabase
    .from('workout_sessions')
    .insert([{ program_day_id: programDayId, athlete_id: athlete.id }])
    .select()
    .single()

  if (insertError) { console.log(insertError); alert('Something went wrong starting the workout'); throw insertError }
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

async function startWorkout(entry, dateStr) {
  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  if (exercises.length === 0) { alert('No exercises in this training'); return }

  const session = await findOrCreateSession(entry.day.id)
  openSessionsByDayId[entry.day.id] = session
  const resumeIndex = findResumeIndex(exercises)
  renderActiveExercise(entry, dateStr, exercises, resumeIndex, session)
}

// direction: 1 when arriving from a Next/swipe-left (new slide enters from
// the right), -1 from Previous/swipe-right (enters from the left), omitted
// for the very first exercise shown (no animation, nothing to slide from)
function renderActiveExercise(entry, dateStr, exercises, index, session, direction) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const pe = exercises[index]
  const isTimed = pe.exercises && pe.exercises.type === 'timed'
  const isLast = index === exercises.length - 1
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const target = targetLine(pe)

  const loggedSets = logSetsByPE[pe.id] || []
  const rowCount = Math.max(pe.prescribed_sets || 1, loggedSets.length)
  let rowsHtml = ''
  for (let setNumber = 1; setNumber <= rowCount; setNumber++) {
    const logged = loggedSets.find(s => s.set_number === setNumber)
    const isExtra = setNumber > (pe.prescribed_sets || 0)
    rowsHtml += renderSetRow(pe, setNumber, logged, isTimed, isExtra)
  }

  pageContent.innerHTML = `
    <p class="active-exercise-progress">Exercise ${index + 1} of ${exercises.length}</p>
    <div id="activeExerciseCard" class="workout-slide" data-pe-id="${pe.id}">
      <button type="button" class="active-exercise-thumb" id="activeExerciseThumbBtn" ${videoUrl ? '' : 'disabled'}>
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="active-exercise-thumb-placeholder">🏋</span>'}
      </button>
      <div class="active-exercise-title">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
      ${target ? `<p class="exercise-log-target">Target: ${target}</p>` : ''}
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
      if (isLast) renderEndOfWorkoutSlide(entry, dateStr, exercises, session, 1)
      else renderActiveExercise(entry, dateStr, exercises, index + 1, session, 1)
    },
    function onSwipeRight() {
      if (index > 0) renderActiveExercise(entry, dateStr, exercises, index - 1, session, -1)
    }
  )

  mountSlide(direction)
}

// Reached by pressing Next (or swiping left) on the last exercise - the
// only place "End Workout" lives now, instead of a persistent link on
// every slide
function renderEndOfWorkoutSlide(entry, dateStr, exercises, session, direction) {
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
    finishWorkout(entry, session)
  })

  attachSwipeHandlers(
    null, // already the last slide, nothing to swipe forward to
    function onSwipeRight() {
      renderActiveExercise(entry, dateStr, exercises, exercises.length - 1, session, -1)
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

// Shows a "Saving..." state on the button so ending a workout is never
// silent, then (1) gives the pending-save queue a bounded window to flush
// - flushPendingQueue is durable and keeps retrying in the background on
// its own regardless (localStorage queue + visibilitychange + next page
// load), so this only needs to give it a head start, not block on it
// finishing completely - and (2) sends the session-end update itself
// through saveWithRetry, since a plain unprotected Supabase call has no
// timeout and could previously hang forever on a bad connection with zero
// visible feedback (exactly what looked like "pressing End Workout does
// nothing").
async function finishWorkout(entry, session) {
  if (!confirm('Finish this workout?')) return

  const btn = document.getElementById('endWorkoutBtn')
  if (btn) {
    btn.disabled = true
    btn.textContent = 'Saving...'
  }

  // Whichever finishes first - either the queue actually flushes, or 8
  // seconds pass and we move on anyway (flushPendingQueue itself just
  // keeps running in the background if it's still mid-retry)
  await Promise.race([
    flushPendingQueue(),
    new Promise(resolve => setTimeout(resolve, 8000))
  ])

  const { error } = await saveWithRetry((signal) => supabase
    .from('workout_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', session.id)
    .select()
    .abortSignal(signal)
  )

  if (error) {
    console.log(error)
    alert('Something went wrong ending the workout - try again')
    if (btn) {
      btn.disabled = false
      btn.textContent = 'End Workout'
    }
    return
  }

  await loadTrainingData()
  // Straight back to the week view, not the summary - the summary's still
  // reachable afterward via "View Summary" on this day's preview
  renderWeekView(currentWeekStart || startOfWeek(new Date()))
}

function renderWorkoutSummary(finishedSession, entry) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const durationMs = new Date(finishedSession.ended_at) - new Date(finishedSession.started_at)
  const durationMin = Math.floor(durationMs / 60000)
  const durationSec = Math.floor((durationMs % 60000) / 1000)
  const durationText = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSec}s`

  // Volume = actual_weight x actual_reps, summed across every completed set
  // logged for this day's exercises - skips sets whose reps didn't parse as
  // a plain number (duration text, rep ranges left un-edited, etc.)
  let totalVolume = 0
  for (const pe of entry.day.program_exercises) {
    const sets = logSetsByPE[pe.id] || []
    for (const s of sets) {
      if (!s.completed_at || s.actual_weight == null) continue
      const reps = parseInt(s.actual_reps)
      if (!isNaN(reps)) totalVolume += reps * s.actual_weight
    }
  }

  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  const breakdownHtml = exercises.map(pe => {
    const isTimed = pe.exercises && pe.exercises.type === 'timed'
    const sets = (logSetsByPE[pe.id] || []).filter(s => s.completed_at).sort((a, b) => a.set_number - b.set_number)
    if (sets.length === 0) return ''

    return `
      <div class="detail-group">
        <h4 class="detail-group-title">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</h4>
        <ul class="detail-list">
          ${sets.map(s => `
            <li class="detail-row">
              <span>Set ${s.set_number}</span>
              <span class="detail-row-value">${isTimed
                ? (s.actual_reps || '-')
                : `${s.actual_reps || '-'} reps${s.actual_weight != null ? ' @ ' + formatWeight(s.actual_weight, athlete.weight_unit) + (athlete.weight_unit || 'kg') : ''}`}</span>
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
        </div>
        <div>
          <div class="workout-summary-stat-value">${Math.round(formatWeight(totalVolume, athlete.weight_unit))}${athlete.weight_unit || 'kg'}</div>
          <div class="workout-summary-stat-label">Total Volume</div>
        </div>
      </div>
    </div>
    ${breakdownHtml || '<p class="no-metrics">Nothing logged</p>'}
    <button class="btn-save start-workout-btn" id="summaryDoneBtn">Done</button>
  `

  document.getElementById('summaryDoneBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })
}

// ==========================================================================
// ---- SET LOGGING ----
// Unchanged from the per-set logging built earlier - now dropped into the
// single active-exercise card above instead of an all-exercises list.
// ==========================================================================
function renderSetRow(pe, setNumber, logged, isTimed, isExtra) {
  const checked = !!(logged && logged.completed_at)
  const repsVal = logged ? (logged.actual_reps || '') : (pe.prescribed_reps || '')
  // Each row starts out in the athlete's default unit (data-unit), but can
  // be flipped per-row with the unit toggle button below - actual_weight is
  // always stored in kg regardless of which unit was used to type it in
  const unit = athlete.weight_unit || 'kg'
  const weightKg = logged ? logged.actual_weight : pe.prescribed_weight
  const weightVal = weightKg != null ? formatWeight(weightKg, unit) : ''

  return `
    <div class="set-row ${checked ? 'completed' : ''}" data-set-number="${setNumber}" data-unit="${unit}">
      <span class="set-label">Set ${setNumber}</span>
      <input type="text" class="set-reps-input" value="${repsVal}" placeholder="${isTimed ? 'e.g. 45 sec' : 'reps'}" ${checked ? 'disabled' : ''}>
      ${isTimed ? '' : `
        <input type="number" class="set-weight-input" value="${weightVal}" placeholder="${unit}" step="0.5" ${checked ? 'disabled' : ''}>
        <button type="button" class="set-unit-toggle" data-action="toggle-unit" title="Switch to ${unit === 'kg' ? 'lbs' : 'kg'}" ${checked ? 'disabled' : ''}>${unit}</button>
      `}
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
  const isTimed = pe.exercises && pe.exercises.type === 'timed'
  rowsContainer.insertAdjacentHTML('beforeend', renderSetRow(pe, nextNumber, null, isTimed, true))
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
  const { data, error } = await performQueuedSave(queueEntry)

  if (error) {
    console.log(error)
    rowEl.classList.add('unsynced')
    checkBtn.title = 'Not synced yet - will keep retrying automatically'
    return
  }

  queueRemove(peId, dateStr, setNumber)
  // Replace the optimistic placeholder with the real saved row
  logSetsByPE[peId] = logSetsByPE[peId].filter(s => s.set_number !== setNumber)
  logSetsByPE[peId].push(data[0])
}

// Same reasoning as checkSet - unchecks immediately, queues + retries the
// delete, and only flags "unsynced" (staying visually unchecked) if every
// attempt fails, rather than silently snapping back to checked
async function uncheckSet(peId, setNumber, dateStr, rowEl) {
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
  const { error } = await performQueuedSave(queueEntry)

  if (error) {
    console.log(error)
    rowEl.classList.add('unsynced')
    checkBtn.title = 'Not synced yet - will keep retrying automatically'
    return
  }

  queueRemove(peId, dateStr, setNumber)
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

// Not awaited by most of its callers on purpose - nothing in this app
// should make an athlete wait on a network retry. Runs on load and
// whenever the tab becomes visible again (see the visibilitychange
// listener below), and is raced against a timeout in finishWorkout.
//
// Every entry is saved in PARALLEL (Promise.all), not one at a time. With
// several entries stuck retrying on a bad connection, saving them one at a
// time meant the wait was entries x up to ~24s each (3 attempts x 6s
// timeout, plus backoff) - that's exactly what turned "saving the workout"
// into a multi-minute wait once more than a couple of sets had backed up
// in the queue. Running them together bounds the wait to about one
// entry's worth of retries, no matter how many are queued.
async function flushPendingQueue() {
  const entries = loadPendingQueue()
  await Promise.all(entries.map(async function(entry) {
    const { error } = await performQueuedSave(entry)
    if (!error) queueRemove(entry.program_exercise_id, entry.date, entry.set_number)
  }))
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && athlete) flushPendingQueue()
})

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
    const timeoutId = setTimeout(() => controller.abort(), 6000)
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
  if (!pe.rest_seconds) return
  const rows = [...rowEl.parentElement.children]
  const isLastRow = rows[rows.length - 1] === rowEl
  if (isLastRow) return
  startRestTimer(pe.rest_seconds)
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

