// ==========================================================================
// ATHLETE DASHBOARD
// Works out which of 4 states a logged-in athlete is in (same as before -
// see checkAccountState), then for a real linked athlete lands on a Week
// view: a welcome header + a 7-day strip for the current week (next week
// unlocks only if the coach turned on can_preview_next_week for this
// athlete). Tapping a day opens a read-only preview of that day's
// exercises; tapping "Start Workout" (today only) begins a guided,
// one-exercise-at-a-time flow that records a real start/end time
// (workout_sessions) and reuses the same per-set logging built earlier
// (renderSetRow/checkSet/uncheckSet/addSetRow/rest timer, unchanged).
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

let athlete = null
let entriesByDate = {} // 'YYYY-MM-DD' -> array of { program, week, day }
let logSetsByPE = {} // program_exercise_id -> array of exercise_log_sets rows, sorted by set_number
let openSessionsByDayId = {} // program_days.id -> in-progress workout_sessions row (ended_at is null)
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
    .select('id, name, can_preview_next_week')
    .eq('user_id', session.user.id)
    .maybeSingle()

  if (foundAthlete) {
    athlete = foundAthlete
    await loadTrainingData()
    renderWeekView(startOfWeek(new Date()))
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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function trainingDisplayName(entry) {
  if (entry.program.is_adhoc) return entry.program.name || 'Training'
  return entry.day.label || ('Day ' + entry.day.day_number)
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
    .is('ended_at', null)

  if (sessionsError) { console.log('Error loading open sessions:', sessionsError); return }

  openSessionsByDayId = {}
  for (const s of sessions) openSessionsByDayId[s.program_day_id] = s
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
  if (pe.prescribed_weight) parts.push(`${pe.prescribed_weight}kg`)
  if (pe.extra_fields) {
    for (const [k, v] of Object.entries(pe.extra_fields)) parts.push(`${k}: ${v}`)
  }
  return parts.join(' × ')
}

// ==========================================================================
// ---- VIDEO MODAL ----
// YouTube thumbnails/embeds are available at predictable URLs from just the
// video id, no API key needed. Other hosts fall back to opening a new tab.
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

function openVideoModal(url) {
  if (!url) return
  const embedUrl = getYouTubeEmbedUrl(url)
  if (!embedUrl) { window.open(url, '_blank'); return }
  document.getElementById('videoModalIframe').src = embedUrl
  document.getElementById('videoModal').classList.add('active')
}

function closeVideoModal() {
  document.getElementById('videoModal').classList.remove('active')
  document.getElementById('videoModalIframe').src = 'about:blank'
}

document.getElementById('closeVideoModalBtn').addEventListener('click', closeVideoModal)

// ==========================================================================
// ---- WEEK VIEW (default landing) ----
// ==========================================================================
function renderWeekView(weekStart) {
  clearRestTimer()
  currentWeekStart = weekStart
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const realCurrentWeekStart = startOfWeek(new Date())
  const isCurrentWeek = toDateStr(weekStart) === toDateStr(realCurrentWeekStart)
  const nextEnabled = isCurrentWeek && !!athlete.can_preview_next_week

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
    <button class="header-link" id="viewFullCalendarBtn">📅 Full Calendar</button>
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
  document.getElementById('viewFullCalendarBtn').addEventListener('click', function() {
    renderCalendarView(weekStart.getFullYear(), weekStart.getMonth())
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
    if (thumbBtn) openVideoModal(thumbBtn.dataset.videoUrl)
  })

  entries.forEach(entry => {
    const startBtn = document.getElementById('startWorkoutBtn-' + entry.day.id)
    if (startBtn) startBtn.addEventListener('click', function() { startWorkout(entry, dateStr) })
  })
}

function renderDayPreviewGroup(entry, isToday) {
  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  const fullyLogged = exercises.length > 0 && exercises.every(pe => {
    const prescribed = pe.prescribed_sets || 1
    const logged = (logSetsByPE[pe.id] || []).filter(s => s.completed_at && s.set_number <= prescribed)
    return logged.length >= prescribed
  })
  const openSession = openSessionsByDayId[entry.day.id]

  return `
    <div class="detail-group">
      <h4 class="detail-group-title">${trainingDisplayName(entry)}</h4>
      ${exercises.map(pe => renderDayPreviewExercise(pe, isToday && fullyLogged)).join('')}
      ${isToday && exercises.length > 0 && !fullyLogged
        ? `<button type="button" class="start-workout-btn" id="startWorkoutBtn-${entry.day.id}">${openSession ? '▶ Continue Workout' : '▶ Start Workout'}</button>`
        : ''}
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
      : `${s.actual_reps || '-'} reps${s.actual_weight != null ? ' @ ' + s.actual_weight + 'kg' : ''}`
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

function renderActiveExercise(entry, dateStr, exercises, index, session) {
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
    <div id="activeExerciseCard" data-pe-id="${pe.id}">
      <button type="button" class="active-exercise-thumb" id="activeExerciseThumbBtn" ${videoUrl ? '' : 'disabled'}>
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="active-exercise-thumb-placeholder">🏋</span>'}
      </button>
      <div class="active-exercise-title">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
      ${target ? `<p class="exercise-log-target">Target: ${target}</p>` : ''}
      ${pe.notes ? `<p class="exercise-log-notes">${pe.notes}</p>` : ''}
      <div class="set-rows" data-pe-id="${pe.id}">${rowsHtml}</div>
      <button type="button" class="add-set-btn" data-action="add-set">+ Add Set</button>
    </div>
    <div class="workout-nav-row">
      <button class="btn-cancel" id="prevExerciseBtn" ${index === 0 ? 'disabled' : ''}>← Previous</button>
      <button class="btn-save" id="nextExerciseBtn">${isLast ? 'Finish Workout' : 'Next →'}</button>
    </div>
    <a href="#" class="header-link end-workout-link" id="endWorkoutLink">End Workout</a>
    <div id="restTimerBar" class="rest-timer-bar"></div>
  `

  document.getElementById('activeExerciseThumbBtn').addEventListener('click', function() {
    openVideoModal(videoUrl)
  })

  wireExerciseCardEvents('activeExerciseCard', dateStr)

  document.getElementById('prevExerciseBtn').addEventListener('click', function() {
    if (index > 0) renderActiveExercise(entry, dateStr, exercises, index - 1, session)
  })
  document.getElementById('nextExerciseBtn').addEventListener('click', function() {
    if (isLast) finishWorkout(entry, session)
    else renderActiveExercise(entry, dateStr, exercises, index + 1, session)
  })
  document.getElementById('endWorkoutLink').addEventListener('click', function(e) {
    e.preventDefault()
    finishWorkout(entry, session)
  })
}

async function finishWorkout(entry, session) {
  if (!confirm('Finish this workout?')) return

  const { data, error } = await supabase
    .from('workout_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', session.id)
    .select()
    .single()

  if (error) { console.log(error); alert('Something went wrong ending the workout'); return }

  await loadTrainingData()
  renderWorkoutSummary(data, entry)
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

  pageContent.innerHTML = `
    <div class="workout-summary">
      <h2>Workout Complete 💪</h2>
      <div class="workout-summary-stats">
        <div>
          <div class="workout-summary-stat-value">${durationText}</div>
          <div class="workout-summary-stat-label">Duration</div>
        </div>
        <div>
          <div class="workout-summary-stat-value">${Math.round(totalVolume)}kg</div>
          <div class="workout-summary-stat-label">Total Volume</div>
        </div>
      </div>
      <button class="btn-save" id="summaryDoneBtn">Done</button>
    </div>
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
  const weightVal = logged ? (logged.actual_weight != null ? logged.actual_weight : '') : (pe.prescribed_weight != null ? pe.prescribed_weight : '')

  return `
    <div class="set-row ${checked ? 'completed' : ''}" data-set-number="${setNumber}">
      <span class="set-label">Set ${setNumber}</span>
      <input type="text" class="set-reps-input" value="${repsVal}" placeholder="${isTimed ? 'e.g. 45 sec' : 'reps'}" ${checked ? 'disabled' : ''}>
      ${isTimed ? '' : `<input type="number" class="set-weight-input" value="${weightVal}" placeholder="kg" step="0.5" ${checked ? 'disabled' : ''}>`}
      <button type="button" class="set-check-btn ${checked ? 'checked' : ''}" data-action="check-set" title="${checked ? 'Undo' : 'Mark done'}">${checked ? '✓' : ''}</button>
      ${isExtra && !checked ? '<button type="button" class="set-remove-btn" data-action="remove-set" title="Remove set">✕</button>' : ''}
    </div>
  `
}

function wireExerciseCardEvents(containerId, dateStr) {
  document.getElementById(containerId).addEventListener('click', async function(e) {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const peId = document.getElementById(containerId).dataset.peId
    const row = btn.closest('.set-row')

    if (btn.dataset.action === 'add-set') {
      addSetRow(peId)
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

// Upsert on (program_exercise_id, date, set_number) - re-checking an
// already-logged set updates it instead of creating a duplicate row
async function checkSet(peId, setNumber, dateStr, rowEl) {
  const pe = findPE(peId)
  const repsInput = rowEl.querySelector('.set-reps-input')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const actualReps = repsInput.value.trim() || null
  const actualWeight = weightInput ? (weightInput.value ? parseFloat(weightInput.value) : null) : null

  const { data, error } = await supabase
    .from('exercise_log_sets')
    .upsert([{
      program_exercise_id: peId,
      athlete_id: athlete.id,
      date: dateStr,
      set_number: setNumber,
      actual_reps: actualReps,
      actual_weight: actualWeight,
      completed_at: new Date().toISOString()
    }], { onConflict: 'program_exercise_id,date,set_number' })
    .select()

  if (error) { console.log(error); alert('Something went wrong saving that set'); return }

  if (!logSetsByPE[peId]) logSetsByPE[peId] = []
  logSetsByPE[peId] = logSetsByPE[peId].filter(s => s.set_number !== setNumber)
  logSetsByPE[peId].push(data[0])

  rowEl.classList.add('completed')
  repsInput.disabled = true
  if (weightInput) weightInput.disabled = true
  const checkBtn = rowEl.querySelector('.set-check-btn')
  checkBtn.textContent = '✓'
  checkBtn.classList.add('checked')
  checkBtn.title = 'Undo'
  const removeBtn = rowEl.querySelector('.set-remove-btn')
  if (removeBtn) removeBtn.remove()

  maybeStartRestTimer(pe, rowEl)
}

async function uncheckSet(peId, setNumber, dateStr, rowEl) {
  const { error } = await supabase
    .from('exercise_log_sets')
    .delete()
    .eq('program_exercise_id', peId)
    .eq('date', dateStr)
    .eq('set_number', setNumber)

  if (error) { console.log(error); alert('Something went wrong'); return }

  logSetsByPE[peId] = (logSetsByPE[peId] || []).filter(s => s.set_number !== setNumber)

  rowEl.classList.remove('completed')
  rowEl.querySelector('.set-reps-input').disabled = false
  const weightInput = rowEl.querySelector('.set-weight-input')
  if (weightInput) weightInput.disabled = false
  const checkBtn = rowEl.querySelector('.set-check-btn')
  checkBtn.textContent = ''
  checkBtn.classList.remove('checked')
  checkBtn.title = 'Mark done'

  const pe = findPE(peId)
  if (setNumber > (pe.prescribed_sets || 0) && !rowEl.querySelector('.set-remove-btn')) {
    rowEl.insertAdjacentHTML('beforeend', '<button type="button" class="set-remove-btn" data-action="remove-set" title="Remove set">✕</button>')
  }
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

// ==========================================================================
// ---- CALENDAR VIEW (browse further than one week, read-only) ----
// Reached via the Week view's "Full Calendar" link. Only the coach
// schedules trainings, so unlike athlete-calendar.js this grid has no "+"
// add control - just navigation into renderDayPreview().
// ==========================================================================
// The Week view's "Next" nav already stops an athlete from stepping past
// their allowed week, but the month Calendar can jump straight to any
// future month - it needs the same cap applied per-cell, or the
// can_preview_next_week toggle would be pointless.
function maxAllowedDateStr() {
  const weekEnd = addDays(startOfWeek(new Date()), 6)
  const maxDate = athlete.can_preview_next_week ? addDays(weekEnd, 7) : weekEnd
  return toDateStr(maxDate)
}

function renderCalendarView(year, month) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const startWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const prevMonthDays = new Date(year, month, 0).getDate()

  const cells = []
  for (let i = startWeekday - 1; i >= 0; i--) {
    cells.push({ date: new Date(year, month - 1, prevMonthDays - i), outside: true })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), outside: false })
  }
  let nextMonthDay = 1
  while (cells.length < 42) {
    cells.push({ date: new Date(year, month + 1, nextMonthDay), outside: true })
    nextMonthDay++
  }

  const todayStr = toDateStr(new Date())
  const maxAllowed = maxAllowedDateStr()
  const nextMonthFirstDay = new Date(year, month + 1, 1)
  const nextDisabled = toDateStr(nextMonthFirstDay) > maxAllowed

  pageContent.innerHTML = `
    <div class="calendar-toolbar">
      <button class="header-link" id="calBackToWeekBtn">← Week</button>
      <div style="flex:1"></div>
      <button class="btn-cancel" id="calPrevBtn">← Prev</button>
      <h3 id="calMonthLabel">${MONTH_NAMES[month]} ${year}</h3>
      <button class="btn-cancel" id="calNextBtn" ${nextDisabled ? 'disabled' : ''}>Next →</button>
    </div>
    <div class="calendar-grid" id="athCalendarGrid"></div>
  `

  const grid = document.getElementById('athCalendarGrid')
  grid.innerHTML = cells.map(cell => {
    const dateStr = toDateStr(cell.date)
    const locked = dateStr > maxAllowed
    const entries = locked ? [] : (entriesByDate[dateStr] || [])
    const names = [...new Set(entries.map(trainingDisplayName))]
    const done = dayIsFullyLogged(entries)

    const classes = ['calendar-day']
    if (cell.outside) classes.push('calendar-day-outside')
    if (dateStr === todayStr) classes.push('calendar-day-today')
    if (locked) classes.push('calendar-day-locked')

    return `
      <div class="${classes.join(' ')}" data-date="${dateStr}">
        <span class="calendar-day-number">${cell.date.getDate()}</span>
        ${names.map(name => `<span class="calendar-day-badge ${done ? 'calendar-day-badge-done' : ''}">${done ? '✓ ' : ''}${name}</span>`).join('')}
      </div>
    `
  }).join('')

  grid.querySelectorAll('.calendar-day').forEach(cellEl => {
    cellEl.addEventListener('click', function() { renderDayPreview(cellEl.dataset.date) })
  })

  document.getElementById('calBackToWeekBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })
  document.getElementById('calPrevBtn').addEventListener('click', function() {
    let m = month - 1, y = year
    if (m < 0) { m = 11; y-- }
    renderCalendarView(y, m)
  })
  document.getElementById('calNextBtn').addEventListener('click', function() {
    if (nextDisabled) return
    let m = month + 1, y = year
    if (m > 11) { m = 0; y++ }
    renderCalendarView(y, m)
  })
}
