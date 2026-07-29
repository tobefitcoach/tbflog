// ==========================================================================
// ATHLETE DASHBOARD
// Works out which of 4 states a logged-in athlete is in (same as before -
// see checkAccountState), then for a real linked athlete renders a Today
// view: what's scheduled today, with per-set logging (weight can differ set
// to set, reps are editable per set, extra sets can be added beyond what
// was prescribed). Checking a set starts a rest timer if the coach
// prescribed one. A Calendar view (read-only month grid) lets the athlete
// browse other days.
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
let restTimerInterval = null

const today = new Date()
let currentViewYear = today.getFullYear()
let currentViewMonth = today.getMonth() // 0-indexed

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
    .select('id, name')
    .eq('user_id', session.user.id)
    .maybeSingle()

  if (foundAthlete) {
    athlete = foundAthlete
    await loadTrainingData()
    renderDayView(toDateStr(new Date()))
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

function resolveDate(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStr(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStr(result)
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function trainingDisplayName(entry) {
  if (entry.program.is_adhoc) return entry.program.name || 'Training'
  return entry.day.label || ('Day ' + entry.day.day_number)
}

// ==========================================================================
// ---- LOAD TRAINING DATA ----
// One nested query for the whole schedule, one flat query for every set
// this athlete has logged so far - small datasets for a solo coach's
// athlete, so no date-range filtering needed.
// ==========================================================================
async function loadTrainingData() {
  const { data, error } = await supabase
    .from('programs')
    .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises(name, category, type))))')
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

// ==========================================================================
// ---- DAY VIEW (Today, or any date clicked from the Calendar view) ----
// ==========================================================================
function renderDayView(dateStr) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const isToday = dateStr === toDateStr(new Date())
  const entries = entriesByDate[dateStr] || []

  const bodyHtml = entries.length === 0
    ? '<p class="no-metrics">Rest day — nothing scheduled</p>'
    : entries.map(entry => `
        <div class="detail-group">
          <h4 class="detail-group-title">${trainingDisplayName(entry)}</h4>
          ${entry.day.program_exercises.length === 0
            ? '<p class="no-metrics">No exercises</p>'
            : entry.day.program_exercises.map(pe => renderExerciseLogCard(pe, dateStr)).join('')}
        </div>
      `).join('')

  pageContent.innerHTML = `
    <div class="day-view-header">
      <h2>${isToday ? 'Today' : formatDisplayDate(dateStr)}</h2>
      <div style="display:flex; gap:16px">
        ${isToday ? '' : '<button class="header-link" id="backToTodayBtn">Today</button>'}
        <button class="header-link" id="viewCalendarBtn">📅 Calendar</button>
      </div>
    </div>
    ${isToday ? `<p class="day-view-date">${formatDisplayDate(dateStr)}</p>` : ''}
    <div id="dayExercises">${bodyHtml}</div>
    <div id="restTimerBar" class="rest-timer-bar"></div>
  `

  document.getElementById('viewCalendarBtn').addEventListener('click', function() {
    renderCalendarView(currentViewYear, currentViewMonth)
  })
  const backBtn = document.getElementById('backToTodayBtn')
  if (backBtn) backBtn.addEventListener('click', function() { renderDayView(toDateStr(new Date())) })

  wireDayViewEvents(dateStr)
}

