// ==========================================================================
// CALENDAR TAB
// Separate module from athlete.js (which is already ~2000 lines and works
// on a completely different data domain - measurements, not programs).
// Lazy-inits on first click into the Calendar tab (see the
// 'calendar-tab-activated' event dispatched from athlete.js's initTabs()) -
// nothing here draws into a hidden panel.
//
// A month grid is built from this athlete's non-template `programs` rows
// (assigned-from-template instances, and ad-hoc single-day additions).
// Each program's weeks/days carry only relative position (week_number,
// day_number) - resolveDate() converts that + the program's start_date into
// a real calendar date. See program-builder.js for why day_number is
// relative, not a literal weekday.
// ==========================================================================
import { supabase } from './coachClient.js'

const params = new URLSearchParams(window.location.search)
const athleteId = params.get('id')

const { data: { session } } = await supabase.auth.getSession()
// No redirect here - athlete.js's session guard already handles that for
// the whole page. If there's no session, nothing below ever gets a chance
// to run before that redirect happens.

let calendarEntriesByDate = {} // 'YYYY-MM-DD' -> array of { program, week, day }
let sessionStatusByDayId = {} // program_days.id -> 'in-progress' | 'done', absent = not started yet
let calendarLoaded = false
let currentDayDateForModal = null // date currently shown in the day-detail modal

const today = new Date()
let currentViewYear = today.getFullYear()
let currentViewMonth = today.getMonth() // 0-indexed

window.addEventListener('calendar-tab-activated', function() {
  if (calendarLoaded) return
  calendarLoaded = true
  loadCalendarMonth(currentViewYear, currentViewMonth)
})

document.getElementById('calPrevBtn').addEventListener('click', function() {
  currentViewMonth--
  if (currentViewMonth < 0) { currentViewMonth = 11; currentViewYear-- }
  loadCalendarMonth(currentViewYear, currentViewMonth)
})

document.getElementById('calNextBtn').addEventListener('click', function() {
  currentViewMonth++
  if (currentViewMonth > 11) { currentViewMonth = 0; currentViewYear++ }
  loadCalendarMonth(currentViewYear, currentViewMonth)
})

// ==========================================================================
// ---- DATE HELPERS ----
// Same timezone-safe parsing convention as formatDisplayDate() in
// athlete.js (new Date(dateStr + 'T00:00:00')) - building YYYY-MM-DD
// strings by hand rather than via .toISOString(), which re-introduces an
// off-by-one bug for local dates.
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

function formatDisplayDateCal(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
}

function resolveDate(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStr(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStr(result)
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// Ad-hoc trainings show the name the coach gave them; days from an assigned
// template show the day's own label (falling back to "Day N"), since that's
// more useful at a glance than the template's overall name
function trainingDisplayName(entry) {
  if (entry.program.is_adhoc) return entry.program.name || 'Workout'
  return entry.day.label || ('Day ' + entry.day.day_number)
}

// ==========================================================================
// ---- LOAD + RENDER MONTH GRID ----
// ==========================================================================
async function loadCalendarMonth(year, month) {
  document.getElementById('calMonthLabel').textContent = `${MONTH_NAMES[month]} ${year}`

  // Programs and sessions don't depend on each other, so they fire together
  const [
    { data, error },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    fetchWithRetry((signal) => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises(name, category, type, video_url, tracks_weight, is_timed, is_unilateral))))')
      .eq('athlete_id', athleteId)
      .eq('is_template', false)
      .abortSignal(signal)
    ),
    fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('program_day_id, started_at, ended_at')
      .eq('athlete_id', athleteId)
      .abortSignal(signal)
    )
  ])

  if (error) { console.log('Error loading calendar:', error); customAlert('Something went wrong loading the calendar - check your connection and try again'); return }
  if (sessionsError) { console.log('Error loading sessions for calendar:', sessionsError) }

  calendarEntriesByDate = {}
  for (const program of data) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        const dateStr = resolveDate(program.start_date, week.week_number, day.day_number)
        if (!calendarEntriesByDate[dateStr]) calendarEntriesByDate[dateStr] = []
        calendarEntriesByDate[dateStr].push({ program, week, day })
      }
    }
  }

  // A day can in theory have more than one session (e.g. the athlete started
  // it, it got abandoned, and they started again later) - in-progress always
  // wins if any session is still open, otherwise the most recently ended one
  // decides "done"
  sessionStatusByDayId = {}
  for (const s of sessions || []) {
    if (!s.ended_at) {
      sessionStatusByDayId[s.program_day_id] = 'in-progress'
    } else if (sessionStatusByDayId[s.program_day_id] !== 'in-progress') {
      sessionStatusByDayId[s.program_day_id] = 'done'
    }
  }

  renderCalendarGrid(year, month)
}

function renderCalendarGrid(year, month) {
  const grid = document.getElementById('calendarGrid')
  // getDay() is 0=Sun..6=Sat - remapped so the grid's rows start on Monday
  // instead (0=Mon..6=Sun), matching the athlete's own week view
  const startWeekday = (new Date(year, month, 1).getDay() + 6) % 7
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

  grid.innerHTML = cells.map(cell => {
    const dateStr = toDateStr(cell.date)
    const entries = calendarEntriesByDate[dateStr] || []
    // One badge per training (keyed by day.id, always unique - two different
    // trainings that happen to share a display name used to incorrectly
    // collapse into one badge here). Color shows where it's at: blue for
    // planned (no session yet), orange while the athlete's in the middle of
    // it, green once they've finished it.
    const badges = [...new Map(entries.map(entry => [entry.day.id, entry])).values()]

    const classes = ['calendar-day']
    if (cell.outside) classes.push('calendar-day-outside')
    if (dateStr === todayStr) classes.push('calendar-day-today')

    return `
      <div class="${classes.join(' ')}" data-date="${dateStr}">
        <button type="button" class="calendar-day-add-btn" data-date="${dateStr}">+</button>
        <span class="calendar-day-number">${cell.date.getDate()}</span>
        ${badges.map(entry => {
          const status = sessionStatusByDayId[entry.day.id] // undefined | 'in-progress' | 'done'
          const statusClass = status === 'in-progress' ? 'calendar-day-badge-in-progress' : status === 'done' ? 'calendar-day-badge-done' : 'calendar-day-badge-planned'
          return `<span class="calendar-day-badge ${statusClass}">${trainingDisplayName(entry)}</span>`
        }).join('')}
      </div>
    `
  }).join('')

  grid.querySelectorAll('.calendar-day').forEach(cellEl => {
    cellEl.addEventListener('click', function() {
      openDayModal(cellEl.dataset.date)
    })
  })

  // Separate listener + stopPropagation so clicking "+" doesn't also
  // trigger the cell's own click (which opens the day-detail view instead)
  grid.querySelectorAll('.calendar-day-add-btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      openDayAddTrainingModal(btn.dataset.date)
    })
  })
}