function renderExerciseLogCard(pe, dateStr) {
  const isTimed = pe.exercises && pe.exercises.type === 'timed'
  const targetParts = []
  if (pe.prescribed_sets) targetParts.push(`${pe.prescribed_sets} sets`)
  if (pe.prescribed_reps) targetParts.push(isTimed ? pe.prescribed_reps : `${pe.prescribed_reps} reps`)
  if (pe.prescribed_weight) targetParts.push(`${pe.prescribed_weight}kg`)
  if (pe.extra_fields) {
    for (const [k, v] of Object.entries(pe.extra_fields)) targetParts.push(`${k}: ${v}`)
  }
  const target = targetParts.join(' × ')

  const loggedSets = logSetsByPE[pe.id] || []
  const rowCount = Math.max(pe.prescribed_sets || 1, loggedSets.length)

  let rowsHtml = ''
  for (let setNumber = 1; setNumber <= rowCount; setNumber++) {
    const logged = loggedSets.find(s => s.set_number === setNumber)
    const isExtra = setNumber > (pe.prescribed_sets || 0)
    rowsHtml += renderSetRow(pe, setNumber, logged, isTimed, isExtra)
  }

  return `
    <div class="exercise-log-card" data-pe-id="${pe.id}">
      <div class="exercise-log-title-row">
        <span class="exercise-log-title">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</span>
        ${target ? `<span class="exercise-log-target">Target: ${target}</span>` : ''}
      </div>
      ${pe.notes ? `<p class="exercise-log-notes">${pe.notes}</p>` : ''}
      <div class="set-rows" data-pe-id="${pe.id}">${rowsHtml}</div>
      <button type="button" class="add-set-btn" data-action="add-set">+ Add Set</button>
    </div>
  `
}

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

// ==========================================================================
// ---- SET LOGGING ----
// One delegated listener per day-view render, same pattern used everywhere
// else in the app for dynamically-rendered lists.
// ==========================================================================
function wireDayViewEvents(dateStr) {
  document.getElementById('dayExercises').addEventListener('click', async function(e) {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const card = btn.closest('.exercise-log-card')
    const peId = card.dataset.peId
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
// ---- CALENDAR VIEW (browse other days, read-only) ----
// Only the coach schedules trainings, so unlike athlete-calendar.js this
// grid has no "+" add control - just navigation into renderDayView().
// ==========================================================================
function renderCalendarView(year, month) {
  clearRestTimer()
  currentViewYear = year
  currentViewMonth = month
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

  pageContent.innerHTML = `
    <div class="calendar-toolbar">
      <button class="header-link" id="calBackToTodayBtn">Today</button>
      <div style="flex:1"></div>
      <button class="btn-cancel" id="calPrevBtn">← Prev</button>
      <h3 id="calMonthLabel">${MONTH_NAMES[month]} ${year}</h3>
      <button class="btn-cancel" id="calNextBtn">Next →</button>
    </div>
    <div class="calendar-grid" id="athCalendarGrid"></div>
  `

  const grid = document.getElementById('athCalendarGrid')
  grid.innerHTML = cells.map(cell => {
    const dateStr = toDateStr(cell.date)
    const entries = entriesByDate[dateStr] || []
    const names = [...new Set(entries.map(trainingDisplayName))]
    const done = dayIsFullyLogged(entries)

    const classes = ['calendar-day']
    if (cell.outside) classes.push('calendar-day-outside')
    if (dateStr === todayStr) classes.push('calendar-day-today')

    return `
      <div class="${classes.join(' ')}" data-date="${dateStr}">
        <span class="calendar-day-number">${cell.date.getDate()}</span>
        ${names.map(name => `<span class="calendar-day-badge ${done ? 'calendar-day-badge-done' : ''}">${done ? '✓ ' : ''}${name}</span>`).join('')}
      </div>
    `
  }).join('')

  grid.querySelectorAll('.calendar-day').forEach(cellEl => {
    cellEl.addEventListener('click', function() { renderDayView(cellEl.dataset.date) })
  })

  document.getElementById('calBackToTodayBtn').addEventListener('click', function() { renderDayView(toDateStr(new Date())) })
  document.getElementById('calPrevBtn').addEventListener('click', function() {
    let m = month - 1, y = year
    if (m < 0) { m = 11; y-- }
    renderCalendarView(y, m)
  })
  document.getElementById('calNextBtn').addEventListener('click', function() {
    let m = month + 1, y = year
    if (m > 11) { m = 0; y++ }
    renderCalendarView(y, m)
  })
}

// "Fully logged" = every prescribed set across every exercise scheduled
// that day has a completed_at - drives the calendar's ✓ badge
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