// ==========================================================================
// ---- DAY DETAIL MODAL ----
// Reads straight from the in-memory calendarEntriesByDate map - no query.
// ==========================================================================
function openDayModal(dateStr) {
  currentDayDateForModal = dateStr
  document.getElementById('dayDetailTitle').textContent = formatDisplayDateCal(dateStr)

  const entries = calendarEntriesByDate[dateStr] || []
  const content = document.getElementById('dayDetailContent')

  if (entries.length === 0) {
    content.innerHTML = '<p class="no-metrics">Nothing scheduled on this day</p>'
  } else {
    content.innerHTML = entries.map(entry => {
      const label = entry.program.is_adhoc
        ? entry.program.name
        : `${entry.program.name} — Week ${entry.week.week_number}, ${entry.day.label || ('Day ' + entry.day.day_number)}`
      const exercises = entry.day.program_exercises
      // Ad-hoc: delete the whole programs row (it only ever covers this one
      // day). Assigned template: delete just this program_days row, so the
      // rest of the multi-week program stays intact.
      const deleteAction = entry.program.is_adhoc
        ? `data-action="delete-training" data-mode="adhoc" data-program-id="${entry.program.id}"`
        : `data-action="delete-training" data-mode="day" data-program-day-id="${entry.day.id}"`

      return `
        <div class="detail-group">
          <div style="display:flex; justify-content:space-between; align-items:center">
            <h4 class="detail-group-title">${label}</h4>
            <button class="btn-delete-metric" ${deleteAction}>🗑 Delete Workout</button>
          </div>
          ${exercises.length === 0
            ? '<p class="no-metrics">No exercises</p>'
            : `${exercises.map(renderScheduledExerciseCard).join('')}
               <button type="button" class="btn-save" data-action="save-scheduled-day" style="margin-top:8px">💾 Save</button>`}
        </div>
      `
    }).join('')
  }

  document.getElementById('dayDetailModal').classList.add('active')

  // innerHTML wipes any dynamically-built children, so extra field rows
  // (built with document.createElement, not template strings) get
  // re-populated here for every card
  for (const entry of entries) {
    for (const pe of entry.day.program_exercises) {
      if (pe.extra_fields) {
        for (const [k, v] of Object.entries(pe.extra_fields)) addExtraFieldRowCal(`extraFieldsSched-${pe.id}`, k, v)
      }
    }
  }
}

// Same card look/behaviour as training-builder.js / program-builder.js -
// video thumbnail, one row per set with its own reps/weight target, rest
// time, notes - editing an already-scheduled exercise directly from the
// calendar, same underlying program_exercises table program-builder.js
// edits, just reached a different way (day already has this exercise on it
// vs. picking one to add).
function renderScheduledExerciseCard(pe) {
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const isUnilateral = pe.exercises && pe.exercises.is_unilateral
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnailCal(videoUrl)
  const targets = deriveSetTargetsCal(pe)
  const rowsHtml = targets.map((t, i) => renderSetTargetRowCal(i + 1, t, isTimed, tracksWeight, isUnilateral, targets.length === 1)).join('')

  return `
    <div class="builder-exercise-card" data-id="${pe.id}">
      <div class="builder-exercise-card-header">
        <span class="builder-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder">🏋</span>'}
        </button>
        <div class="builder-exercise-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${isUnilateral ? '<span class="builder-unilateral-badge">Each Side</span>' : ''}
        <button type="button" class="btn-delete-measurement" data-action="delete-scheduled" title="Remove exercise">🗑</button>
      </div>
      <div class="set-target-rows">
        ${rowsHtml}
      </div>
      <button type="button" class="builder-add-set-btn" data-action="add-set">+ Add Set</button>
      <div class="builder-exercise-notes">
        <label>Extra Fields (optional)</label>
        <div class="extra-fields-container" id="extraFieldsSched-${pe.id}"></div>
        <button type="button" class="btn-create-metric" data-action="add-extra-field" style="margin-top:6px">+ Add Field</button>
      </div>
      <div class="builder-exercise-notes">
        <label>Notes (visible to the athlete)</label>
        <input type="text" class="exercise-notes-input" value="${pe.notes || ''}" placeholder="e.g. Focus on controlled tempo">
      </div>
    </div>
  `
}

function findScheduledPE(peId) {
  for (const dateStr in calendarEntriesByDate) {
    for (const entry of calendarEntriesByDate[dateStr]) {
      const pe = entry.day.program_exercises.find(p => p.id === peId)
      if (pe) return pe
    }
  }
  return null
}

document.getElementById('dayDetailContent').addEventListener('click', async function(e) {
  const thumbBtn = e.target.closest('.builder-exercise-thumb')
  if (thumbBtn && thumbBtn.dataset.videoUrl) {
    playInlineVideoCal(thumbBtn, thumbBtn.dataset.videoUrl)
    return
  }

  const btn = e.target.closest('[data-action]')
  if (!btn) return

  if (btn.dataset.action === 'delete-training') {
    deleteTraining(btn.dataset.mode, btn.dataset.programId, btn.dataset.programDayId)
    return
  }

  if (btn.dataset.action === 'save-scheduled-day') {
    await saveScheduledDay(btn.closest('.detail-group'))
    return
  }

  const card = btn.closest('.builder-exercise-card')
  const peId = card ? card.dataset.id : null

  if (btn.dataset.action === 'delete-scheduled') {
    await deleteScheduledExercise(peId)
  } else if (btn.dataset.action === 'add-set') {
    const pe = findScheduledPE(peId)
    addSetTargetRowCal(
      card.querySelector('.set-target-rows'),
      !!(pe && pe.exercises && pe.exercises.is_timed),
      !!(pe && (!pe.exercises || pe.exercises.tracks_weight)),
      !!(pe && pe.exercises && pe.exercises.is_unilateral)
    )
  } else if (btn.dataset.action === 'remove-set') {
    removeSetTargetRowCal(btn.closest('.set-target-row'))
  } else if (btn.dataset.action === 'add-extra-field') {
    addExtraFieldRowCal(`extraFieldsSched-${peId}`)
  }
})

// ---- Reorder exercises within a day-entry group by dragging the ⠿ handle ----
// Purely a DOM reorder while dragging (no network call), scoped to stay
// within the same group - the new order is only written to order_index
// when that group's own Save button is pressed, same as every other edit
// here. Dragging between different day-entry groups isn't supported.
let draggingCardCal = null
let draggingGroupCal = null

document.getElementById('dayDetailContent').addEventListener('dragstart', function(e) {
  const handle = e.target.closest('.builder-drag-handle')
  if (!handle) return
  draggingCardCal = handle.closest('.builder-exercise-card')
  draggingGroupCal = draggingCardCal.closest('.detail-group')
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', '')
  e.dataTransfer.setDragImage(draggingCardCal, 20, 20)
  setTimeout(function() { draggingCardCal.classList.add('dragging') }, 0)
})

document.getElementById('dayDetailContent').addEventListener('dragover', function(e) {
  if (!draggingCardCal) return
  if (e.target.closest('.detail-group') !== draggingGroupCal) return
  e.preventDefault()

  const cards = [...draggingGroupCal.querySelectorAll('.builder-exercise-card:not(.dragging)')]
  const after = cards.reduce(function(closest, card) {
    const box = card.getBoundingClientRect()
    const offset = e.clientY - box.top - box.height / 2
    return (offset < 0 && offset > closest.offset) ? { offset, element: card } : closest
  }, { offset: -Infinity, element: null }).element

  if (after) {
    draggingGroupCal.insertBefore(draggingCardCal, after)
  } else {
    const saveBtn = draggingGroupCal.querySelector('[data-action="save-scheduled-day"]')
    if (saveBtn) draggingGroupCal.insertBefore(draggingCardCal, saveBtn)
    else draggingGroupCal.appendChild(draggingCardCal)
  }
})

document.getElementById('dayDetailContent').addEventListener('dragend', function() {
  if (draggingCardCal) draggingCardCal.classList.remove('dragging')
  draggingCardCal = null
  draggingGroupCal = null
})

// Ad-hoc trainings only ever cover the one day they were created for, so
// deleting the whole `programs` row is exactly "delete this training"
// (cascades its week/day/exercises). An assigned template instance can span
// many weeks, so only that one program_days row is removed - the rest of
// the assigned program stays on the calendar untouched.
async function deleteTraining(mode, programId, programDayId) {
  if (!(await customConfirm(mode === 'adhoc'
    ? 'Delete this workout?'
    : 'Remove this day from the assigned program? (The rest of the program stays intact.)'))) return

  const { error } = mode === 'adhoc'
    ? await supabase.from('programs').delete().eq('id', programId)
    : await supabase.from('program_days').delete().eq('id', programDayId)

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  document.getElementById('dayDetailModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

document.getElementById('closeDayDetailBtn').addEventListener('click', function() {
  document.getElementById('dayDetailModal').classList.remove('active')
})

// ==========================================================================
// ---- EDIT / DELETE A SCHEDULED EXERCISE ----
// Always-editable card (see renderScheduledExerciseCard above), same
// pattern as training-builder.js/program-builder.js - no modal, and one
// Save button for the whole day's exercises (see saveScheduledDay below)
// instead of one per exercise, since a coach edits a whole day in one
// sitting and only wants to press Save once when it's done.
// ==========================================================================
async function saveScheduledExercise(peId, orderIndex) {
  const card = document.querySelector(`.builder-exercise-card[data-id="${peId}"]`)
  if (!card) return true

  const rows = [...card.querySelectorAll('.set-target-row')]
  const setTargets = rows.map(row => {
    const reps = row.querySelector('.set-reps-input').value.trim() || null
    const weightInput = row.querySelector('.set-weight-input')
    const weight = weightInput && weightInput.value ? parseFloat(weightInput.value) : null
    const restInput = row.querySelector('.set-rest-input')
    const rest = restInput.value ? parseInt(restInput.value) : null
    const type = row.querySelector('.set-type-select').value
    return { reps, weight, rest, type }
  })

  const notes = card.querySelector('.exercise-notes-input').value.trim() || null
  const extraFields = collectExtraFieldsCal(`extraFieldsSched-${peId}`)
  const first = setTargets[0] || { reps: null, weight: null, rest: null }

  const { error } = await supabase
    .from('program_exercises')
    .update({
      set_targets: setTargets,
      prescribed_sets: setTargets.length,
      prescribed_reps: first.reps,
      prescribed_weight: first.weight,
      rest_seconds: first.rest,
      extra_fields: extraFields,
      notes,
      order_index: orderIndex
    })
    .eq('id', peId)

  if (error) { console.log(error); return false }
  return true
}

// Saves every exercise card in one day-entry group at once, then closes
// the day-detail modal back to the calendar (that's "done" for a coach
// editing a scheduled day).
async function saveScheduledDay(groupEl) {
  const btn = groupEl.querySelector('[data-action="save-scheduled-day"]')
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...' }

  const cardIds = [...groupEl.querySelectorAll('.builder-exercise-card')].map(card => card.dataset.id)
  const results = await Promise.all(cardIds.map(saveScheduledExercise))

  if (results.some(ok => !ok)) {
    customAlert('Something went wrong saving one or more exercises - please try again')
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save' }
    return
  }

  document.getElementById('dayDetailModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

// Removes just this one card instead of reloading the whole month + rebuilding
// the modal, so unsaved edits sitting in this day's other cards aren't wiped out
async function deleteScheduledExercise(peId) {
  if (!(await customConfirm('Remove this exercise?'))) return

  const { error } = await supabase.from('program_exercises').delete().eq('id', peId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  const entries = calendarEntriesByDate[currentDayDateForModal] || []
  for (const entry of entries) {
    const idx = entry.day.program_exercises.findIndex(pe => pe.id === peId)
    if (idx === -1) continue

    entry.day.program_exercises.splice(idx, 1)
    const card = document.querySelector(`.builder-exercise-card[data-id="${peId}"]`)
    const group = card ? card.closest('.detail-group') : null
    if (card) card.remove()
    if (group && group.querySelectorAll('.builder-exercise-card').length === 0) {
      const saveBtn = group.querySelector('[data-action="save-scheduled-day"]')
      if (saveBtn) saveBtn.remove()
      group.insertAdjacentHTML('beforeend', '<p class="no-metrics">No exercises</p>')
    }
    break
  }
}

// ==========================================================================
// ---- ADD TRAINING (hover "+" on a calendar day) ----
// findOrCreateAdHocDay reuses the same (is_adhoc=true, start_date=dateStr)
// container for repeated adds to the same date, instead of creating a new
// one each time. Only way to put exercises on a day is via a saved
// Training - no more "add one loose exercise" flow, that's what the
// Training Library / training-builder.html is for. Two tabs share this one
// popup: a single saved Training onto just this day, or a whole Program
// starting on this day (see switchDayAddTab below).
// ==========================================================================
let currentDayDateForAddTraining = null // remembered so "+ New Training" can come back to the same day's popup afterward

// Both lists rarely change, but were previously re-fetched from Supabase on
// every single "+" click - the main reason that popup felt slow. Cached
// after the first fetch and reused for the rest of the page's lifetime;
// cachedTrainings is cleared when a new Training is actually created so it
// shows up immediately, cachedTemplates doesn't need that (templates are
// only ever edited on a different page).
let cachedTrainings = null
let cachedTemplates = null

async function getTrainingsList() {
  if (cachedTrainings) return cachedTrainings
  const { data, error } = await fetchWithRetry((signal) => supabase.from('trainings').select('*').order('created_at', { ascending: false }).abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your workouts - check your connection and try again'); return null }
  cachedTrainings = data
  return cachedTrainings
}

async function getProgramTemplates() {
  if (cachedTemplates) return cachedTemplates
  const { data, error } = await fetchWithRetry((signal) => supabase.from('programs').select('*').eq('is_template', true).order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your programs - check your connection and try again'); return null }
  cachedTemplates = data
  return cachedTemplates
}

// Selecting a row in the list previews it here rather than applying it
// straight away - selectedTraining* remembers what's currently previewed so
// the "Select" button (disabled until something's picked) knows what to
// apply. cachedTrainingExercises avoids re-fetching a preview already seen
// once in this session (e.g. clicking back and forth between two rows).
let selectedTrainingId = null
let selectedTrainingName = null
let cachedTrainingExercises = {} // training_id -> exercises array

async function openDayAddTrainingModal(dateStr) {
  currentDayDateForAddTraining = dateStr
  document.getElementById('dayAddTrainingTitle').textContent = 'Add Workout — ' + formatDisplayDateCal(dateStr)
  switchDayAddTab('workout')
  resetTrainingPreview()

  const data = await getTrainingsList()
  const list = document.getElementById('dayAddTrainingList')

  if (data === null) {
    list.innerHTML = '<p class="no-metrics">Something went wrong loading the Workout Library</p>'
  } else if (data.length === 0) {
    list.innerHTML = '<p class="no-metrics">No workouts saved yet - create one in the Workout Library first</p>'
  } else {
    list.innerHTML = data.map(t => `
      <div class="training-pick-row" data-id="${t.id}" data-name="${t.name}">
        <span>${t.name}</span>
      </div>
    `).join('')

    list.querySelectorAll('.training-pick-row').forEach(row => {
      row.addEventListener('click', function() {
        list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        previewTraining(row.dataset.id, row.dataset.name)
      })
    })
  }

  await loadDayAddProgramList()

  document.getElementById('dayAddTrainingModal').classList.add('active')
}

function resetTrainingPreview() {
  selectedTrainingId = null
  selectedTrainingName = null
  document.getElementById('dayAddTrainingPreview').innerHTML = '<p class="no-metrics">Select a workout to preview it</p>'
  document.getElementById('selectTrainingForDayBtn').disabled = true
}

async function previewTraining(trainingId, trainingName) {
  selectedTrainingId = trainingId
  selectedTrainingName = trainingName
  document.getElementById('selectTrainingForDayBtn').disabled = false

  const preview = document.getElementById('dayAddTrainingPreview')
  preview.innerHTML = '<p class="no-metrics">Loading…</p>'

  let exercises = cachedTrainingExercises[trainingId]
  if (!exercises) {
    const { data, error } = await supabase
      .from('training_exercises')
      .select('*, exercises(name, type, video_url, tracks_weight, is_timed, is_unilateral)')
      .eq('training_id', trainingId)
      .order('order_index')
    if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this preview</p>'; return }
    exercises = data
    cachedTrainingExercises[trainingId] = exercises
  }

  // A different row may have been clicked while this was still loading -
  // don't overwrite that newer preview with this now-stale one
  if (selectedTrainingId !== trainingId) return

  preview.innerHTML = `
    <div class="workout-preview-header">
      <h3>${trainingName}</h3>
      <span class="workout-preview-count">${exercises.length} Exercise${exercises.length === 1 ? '' : 's'}</span>
    </div>
    ${exercises.length === 0
      ? '<p class="no-metrics">No exercises in this workout</p>'
      : exercises.map(renderWorkoutPreviewExercise).join('')}
  `
}

function renderWorkoutPreviewExercise(te) {
  const thumb = getYouTubeThumbnailCal((te.exercises && te.exercises.video_url) || '')
  const target = targetLineForTraining(te)

  return `
    <div class="workout-preview-exercise">
      <div class="workout-preview-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '🏋'}</div>
      <div class="workout-preview-info">
        <div class="workout-preview-name">${te.exercises ? te.exercises.name : 'Unknown exercise'}</div>
        ${target ? `<div class="workout-preview-target">${target}</div>` : ''}
      </div>
    </div>
  `
}

// "12/10/8 reps @ 50kg" when only reps vary across sets, "12@40kg, 10@45kg,
// 8@50kg" for a real pyramid. Returns null when this exercise has no
// per-set targets yet, so callers fall back to the old single-value summary
function formatSetTargetsCal(setTargets, isTimed, tracksWeight) {
  if (!setTargets || setTargets.length === 0) return null
  if (isTimed && !tracksWeight) return setTargets.map(s => s.reps || '-').join(' / ')
  if (isTimed && tracksWeight) return setTargets.map(s => `${s.reps || '-'}${s.weight != null ? ' @ ' + s.weight + 'kg' : ''}`).join(', ')
  const sameWeight = setTargets.every(s => s.weight === setTargets[0].weight)
  if (sameWeight) {
    const reps = setTargets.map(s => s.reps || '-').join('/')
    return `${reps} reps${setTargets[0].weight != null ? ' @ ' + setTargets[0].weight + 'kg' : ''}`
  }
  return setTargets.map(s => `${s.reps || '-'}${s.weight != null ? '@' + s.weight + 'kg' : ''}`).join(', ')
}

function targetLineForTraining(te) {
  const isTimed = te.exercises && te.exercises.is_timed
  const tracksWeight = !te.exercises || te.exercises.tracks_weight
  const setTargetsText = formatSetTargetsCal(te.set_targets, isTimed, tracksWeight)
  const parts = []
  if (setTargetsText) {
    parts.push(setTargetsText)
  } else {
    if (te.prescribed_sets) parts.push(`${te.prescribed_sets} sets`)
    if (te.prescribed_reps) parts.push(isTimed ? te.prescribed_reps : `${te.prescribed_reps} reps`)
    if (te.prescribed_weight && tracksWeight) parts.push(`${te.prescribed_weight}kg`)
  }
  if (te.extra_fields) {
    for (const [k, v] of Object.entries(te.extra_fields)) parts.push(`${k}: ${v}`)
  }
  return parts.join(' × ')
}

function getYouTubeThumbnailCal(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg` : null
}

document.getElementById('selectTrainingForDayBtn').addEventListener('click', async function() {
  if (!selectedTrainingId) return
  const btn = this
  btn.disabled = true
  btn.textContent = 'Adding...'
  await applyTrainingToDay(selectedTrainingId, selectedTrainingName, currentDayDateForAddTraining)
  btn.textContent = 'Select'
})

function switchDayAddTab(tab) {
  document.getElementById('dayAddTabWorkout').classList.toggle('active', tab === 'workout')
  document.getElementById('dayAddTabProgram').classList.toggle('active', tab === 'program')
  document.getElementById('dayAddWorkoutPanel').classList.toggle('active', tab === 'workout')
  document.getElementById('dayAddProgramPanel').classList.toggle('active', tab === 'program')
}

document.getElementById('dayAddTabWorkout').addEventListener('click', function() { switchDayAddTab('workout') })
document.getElementById('dayAddTabProgram').addEventListener('click', function() { switchDayAddTab('program') })

// ==========================================================================
// ---- PROGRAM TAB: list + preview + day-range picker ----
// Same list-then-preview pattern as the Single Workout tab, but the
// preview is a flat "Day N - label (x exercises)" list instead of full
// exercise detail (a program can be 100+ days long). No start-date field -
// the calendar day that was clicked to open this popup always becomes
// whatever day the range picker below calls "day 1". selectedProgramDays
// stores the parsed day list so the range picker knows the program's
// total length without a second fetch.
// ==========================================================================
let selectedTemplateId = null
let selectedTemplateName = null
let totalProgramDays = 1
let programStartDay = 1
let programEndDay = 1
let cachedTemplateDays = {} // template_id -> { days, totalWeeks }

async function loadDayAddProgramList() {
  const data = await getProgramTemplates()
  const list = document.getElementById('dayAddProgramList')
  resetProgramPreview()

  if (data === null) {
    list.innerHTML = '<p class="no-metrics">Something went wrong loading your programs</p>'
  } else if (data.length === 0) {
    list.innerHTML = '<p class="no-metrics">No program templates saved yet - create one in the Program Library first</p>'
  } else {
    list.innerHTML = data.map(t => `
      <div class="training-pick-row" data-id="${t.id}" data-name="${t.name}">
        <span>${t.name}</span>
      </div>
    `).join('')

    list.querySelectorAll('.training-pick-row').forEach(row => {
      row.addEventListener('click', function() {
        list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        previewTemplate(row.dataset.id, row.dataset.name)
      })
    })
  }
}

function resetProgramPreview() {
  selectedTemplateId = null
  selectedTemplateName = null
  document.getElementById('dayAddProgramPreview').innerHTML = '<p class="no-metrics">Select a program to preview it</p>'
  document.getElementById('dayRangeRow').style.display = 'none'
  document.getElementById('saveDayAddProgramBtn').disabled = true
}

async function previewTemplate(templateId, templateName) {
  selectedTemplateId = templateId
  selectedTemplateName = templateName

  const preview = document.getElementById('dayAddProgramPreview')
  preview.innerHTML = '<p class="no-metrics">Loading…</p>'

  let details = cachedTemplateDays[templateId]
  if (!details) {
    const { data, error } = await supabase
      .from('program_weeks')
      .select('*, program_days(*, program_exercises(id))')
      .eq('program_id', templateId)
    if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this preview</p>'; return }
    details = buildTemplateDayList(data)
    cachedTemplateDays[templateId] = details
  }

  // A different row may have been clicked while this was still loading -
  // don't overwrite that newer preview/range with this now-stale one
  if (selectedTemplateId !== templateId) return

  totalProgramDays = Math.max(details.totalWeeks * 7, 1)
  programStartDay = 1
  programEndDay = totalProgramDays
  updateDayRangeLabels()
  document.getElementById('dayRangeRow').style.display = 'flex'
  document.getElementById('saveDayAddProgramBtn').disabled = false

  preview.innerHTML = `
    <div class="workout-preview-header">
      <h3>${templateName}</h3>
      <span class="workout-preview-count">${details.totalWeeks} week${details.totalWeeks === 1 ? '' : 's'}</span>
    </div>
    ${details.days.length === 0
      ? '<p class="no-metrics">No days scheduled in this program</p>'
      : details.days.map(d => `
        <div class="program-preview-day-row">
          <span class="program-preview-day-num">Day ${d.linearDay}</span>
          <span class="program-preview-day-label">${d.label || 'Day ' + d.dayNumber}${d.exerciseCount ? ' · ' + d.exerciseCount + ' exercises' : ''}</span>
        </div>
      `).join('')}
  `
}

// linearDay is the day's position counting straight through the whole
// program (week 3, day 2 -> (3-1)*7+2 = 16th day) - the same "Day N"
// numbering resolveDate() already uses everywhere else in this app
function buildTemplateDayList(weeks) {
  const days = []
  let totalWeeks = 0
  for (const week of weeks) {
    totalWeeks = Math.max(totalWeeks, week.week_number)
    for (const day of week.program_days) {
      days.push({
        linearDay: (week.week_number - 1) * 7 + day.day_number,
        dayNumber: day.day_number,
        label: day.label,
        exerciseCount: day.program_exercises.length
      })
    }
  }
  days.sort((a, b) => a.linearDay - b.linearDay)
  return { days, totalWeeks }
}

function updateDayRangeLabels() {
  document.getElementById('programStartDayLabel').textContent = 'Day ' + programStartDay
  document.getElementById('programEndDayLabel').textContent = 'Day ' + programEndDay
}

function setProgramStartDay(day) {
  programStartDay = day
  if (programStartDay > programEndDay) programEndDay = programStartDay
  updateDayRangeLabels()
}

function setProgramEndDay(day) {
  programEndDay = day
  if (programEndDay < programStartDay) programStartDay = programEndDay
  updateDayRangeLabels()
}

// ---- Day Picker modal: a paginated grid of day numbers (4 weeks/28 days
// per page), reused for both the Start and End fields via dayPickerTarget ----
let dayPickerTarget = null // 'start' | 'end'
let dayPickerPage = 0

function openDayPicker(target) {
  dayPickerTarget = target
  const current = target === 'start' ? programStartDay : programEndDay
  dayPickerPage = Math.floor((current - 1) / 28)
  renderDayPickerGrid()
  document.getElementById('dayPickerModal').classList.add('active')
}

function renderDayPickerGrid() {
  const totalWeeks = Math.max(Math.ceil(totalProgramDays / 7), 1)
  const pageCount = Math.max(Math.ceil(totalWeeks / 4), 1)
  dayPickerPage = Math.max(0, Math.min(dayPickerPage, pageCount - 1))

  const firstWeek = dayPickerPage * 4 + 1
  const lastWeek = Math.min(firstWeek + 3, totalWeeks)
  document.getElementById('dayPickerRangeLabel').textContent = `Week ${firstWeek} - ${lastWeek} of ${totalWeeks}`

  const firstDay = (firstWeek - 1) * 7 + 1
  const lastDay = Math.min(lastWeek * 7, totalProgramDays)
  const current = dayPickerTarget === 'start' ? programStartDay : programEndDay

  let cellsHtml = ''
  for (let d = firstDay; d <= lastDay; d++) {
    cellsHtml += `<button type="button" class="day-picker-cell ${d === current ? 'selected' : ''}" data-day="${d}">${String(d).padStart(2, '0')}</button>`
  }
  const grid = document.getElementById('dayPickerGrid')
  grid.innerHTML = cellsHtml

  grid.querySelectorAll('.day-picker-cell').forEach(cell => {
    cell.addEventListener('click', function() {
      const day = parseInt(cell.dataset.day)
      if (dayPickerTarget === 'start') setProgramStartDay(day)
      else setProgramEndDay(day)
      document.getElementById('dayPickerModal').classList.remove('active')
    })
  })

  document.getElementById('dayPickerPrevBtn').disabled = dayPickerPage === 0
  document.getElementById('dayPickerNextBtn').disabled = dayPickerPage >= pageCount - 1
}

document.getElementById('programStartDayField').addEventListener('click', function() { openDayPicker('start') })
document.getElementById('programEndDayField').addEventListener('click', function() { openDayPicker('end') })
document.getElementById('dayPickerPrevBtn').addEventListener('click', function() { dayPickerPage--; renderDayPickerGrid() })
document.getElementById('dayPickerNextBtn').addEventListener('click', function() { dayPickerPage++; renderDayPickerGrid() })
document.getElementById('dayPickerCancelBtn').addEventListener('click', function() {
  document.getElementById('dayPickerModal').classList.remove('active')
})

document.getElementById('saveDayAddProgramBtn').addEventListener('click', async function() {
  if (!selectedTemplateId) { customAlert('Please choose a program'); return }

  const saveBtn = this
  saveBtn.disabled = true
  saveBtn.textContent = 'Assigning...'

  try {
    await cloneTemplateToAthlete(selectedTemplateId, currentDayDateForAddTraining, programStartDay, programEndDay)
    document.getElementById('dayAddTrainingModal').classList.remove('active')
    await loadCalendarMonth(currentViewYear, currentViewMonth)
  } catch (err) {
    console.log(err)
    customAlert('Something went wrong while assigning the program. Check Supabase for a partially-created program under this athlete and delete it before retrying.')
  } finally {
    saveBtn.disabled = false
    saveBtn.textContent = 'Assign Program'
  }
})

document.getElementById('closeDayAddTrainingBtn').addEventListener('click', function() {
  document.getElementById('dayAddTrainingModal').classList.remove('active')
})

// ---- "+ New Training" - name it, then build it in an overlay without
// leaving the calendar page (training-builder.html loaded in an iframe) ----
document.getElementById('newTrainingFromDayBtn').addEventListener('click', function() {
  document.getElementById('dayAddTrainingModal').classList.remove('active')
  document.getElementById('newTrainingNameInput').value = ''
  document.getElementById('newTrainingNameModal').classList.add('active')
})

document.getElementById('cancelNewTrainingNameBtn').addEventListener('click', function() {
  document.getElementById('newTrainingNameModal').classList.remove('active')
  openDayAddTrainingModal(currentDayDateForAddTraining)
})

document.getElementById('saveNewTrainingNameBtn').addEventListener('click', async function() {
  const name = document.getElementById('newTrainingNameInput').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('trainings')
    .insert([{ coach_id: session.user.id, name }])
    .select()

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  cachedTrainings = null // force a fresh fetch so the one just created shows up
  document.getElementById('newTrainingNameModal').classList.remove('active')
  document.getElementById('trainingBuilderFrame').src = `training-builder.html?id=${data[0].id}&embed=1`
  document.getElementById('trainingBuilderOverlayModal').classList.add('active')
})

document.getElementById('doneTrainingBuilderBtn').addEventListener('click', function() {
  document.getElementById('trainingBuilderOverlayModal').classList.remove('active')
  document.getElementById('trainingBuilderFrame').src = 'about:blank'
  // Back to the day's training list, now including the one just built
  openDayAddTrainingModal(currentDayDateForAddTraining)
})

// Just closes back to the calendar month view afterward - already saw a
// preview of this training before hitting Select, so popping the day
// detail modal open again on top of that would just be showing it a
// second time. Clicking the day itself still opens it if wanted.
async function applyTrainingToDay(trainingId, trainingName, dateStr) {
  const dayId = await findOrCreateAdHocDay(dateStr, trainingName)
  await cloneTrainingToDay(trainingId, dayId)
  document.getElementById('dayAddTrainingModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

// Copies a saved training's exercise list onto an ad-hoc day - a real copy,
// same reasoning as cloneTemplateToAthlete() below: editing the Training
// Library entry later shouldn't retroactively change a day already built
// from it.
async function cloneTrainingToDay(trainingId, dayId) {
  const { data: trainingExercises, error } = await supabase
    .from('training_exercises')
    .select('*')
    .eq('training_id', trainingId)

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  trainingExercises.sort((a, b) => a.order_index - b.order_index)

  if (trainingExercises.length === 0) return

  // One bulk insert instead of one insert per exercise - used to be N
  // sequential round-trips for an N-exercise training
  const { error: insertError } = await supabase.from('program_exercises').insert(
    trainingExercises.map(te => ({
      day_id: dayId,
      exercise_id: te.exercise_id,
      order_index: te.order_index,
      prescribed_sets: te.prescribed_sets,
      prescribed_reps: te.prescribed_reps,
      prescribed_weight: te.prescribed_weight,
      rest_seconds: te.rest_seconds,
      extra_fields: te.extra_fields,
      set_targets: te.set_targets,
      notes: te.notes
    }))
  )
  if (insertError) { console.log(insertError); customAlert('Something went wrong copying the exercises'); return }
}

// name is only used the first time a training is created for this date -
// if one already exists (repeated adds to the same day), its existing name
// is kept as-is
async function findOrCreateAdHocDay(dateStr, name) {
  const { data: existing, error: findError } = await supabase
    .from('programs')
    .select('*, program_weeks(*, program_days(*))')
    .eq('athlete_id', athleteId)
    .eq('is_adhoc', true)
    .eq('start_date', dateStr)
    .maybeSingle()

  if (findError) { console.log(findError) }

  if (existing) {
    return existing.program_weeks[0].program_days[0].id
  }

  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{ coach_id: session.user.id, athlete_id: athleteId, is_template: false, is_adhoc: true, start_date: dateStr, name: name || 'Workout' }])
    .select()
  if (programError) { console.log(programError); customAlert('Something went wrong'); throw programError }

  const { data: newWeek, error: weekError } = await supabase
    .from('program_weeks')
    .insert([{ program_id: newProgram[0].id, week_number: 1 }])
    .select()
  if (weekError) { console.log(weekError); customAlert('Something went wrong'); throw weekError }

  const { data: newDay, error: dayError } = await supabase
    .from('program_days')
    .insert([{ week_id: newWeek[0].id, day_number: 1 }])
    .select()
  if (dayError) { console.log(dayError); customAlert('Something went wrong'); throw dayError }

  return newDay[0].id
}

// ==========================================================================
// ---- DURATION + EXTRA FIELD HELPERS ----
// Still needed by the always-editable scheduled-exercise card
// (renderScheduledExerciseCard/saveScheduledExercise above) even though the
// calendar no longer has its own exercise picker - editing what's already
// on a day is still supported.
// ==========================================================================

function addExtraFieldRowCal(containerId, name, value) {
  const container = document.getElementById(containerId)
  const row = document.createElement('div')
  row.className = 'extra-field-row'
  row.innerHTML = `
    <input type="text" class="extra-field-name" placeholder="Field name (e.g. RPE)" value="${name || ''}">
    <input type="text" class="extra-field-value" placeholder="Value (e.g. 8)" value="${value || ''}">
    <button type="button" class="extra-field-remove">✕</button>
  `
  row.querySelector('.extra-field-remove').addEventListener('click', function() { row.remove() })
  container.appendChild(row)
}

function collectExtraFieldsCal(containerId) {
  const rows = document.querySelectorAll('#' + containerId + ' .extra-field-row')
  const result = {}
  rows.forEach(row => {
    const name = row.querySelector('.extra-field-name').value.trim()
    const value = row.querySelector('.extra-field-value').value.trim()
    if (name && value) result[name] = value
  })
  return Object.keys(result).length ? result : null
}

// ==========================================================================
// ---- PER-SET TARGETS ----
// Same shape/reasoning as training-builder.js / program-builder.js: a
// program_exercises row keeps one set_targets array
// ([{reps, weight, rest, type}, ...], index 0 = Set 1) so each set can have
// its own target AND its own rest afterward (shorter between warmup sets
// than top sets) and its own type (warmup / main / failure), with
// prescribed_sets/prescribed_reps/prescribed_weight/rest_seconds kept in
// sync (length / first set's values) so every other place that only reads
// those old columns keeps working untouched.
// ==========================================================================
const SET_TYPES_CAL = { main: 'Main Set', warmup: 'Warmup Set', failure: 'Set to Failure' }

function deriveSetTargetsCal(row) {
  if (row.set_targets && row.set_targets.length) return row.set_targets
  const count = row.prescribed_sets || 1
  return Array.from({ length: count }, () => ({ reps: row.prescribed_reps || null, weight: row.prescribed_weight || null, rest: row.rest_seconds || null, type: 'main' }))
}

function renderSetTargetRowCal(setNumber, target, isTimed, tracksWeight, isUnilateral, onlyRow) {
  const repsPlaceholder = (isTimed ? 'e.g. 45 sec' : 'reps') + (isUnilateral ? ' each side' : '')
  return `
    <div class="set-target-row" data-set-number="${setNumber}">
      <span class="set-label">Set ${setNumber}</span>
      <select class="set-type-select">
        ${Object.entries(SET_TYPES_CAL).map(([value, label]) => `<option value="${value}" ${(target.type || 'main') === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <input type="text" class="set-reps-input" value="${target.reps || ''}" placeholder="${repsPlaceholder}">
      ${tracksWeight ? `<input type="number" class="set-weight-input" value="${target.weight != null ? target.weight : ''}" placeholder="kg" step="0.5">` : ''}
      <input type="number" class="set-rest-input" value="${target.rest != null ? target.rest : ''}" placeholder="rest sec">
      <button type="button" class="set-remove-btn" data-action="remove-set" ${onlyRow ? 'disabled' : ''}>✕</button>
    </div>
  `
}

function addSetTargetRowCal(rowsEl, isTimed, tracksWeight, isUnilateral) {
  const rows = [...rowsEl.querySelectorAll('.set-target-row')]
  if (rows.length === 1) rows[0].querySelector('.set-remove-btn').disabled = false
  rowsEl.insertAdjacentHTML('beforeend', renderSetTargetRowCal(rows.length + 1, { reps: null, weight: null, rest: null, type: 'main' }, isTimed, tracksWeight, isUnilateral, false))
}

// Removal can happen from the middle of the list, so every remaining row
// needs relabelling, not just a length check
function removeSetTargetRowCal(row) {
  const rowsEl = row.parentElement
  row.remove()
  const remaining = [...rowsEl.querySelectorAll('.set-target-row')]
  remaining.forEach((r, i) => {
    r.dataset.setNumber = i + 1
    r.querySelector('.set-label').textContent = `Set ${i + 1}`
  })
  if (remaining.length === 1) remaining[0].querySelector('.set-remove-btn').disabled = true
}

function getYouTubeEmbedUrlCal(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://www.youtube.com/embed/${match[1]}?autoplay=1` : null
}

// Tapping a card's thumbnail swaps it for a playing embed right in place,
// same as the athlete's own exercise card
function playInlineVideoCal(containerEl, url) {
  if (!url) return
  const embedUrl = getYouTubeEmbedUrlCal(url)
  if (!embedUrl) { window.open(url, '_blank'); return }
  containerEl.innerHTML = `<iframe src="${embedUrl}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`
}

// ==========================================================================
// ---- ASSIGN PROGRAM ----
// Clones a SLICE of a template's weeks/days/exercises tree (rangeStart to
// rangeEnd, both "Day N" counting straight through the whole program) into
// a brand new set of rows owned by this athlete - a real copy, not a live
// link, so editing the template later never changes an already-assigned
// athlete's calendar. Reached only through the "+" popup's Program tab
// (see saveDayAddProgramBtn above).
// ==========================================================================

// Not wrapped in a database transaction - a failure partway through leaves
// a partial clone. Since programs -> program_weeks -> program_days ->
// program_exercises all cascade-delete, recovery is just deleting that one
// programs row and retrying.
async function cloneTemplateToAthlete(templateId, startDate, rangeStart, rangeEnd) {
  // These 2 don't depend on each other's results, so they fire together
  const [
    { data: template, error: templateError },
    { data: weeks, error: weeksError }
  ] = await Promise.all([
    supabase.from('programs').select('*').eq('id', templateId).single(),
    supabase.from('program_weeks').select('*, program_days(*, program_exercises(*))').eq('program_id', templateId)
  ])
  if (templateError) throw templateError
  if (weeksError) throw weeksError

  // startDate is the calendar day that was clicked to open this popup, and
  // it's always meant to line up with rangeStart (day 1 of whatever slice
  // was picked) - resolveDate() always counts from the program's own day 1,
  // so the new program's start_date has to be shifted back by
  // (rangeStart - 1) days for that day to land on startDate. Reusing
  // resolveDate() itself for this (week 1, day "2 - rangeStart") instead of
  // separate date-math: with week=1 it reduces to startDate + (day - 1),
  // and day = 2 - rangeStart gives startDate - (rangeStart - 1).
  const newStartDate = resolveDate(startDate, 1, 2 - rangeStart)

  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{
      coach_id: session.user.id,
      athlete_id: athleteId,
      is_template: false,
      is_adhoc: false,
      name: template.name,
      start_date: newStartDate
    }])
    .select()
  if (programError) throw programError
  const newProgramId = newProgram[0].id

  weeks.sort((a, b) => a.week_number - b.week_number)

  // Only weeks that have at least one day inside the picked range
  const weeksInRange = weeks
    .map(week => ({
      week,
      days: [...week.program_days]
        .filter(day => {
          const linearDay = (week.week_number - 1) * 7 + day.day_number
          return linearDay >= rangeStart && linearDay <= rangeEnd
        })
        .sort((a, b) => a.day_number - b.day_number)
    }))
    .filter(w => w.days.length > 0)

  if (weeksInRange.length === 0) return

  // ---- Bulk-insert every week, then every day, then every exercise, one
  // insert call per table instead of one insert call per row - a 12-week
  // program used to mean 100+ sequential round-trips here, now it's 3-4.
  // Rows are matched back up to their new parent by a real key (week_number,
  // then week_id+day_number) rather than by array position, since a bulk
  // insert's response order isn't something to rely on. ----
  const { data: newWeeks, error: weeksInsertError } = await supabase
    .from('program_weeks')
    .insert(weeksInRange.map(w => ({ program_id: newProgramId, week_number: w.week.week_number })))
    .select()
  if (weeksInsertError) throw weeksInsertError

  const newWeekIdByNumber = {}
  newWeeks.forEach(w => { newWeekIdByNumber[w.week_number] = w.id })

  const dayRows = [] // flat list of { weekNumber, day } - remembers which template day each planned insert came from
  weeksInRange.forEach(w => {
    w.days.forEach(day => { dayRows.push({ weekNumber: w.week.week_number, day }) })
  })

  const { data: newDays, error: daysInsertError } = await supabase
    .from('program_days')
    .insert(dayRows.map(r => ({
      week_id: newWeekIdByNumber[r.weekNumber],
      day_number: r.day.day_number,
      label: r.day.label
    })))
    .select()
  if (daysInsertError) throw daysInsertError

  const newDayIdByKey = {}
  newDays.forEach(d => { newDayIdByKey[`${d.week_id}:${d.day_number}`] = d.id })

  const exerciseRows = []
  dayRows.forEach(r => {
    const newDayId = newDayIdByKey[`${newWeekIdByNumber[r.weekNumber]}:${r.day.day_number}`]
    const exercisesInDay = [...r.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
    exercisesInDay.forEach(pe => {
      exerciseRows.push({
        day_id: newDayId,
        exercise_id: pe.exercise_id,
        order_index: pe.order_index,
        prescribed_sets: pe.prescribed_sets,
        prescribed_reps: pe.prescribed_reps,
        prescribed_weight: pe.prescribed_weight,
        rest_seconds: pe.rest_seconds,
        extra_fields: pe.extra_fields,
        set_targets: pe.set_targets,
        notes: pe.notes
      })
    })
  })

  if (exerciseRows.length > 0) {
    const { error: exercisesInsertError } = await supabase.from('program_exercises').insert(exerciseRows)
    if (exercisesInsertError) throw exercisesInsertError
  }
}
