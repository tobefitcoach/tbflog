// ==========================================================================
// PROGRAM BUILDER
// Edits one template's Weeks -> Days -> Exercises. A template has no real
// dates yet - day_number just means "the Nth day of that week, once this
// gets assigned to an athlete with a start date" (see athlete-calendar.js
// for the date math that uses this). The coach's own label field is what
// actually describes a day ("Day 1 — Upper Body"). Each exercise is an
// always-editable card (video thumbnail, one row per set with its own
// reps/weight target, rest time, notes) instead of a popup modal - mirrors
// the athlete's own live workout screen (athlete-app/dashboard.js's
// renderActiveExercise/renderSetRow), same pattern as training-builder.js.
// ==========================================================================
import { supabase } from './coachClient.js'

const params = new URLSearchParams(window.location.search)
const programId = params.get('id')

let allExercises = []
let weeksCache = [] // last-loaded weeks (with nested days/exercises), used to compute next week/day/order numbers without extra queries
let currentDayIdForAddExercise = null

// Weeks page 4-at-a-time (same paging pattern as the athlete calendar's
// month view). Every week always shows all 7 day slots (day_number 1-7) as
// a real calendar-style grid - clicking one opens #programDayModal, whose
// body (#weeksList) is the only place a day's exercises are ever rendered.
const WEEKS_PER_PAGE = 4
let currentWeekPage = 0
let currentModalDayId = null // which day #programDayModal is currently showing, if any

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadProgram()
  loadWeeks()
  loadAllExercises()
}

// ==========================================================================
// ---- LOAD PROGRAM NAME ----
// ==========================================================================
async function loadProgram() {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('programs')
    .select('*')
    .eq('id', programId)
    .single()
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading program:', error)
    document.getElementById('programNameHeading').textContent = 'Program not found'
    customAlert('Something went wrong loading this program - check your connection and try again')
    return
  }

  document.getElementById('programNameHeading').textContent = data.name
}

// ==========================================================================
// ---- EXERCISE LIBRARY CACHE (for the "Add Exercise" picker dropdown) ----
// ==========================================================================
async function loadAllExercises() {
  const { data, error } = await fetchWithRetry((signal) => supabase.from('exercises').select('*').eq('archived', false).order('name').abortSignal(signal))
  if (error) { console.log('Error loading exercises:', error); customAlert('Something went wrong loading the exercise library - check your connection and try again'); return }
  allExercises = data
  populateExerciseSelect()
}

function populateExerciseSelect(selectedId) {
  const select = document.getElementById('pickerExerciseSelect')
  select.innerHTML = '<option value="">Choose an exercise...</option>' +
    allExercises.map(ex => `<option value="${ex.id}">${ex.name}</option>`).join('')
  if (selectedId) select.value = selectedId
}

// YouTube's thumbnail images are available at a predictable URL from just
// the video id, no API key needed - other hosts fall back to a placeholder
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

// Tapping a card's thumbnail swaps it for a playing embed right in place,
// same as the athlete's own exercise card
function playInlineVideo(containerEl, url) {
  if (!url) return
  const embedUrl = getYouTubeEmbedUrl(url)
  if (!embedUrl) { window.open(url, '_blank'); return }
  containerEl.innerHTML = `<iframe src="${embedUrl}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`
}

// ==========================================================================
// ---- EXTRA FIELDS (name/value pairs, e.g. "% of 1RM": "75", "RPE": "8") ---
// ==========================================================================
function addExtraFieldRow(containerId, name, value) {
  const container = document.getElementById(containerId)
  if (!container) return
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

function collectExtraFields(containerId) {
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
// A program_exercises row keeps one set_targets array
// ([{reps, weight, rest, type}, ...], index 0 = Set 1) so each set can have
// its own target (a pyramid: 12/10/8 reps at increasing weight) AND its own
// rest afterward (shorter between warmup sets than top sets) and its own
// type (warmup / main / failure), instead of one shared value applied to
// every set. prescribed_sets/prescribed_reps/prescribed_weight/rest_seconds
// are kept in sync with it on every save (length / first set's values)
// purely so every other place in the app that only reads those old columns
// keeps working untouched.
// ==========================================================================
const SET_TYPES = { main: 'Main Set', warmup: 'Warmup Set', failure: 'Set to Failure' }

function deriveSetTargets(row) {
  if (row.set_targets && row.set_targets.length) return row.set_targets
  const count = row.prescribed_sets || 1
  return Array.from({ length: count }, () => ({ reps: row.prescribed_reps || null, weight: row.prescribed_weight || null, rest: row.rest_seconds || null, type: 'main' }))
}

// Splits any previously-stored timed value into {mm, ss} so the mm:ss input
// boxes can be prefilled - handles the "M:SS" format this app now saves,
// old plain-seconds strings ("45") from before this change, and a
// best-effort digit grab for anything else free-typed in the past ("45s")
function parseTimeToParts(val) {
  if (val == null || val === '') return { mm: 0, ss: 0 }
  const str = String(val).trim()
  const mmss = str.match(/^(\d+):(\d{1,2})$/)
  if (mmss) return { mm: parseInt(mmss[1]), ss: Math.min(parseInt(mmss[2]), 59) }
  if (/^\d+$/.test(str)) {
    const total = parseInt(str)
    return { mm: Math.floor(total / 60), ss: total % 60 }
  }
  const digits = str.match(/\d+/)
  return digits ? { mm: 0, ss: Math.min(parseInt(digits[0]), 59) } : { mm: 0, ss: 0 }
}

function renderSetTargetRow(setNumber, target, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance, onlyRow) {
  const repsPlaceholder = 'reps' + (isUnilateral ? ' each side' : '')
  // Legacy rows (saved back when Timed replaced Reps instead of coexisting
  // with it) stored the duration IN the reps field - fall back to reading
  // it from there, but only when reps isn't ALSO being tracked, so a real
  // rep count can never get misread as a duration once both are on.
  const durationSource = target.duration != null ? target.duration : (isTimed && !tracksReps ? target.reps : null)
  const { mm, ss } = parseTimeToParts(durationSource)
  const restParts = parseTimeToParts(target.rest)
  return `
    <div class="set-target-row" data-set-number="${setNumber}">
      <span class="set-label">Set ${setNumber}</span>
      <select class="set-type-select">
        ${Object.entries(SET_TYPES).map(([value, label]) => `<option value="${value}" ${(target.type || 'main') === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      ${tracksReps ? `<input type="text" class="set-reps-input" value="${target.reps || ''}" placeholder="${repsPlaceholder}">` : ''}
      ${isTimed ? `
        <div class="set-time-group" title="Time - minutes:seconds">
          <span class="set-time-group-label">Time</span>
          <div class="set-time-input">
            <input type="text" inputmode="numeric" class="set-time-mm" value="${String(mm).padStart(2, '0')}" maxlength="2">
            <span class="set-time-sep">:</span>
            <input type="text" inputmode="numeric" class="set-time-ss" value="${String(ss).padStart(2, '0')}" maxlength="2">
          </div>
        </div>
      ` : ''}
      ${tracksWeight ? `<input type="number" class="set-weight-input" value="${target.weight != null ? target.weight : ''}" placeholder="kg" step="0.5">` : ''}
      ${tracksDistance ? `<input type="number" class="set-distance-input" value="${target.distance != null ? target.distance : ''}" placeholder="meters" step="1">` : ''}
      <div class="set-time-group" title="Rest - minutes:seconds">
        <span class="set-time-group-label">Rest</span>
        <div class="set-time-input">
          <input type="text" inputmode="numeric" class="set-time-mm set-rest-mm" value="${String(restParts.mm).padStart(2, '0')}" maxlength="2">
          <span class="set-time-sep">:</span>
          <input type="text" inputmode="numeric" class="set-time-ss set-rest-ss" value="${String(restParts.ss).padStart(2, '0')}" maxlength="2">
        </div>
      </div>
      <button type="button" class="set-remove-btn" data-action="remove-set" ${onlyRow ? 'disabled' : ''}>✕</button>
    </div>
  `
}

// A superset is performed as one shared round, so its exercises can't
// drift to different set counts - every other card linked to this one
// (same superset_group_id, same day), if any.
function linkedCardsFor(card, dayScopeEl) {
  const groupId = card.dataset.supersetGroupId
  if (!groupId) return []
  return [...dayScopeEl.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)].filter(c => c !== card)
}

// Reads a set row's current (possibly-edited) field values, so a new set
// added below it starts from what's already there instead of always blank -
// an untouched row's inputs are still at their blank defaults, so this
// naturally stays blank too when nothing was filled in yet.
function readSetRowValues(rowEl) {
  if (!rowEl) return { reps: null, duration: null, weight: null, rest: null, distance: null, type: 'main' }
  const repsInput = rowEl.querySelector('.set-reps-input')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const distanceInput = rowEl.querySelector('.set-distance-input')
  const typeSelect = rowEl.querySelector('.set-type-select')
  const timeMm = rowEl.querySelector('.set-time-mm:not(.set-rest-mm)')
  const timeSs = rowEl.querySelector('.set-time-ss:not(.set-rest-ss)')
  const restMm = rowEl.querySelector('.set-rest-mm')
  const restSs = rowEl.querySelector('.set-rest-ss')
  return {
    reps: repsInput ? repsInput.value : null,
    duration: timeMm ? `${timeMm.value}:${timeSs.value}` : null,
    weight: weightInput && weightInput.value !== '' ? weightInput.value : null,
    distance: distanceInput && distanceInput.value !== '' ? distanceInput.value : null,
    rest: restMm ? `${restMm.value}:${restSs.value}` : null,
    type: typeSelect ? typeSelect.value : 'main'
  }
}

function addSetTargetRow(rowsEl, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance) {
  const rows = [...rowsEl.querySelectorAll('.set-target-row')]
  if (rows.length === 1) rows[0].querySelector('.set-remove-btn').disabled = false
  const carryOver = readSetRowValues(rows[rows.length - 1])
  rowsEl.insertAdjacentHTML('beforeend', renderSetTargetRow(rows.length + 1, carryOver, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance, false))
}

// Removal can happen from the middle of the list, so every remaining row
// needs relabelling, not just a length check
function removeSetTargetRow(row) {
  const rowsEl = row.parentElement
  row.remove()
  const remaining = [...rowsEl.querySelectorAll('.set-target-row')]
  remaining.forEach((r, i) => {
    r.dataset.setNumber = i + 1
    r.querySelector('.set-label').textContent = `Set ${i + 1}`
  })
  if (remaining.length === 1) remaining[0].querySelector('.set-remove-btn').disabled = true
}

// ==========================================================================
// ---- LOAD + RENDER WEEKS / DAYS / EXERCISES ----
// One nested query pulls the whole tree; sorted client-side since the
// dataset per template is always small.
// ==========================================================================
// tracks_weight/is_timed/is_unilateral/tracks_distance normally come
// straight from the exercise's own row (pe.exercises) - an explicit
// *_override on THIS program_exercises row (set via Workout Builder's
// "Adjust Fields" on the Training this day was cloned from, or carried
// forward from a cloned template) takes precedence instead, scoped to
// just this one placement. Merging the override into pe.exercises here,
// once per fetch, means every existing read of pe.exercises.* downstream
// sees the right effective value with no other changes needed.
function applyFieldOverrides(pe) {
  if (!pe.exercises) return
  if (pe.tracks_weight_override != null) pe.exercises.tracks_weight = pe.tracks_weight_override
  if (pe.is_timed_override != null) pe.exercises.is_timed = pe.is_timed_override
  if (pe.is_unilateral_override != null) pe.exercises.is_unilateral = pe.is_unilateral_override
  if (pe.tracks_distance_override != null) pe.exercises.tracks_distance = pe.tracks_distance_override
}

async function loadWeeks() {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('program_weeks')
    .select('*, program_days(*, program_exercises(*, exercises!exercise_id(id, name, category, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)))')
    .eq('program_id', programId)
    .abortSignal(signal)
  )

  if (error) { console.log('Error loading weeks:', error); customAlert('Something went wrong loading this program - check your connection and try again'); return }

  data.sort((a, b) => a.week_number - b.week_number)
  data.forEach(week => {
    week.program_days.sort((a, b) => a.day_number - b.day_number)
    week.program_days.forEach(day => {
      day.program_exercises.sort((a, b) => a.order_index - b.order_index)
      day.program_exercises.forEach(applyFieldOverrides)
    })
  })

  weeksCache = data
  renderWeekNav()
}

// ==========================================================================
// ---- WEEK PAGER (4 weeks at a time) + THE DAY GRID ----
// Every week always shows all 7 day slots (day_number 1-7) as a real
// calendar-style grid, same look/interaction as the athlete calendar's own
// month view - an empty slot shows a hover "+" (jumps straight to Add
// Workout), a filled one shows what's on it and opens #programDayModal on
// click.
// ==========================================================================
function renderWeekNav() {
  const totalPages = Math.max(1, Math.ceil(weeksCache.length / WEEKS_PER_PAGE))
  if (currentWeekPage >= totalPages) currentWeekPage = totalPages - 1
  if (currentWeekPage < 0) currentWeekPage = 0

  const startIdx = currentWeekPage * WEEKS_PER_PAGE
  const pageWeeks = weeksCache.slice(startIdx, startIdx + WEEKS_PER_PAGE)

  const label = document.getElementById('weekPageLabel')
  if (!pageWeeks.length) {
    label.textContent = 'No weeks yet'
  } else {
    const first = pageWeeks[0].week_number
    const last = pageWeeks[pageWeeks.length - 1].week_number
    label.textContent = first === last ? `Week ${first}` : `Weeks ${first}–${last}`
  }
  document.getElementById('weekPagePrevBtn').disabled = currentWeekPage === 0
  document.getElementById('weekPageNextBtn').disabled = currentWeekPage >= totalPages - 1

  const grid = document.getElementById('programWeeksGrid')
  grid.innerHTML = pageWeeks.length
    ? pageWeeks.map(renderProgramWeekSection).join('')
    : '<p class="no-metrics">No weeks yet — click "+ Add Week" to get started</p>'
}

function renderProgramWeekSection(week) {
  return `
    <div class="program-week-heading" data-week-id="${week.id}">
      <h4>Week ${week.week_number}</h4>
      <div style="display:flex; gap:4px">
        <button type="button" class="program-week-copy" data-action="copy-week" data-week-id="${week.id}" title="Copy week">⧉</button>
        <button type="button" class="program-week-delete" data-action="delete-week" data-week-id="${week.id}" title="Delete week">✕</button>
      </div>
    </div>
    <div class="program-day-row">
      ${[1, 2, 3, 4, 5, 6, 7].map(dayNumber => renderProgramDayCell(week, dayNumber)).join('')}
    </div>
  `
}

const WORKOUT_TYPE_ICONS = { gym: '🏋️', field: '⚽', run: '🏃' }

function renderProgramDayCell(week, dayNumber) {
  const day = week.program_days.find(d => d.day_number === dayNumber)
  const hasContent = day && (day.label || day.program_exercises.length > 0)
  const typeIcon = day && day.workout_type ? WORKOUT_TYPE_ICONS[day.workout_type] + ' ' : ''
  const badgeLabel = hasContent
    ? typeIcon + (day.label || `${day.program_exercises.length} exercise${day.program_exercises.length === 1 ? '' : 's'}`)
    : ''

  const badges = hasContent ? `
    <div class="calendar-day-badges">
      <div class="calendar-day-badge-row">
        <span class="calendar-day-badge calendar-day-badge-planned">${badgeLabel}</span>
        <div class="kebab-menu calendar-badge-kebab">
          <button type="button" class="kebab-btn" data-action="toggle-kebab">⋮</button>
          <div class="kebab-dropdown">
            <button type="button" class="kebab-item" data-action="copy-day" data-day-id="${day.id}">Copy to another day</button>
            <button type="button" class="kebab-item" data-action="delete-day-cell" data-day-id="${day.id}">Delete Workout</button>
          </div>
        </div>
      </div>
    </div>` : ''

  return `
    <div class="calendar-day" data-action="open-day" data-week-id="${week.id}" data-day-number="${dayNumber}">
      <button type="button" class="calendar-day-add-btn" data-action="quick-add-day" data-week-id="${week.id}" data-day-number="${dayNumber}" title="Add a workout">+</button>
      ${badges}
    </div>
  `
}

// Every DB write below goes through weeksCache, so it's the source of truth
// - lets a specific week/day be found without a re-fetch, same convention
// findDay()/findPE() already use elsewhere in this file.
function findWeek(weekId) {
  return weeksCache.find(w => w.id === weekId)
}

// Days aren't pre-created for every slot (that'd be 7 rows per week up
// front, most never used) - created the first time the coach actually
// opens or adds to that slot, same lazy-creation shape as the athlete
// calendar's own findOrCreateAdHocDay
async function findOrCreateProgramDay(weekId, dayNumber) {
  const week = findWeek(weekId)
  if (!week) return null
  const existing = week.program_days.find(d => d.day_number === dayNumber)
  if (existing) return existing

  const { data, error } = await supabase.from('program_days').insert([{ week_id: weekId, day_number: dayNumber }]).select()
  if (error) { console.log(error); customAlert('Something went wrong'); return null }
  const newDay = { ...data[0], program_exercises: [] }
  week.program_days.push(newDay)
  return newDay
}

document.getElementById('programWeeksGrid').addEventListener('click', async function(e) {
  const deleteBtn = e.target.closest('[data-action="delete-week"]')
  if (deleteBtn) { await deleteWeek(deleteBtn.dataset.weekId); return }

  const copyWeekBtn = e.target.closest('[data-action="copy-week"]')
  if (copyWeekBtn) { openCopyWeekModal(copyWeekBtn.dataset.weekId); return }

  // Kebab (⋮) actions on a day cell's badge - each stops propagation so it
  // never also triggers the cell's own click (open-day), same reasoning as
  // quick-add-day below
  const kebabBtn = e.target.closest('[data-action="toggle-kebab"]')
  if (kebabBtn) {
    e.stopPropagation()
    const dropdown = kebabBtn.parentElement.querySelector('.kebab-dropdown')
    const wasActive = dropdown.classList.contains('active')
    document.querySelectorAll('#programWeeksGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
    if (!wasActive) dropdown.classList.add('active')
    return
  }

  const copyDayBtn = e.target.closest('[data-action="copy-day"]')
  if (copyDayBtn) {
    e.stopPropagation()
    copyDayBtn.closest('.kebab-dropdown').classList.remove('active')
    openCopyProgramDayModal(copyDayBtn.dataset.dayId)
    return
  }

  const deleteDayBtn = e.target.closest('[data-action="delete-day-cell"]')
  if (deleteDayBtn) {
    e.stopPropagation()
    deleteDayBtn.closest('.kebab-dropdown').classList.remove('active')
    await deleteDay(deleteDayBtn.dataset.dayId)
    return
  }

  // Separate handler + stopPropagation so clicking "+" doesn't also
  // trigger the cell's own click (which opens the full day-detail modal)
  const quickAddBtn = e.target.closest('[data-action="quick-add-day"]')
  if (quickAddBtn) {
    e.stopPropagation()
    const day = await findOrCreateProgramDay(quickAddBtn.dataset.weekId, parseInt(quickAddBtn.dataset.dayNumber))
    if (day) openAddTrainingModal(day.id)
    return
  }

  const cell = e.target.closest('[data-action="open-day"]')
  if (cell) {
    const day = await findOrCreateProgramDay(cell.dataset.weekId, parseInt(cell.dataset.dayNumber))
    if (day) openProgramDayModal(day.id)
  }
})

// Kebab dropdowns on the grid close on outside click (mirrors the same
// pattern in training-builder.js and athlete-calendar.js)
document.addEventListener('click', function(e) {
  if (e.target.closest('#programWeeksGrid .kebab-menu')) return
  document.querySelectorAll('#programWeeksGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
})

document.getElementById('weekPagePrevBtn').addEventListener('click', function() {
  currentWeekPage--
  renderWeekNav()
})

document.getElementById('weekPageNextBtn').addEventListener('click', function() {
  currentWeekPage++
  renderWeekNav()
})

// ==========================================================================
// ---- DAY DETAIL MODAL ----
// One day's exercises - the only place #weeksList (this page's original,
// always-editable exercise-card list) ever gets rendered now. Everything
// that already worked there (Add Exercise, Add Section, drag exercises,
// autosave, Save Day) is untouched; it just lives in a modal instead of
// being permanently inline.
// ==========================================================================
function openProgramDayModal(dayId) {
  currentModalDayId = dayId
  refreshProgramDayModalBody()
  document.getElementById('programDayModal').classList.add('active')
}

function refreshProgramDayModalBody() {
  const day = findDay(currentModalDayId)
  if (!day) return
  const week = weeksCache.find(w => w.program_days.some(d => d.id === currentModalDayId))

  document.getElementById('programDayModalTitle').textContent = week ? `Week ${week.week_number} — ${day.label || ('Day ' + day.day_number)}` : (day.label || ('Day ' + day.day_number))
  document.getElementById('programDayTypeSelect').value = day.workout_type || 'gym'
  document.getElementById('weeksList').innerHTML = renderDayBlock(day)

  // innerHTML wipes any dynamically-built children, so extra field rows
  // (built with document.createElement, not template strings) get
  // re-populated here for every card, same as the old edit modal did
  for (const pe of day.program_exercises) {
    if (pe.extra_fields) {
      for (const [k, v] of Object.entries(pe.extra_fields)) addExtraFieldRow(`extraFields-${pe.id}`, k, v)
    }
  }
}

// Refreshes just the one grid cell for the day currently open in the
// modal, from weeksCache (already kept live-accurate by every add/delete/
// autosave path) - avoids a full reload just to update one badge.
function refreshDayCellFor(dayId) {
  const day = findDay(dayId)
  const week = weeksCache.find(w => w.program_days.some(d => d.id === dayId))
  if (!day || !week) return
  const cell = document.querySelector(`#programWeeksGrid .calendar-day[data-week-id="${week.id}"][data-day-number="${day.day_number}"]`)
  if (cell) cell.outerHTML = renderProgramDayCell(week, day.day_number)
}

async function closeProgramDayModal() {
  if (currentModalDayId) {
    await flushAllPendingSaves(document.getElementById('weeksList'))
    refreshDayCellFor(currentModalDayId)
  }
  document.getElementById('programDayModal').classList.remove('active')
  currentModalDayId = null
}

document.getElementById('closeProgramDayBtn').addEventListener('click', closeProgramDayModal)

document.getElementById('programDayTypeSelect').addEventListener('change', async function() {
  const day = findDay(currentModalDayId)
  if (!day) return
  const { error } = await supabase.from('program_days').update({ workout_type: this.value }).eq('id', day.id)
  if (error) { console.log(error); customAlert('Something went wrong'); return }
  day.workout_type = this.value
  refreshDayCellFor(day.id)
})

document.getElementById('renameDayBtn').addEventListener('click', function() {
  const day = findDay(currentModalDayId)
  if (!day) return
  document.getElementById('renameDayInput').value = day.label || ''
  document.getElementById('renameDayModal').classList.add('active')
})

document.getElementById('cancelRenameDayBtn').addEventListener('click', function() {
  document.getElementById('renameDayModal').classList.remove('active')
})

document.getElementById('saveRenameDayBtn').addEventListener('click', async function() {
  const day = findDay(currentModalDayId)
  if (!day) return
  const label = document.getElementById('renameDayInput').value.trim() || null

  const { error } = await supabase.from('program_days').update({ label }).eq('id', day.id)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  day.label = label
  document.getElementById('renameDayModal').classList.remove('active')
  refreshProgramDayModalBody()
})

// One header per run of consecutive exercises sharing the same non-null
// section_label - list must already be sorted by order_index. Manually/
// individually added exercises (section_label null) never get a header.
function renderExerciseListHtml(list) {
  let html = ''
  let lastLabel // undefined sentinel - a run of nulls never gets a header
  for (const item of list) {
    if (item.section_label !== lastLabel) {
      if (item.section_label) html += `<div class="builder-section-header">${item.section_label}</div>`
      lastLabel = item.section_label
    }
    html += renderExerciseCard(item, list)
  }
  return html
}

function renderDayBlock(day) {
  return `
    <div class="exercise-item" data-day-id="${day.id}">
      <div class="metric-item-header" style="justify-content:flex-end">
        <div style="display:flex; gap:8px">
          <button class="btn-edit-entry" data-action="add-exercise" data-day-id="${day.id}">+ Add Exercise</button>
          <button class="btn-edit-entry" data-action="add-section" data-day-id="${day.id}">Add Section</button>
          <button class="btn-edit-entry" data-action="add-training" data-day-id="${day.id}">Add Workout</button>
          <button class="btn-delete-measurement" data-action="delete-day" data-day-id="${day.id}">Delete Day</button>
        </div>
      </div>
      ${day.program_exercises.length === 0
        ? '<p class="no-metrics">No exercises yet</p>'
        : renderExerciseListHtml(day.program_exercises)}
      ${day.program_exercises.length === 0 ? '' : `
        <button type="button" class="btn-save" data-action="save-day" data-day-id="${day.id}" style="margin-top:8px">Save Day</button>
      `}
    </div>
  `
}

function renderExerciseCard(pe, siblingExercises) {
  const tracksReps = !pe.exercises || pe.exercises.tracks_reps !== false
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const isUnilateral = pe.exercises && pe.exercises.is_unilateral
  const tracksDistance = pe.exercises && pe.exercises.tracks_distance
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const targets = deriveSetTargets(pe)
  const rowsHtml = targets.map((t, i) => renderSetTargetRow(i + 1, t, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance, targets.length === 1)).join('')
  const groupMembers = pe.superset_group_id ? (siblingExercises || []).filter(other => other.id !== pe.id && other.superset_group_id === pe.superset_group_id) : []
  const groupColor = pe.superset_group_id ? colorForSupersetGroup(pe.superset_group_id) : null
  const linkTitle = groupMembers.length
    ? `Linked with ${groupMembers.map(m => m.exercises ? m.exercises.name : 'exercise').join(', ')} - tap to remove`
    : 'Link with other exercises (superset)'

  return `
    <div class="builder-exercise-card" data-id="${pe.id}" data-superset-group-id="${pe.superset_group_id || ''}" data-section-instance-id="${pe.section_instance_id || ''}" data-section-label="${pe.section_label || ''}">
      <div class="builder-exercise-card-header">
        <span class="builder-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
        </button>
        <div class="builder-exercise-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${isUnilateral ? '<span class="builder-unilateral-badge">Each Side</span>' : ''}
        <button type="button" class="builder-link-btn ${pe.superset_group_id ? 'linked' : ''}" data-action="toggle-link" style="${groupColor ? `border-color:${groupColor}; color:${groupColor}; background-color:${groupColor}22` : ''}" title="${linkTitle}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3"></path><line x1="8" y1="12" x2="16" y2="12"></line></svg></button>
        <button type="button" class="btn-delete-measurement" data-action="delete-exercise" title="Remove from day"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
      </div>
      <div class="set-target-rows">
        ${rowsHtml}
      </div>
      <button type="button" class="builder-add-set-btn" data-action="add-set">+ Add Set</button>
      <div class="builder-exercise-notes">
        <label>Extra Fields (optional)</label>
        <div class="extra-fields-container" id="extraFields-${pe.id}"></div>
        <button type="button" class="btn-create-metric" data-action="add-extra-field" style="margin-top:6px">+ Add Field</button>
      </div>
      <div class="builder-exercise-notes">
        <label>Notes (visible to the athlete)</label>
        <input type="text" class="exercise-notes-input" value="${pe.notes || ''}" placeholder="e.g. Focus on controlled tempo">
      </div>
    </div>
  `
}

// Reads one card's current DOM state and saves it - called for every
// exercise in a day at once from that day's single "Save Day" button (see
// data-action="save-day" below), not from a per-card button, since a coach
// builds a whole day's exercises in one sitting and only wants to press
// Save once when that day is done. Returns true/false instead of alerting
// on its own so the caller can report one combined error if several cards
// in the day fail.
async function saveExerciseCard(peId, orderIndex) {
  const card = document.querySelector(`.builder-exercise-card[data-id="${peId}"]`)
  if (!card) return true

  const pe = findPE(peId)
  const tracksReps = !!(pe && (!pe.exercises || pe.exercises.tracks_reps !== false))
  const isTimed = !!(pe && pe.exercises && pe.exercises.is_timed)

  const rows = [...card.querySelectorAll('.set-target-row')]
  const setTargets = rows.map(row => {
    const repsInput = row.querySelector('.set-reps-input')
    const reps = repsInput ? (repsInput.value.trim() || null) : null
    let duration = null
    if (isTimed) {
      const mm = parseInt(row.querySelector('.set-time-mm').value) || 0
      const ss = parseInt(row.querySelector('.set-time-ss').value) || 0
      duration = (mm === 0 && ss === 0) ? null : `${mm}:${String(ss).padStart(2, '0')}`
    }
    const weightInput = row.querySelector('.set-weight-input')
    const weight = weightInput && weightInput.value ? parseFloat(weightInput.value) : null
    const distanceInput = row.querySelector('.set-distance-input')
    const distance = distanceInput && distanceInput.value ? parseFloat(distanceInput.value) : null
    const restMm = parseInt(row.querySelector('.set-rest-mm').value) || 0
    const restSs = parseInt(row.querySelector('.set-rest-ss').value) || 0
    const rest = (restMm === 0 && restSs === 0) ? null : restMm * 60 + restSs
    const type = row.querySelector('.set-type-select').value
    return { reps, duration, weight, distance, rest, type }
  })

  const notes = card.querySelector('.exercise-notes-input').value.trim() || null
  const extraFields = collectExtraFields(`extraFields-${peId}`)
  const first = setTargets[0] || { reps: null, duration: null, weight: null, rest: null }

  const updates = {
    set_targets: setTargets,
    prescribed_sets: setTargets.length,
    prescribed_reps: first.reps != null ? first.reps : first.duration,
    prescribed_weight: first.weight,
    rest_seconds: first.rest,
    extra_fields: extraFields,
    notes,
    order_index: orderIndex,
    superset_group_id: card.dataset.supersetGroupId || null
  }

  const { error } = await supabase.from('program_exercises').update(updates).eq('id', peId)

  if (error) { console.log(error); return false }
  // Keeps weeksCache in sync with what's actually saved, so any action that
  // rebuilds a day's cards from cache (inserting a section) reflects what
  // was just typed instead of overwriting it with stale pre-edit data - see
  // scheduleAutosave/flushCardSave below.
  if (pe) Object.assign(pe, updates)
  return true
}

// ==========================================================================
// ---- AUTOSAVE ----
// Every set/notes/extra-field edit and superset link/unlink used to only
// persist when the coach pressed that day's "Save Day" button - meaning any
// action that rebuilds a day's cards from weeksCache (like inserting a
// section) would silently wipe out whatever was typed but not yet saved.
// Now every edit gets written to the database on its own, a moment after
// the coach stops typing (same "it just stays, unless you change it
// yourself" reliability the athlete's own logging screen already has) -
// "Save Day" still exists, but nothing is ever actually waiting on it.
// ==========================================================================
let autosaveTimers = {}

function scheduleAutosave(peId) {
  clearTimeout(autosaveTimers[peId])
  autosaveTimers[peId] = setTimeout(() => flushCardSave(peId), 800)
}

async function flushCardSave(peId) {
  clearTimeout(autosaveTimers[peId])
  delete autosaveTimers[peId]
  const card = document.querySelector(`.builder-exercise-card[data-id="${peId}"]`)
  if (!card) return true
  const dayBlock = card.closest('.exercise-item')
  const ids = [...dayBlock.querySelectorAll('.builder-exercise-card')].map(c => c.dataset.id)
  const orderIndex = ids.indexOf(peId)
  if (orderIndex === -1) return true
  return saveExerciseCard(peId, orderIndex)
}

// Flushes every card in one day at once - used right before an action
// rebuilds that WHOLE day's cards from weeksCache (inserting a section), so
// nothing mid-edit on any other card in that day gets lost in the rebuild.
async function flushAllPendingSaves(dayBlock) {
  const ids = [...dayBlock.querySelectorAll('.builder-exercise-card')].map(c => c.dataset.id)
  await Promise.all(ids.map((id, i) => { clearTimeout(autosaveTimers[id]); delete autosaveTimers[id]; return saveExerciseCard(id, i) }))
}

// Saves every exercise card in one day at once (see data-action="save-day")
async function saveDay(dayId) {
  const day = findDay(dayId)
  if (!day) return
  const btn = document.querySelector(`[data-action="save-day"][data-day-id="${dayId}"]`)
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...' }

  const dayBlock = document.querySelector(`.exercise-item[data-day-id="${dayId}"]`)
  const ids = [...dayBlock.querySelectorAll('.builder-exercise-card')].map(card => card.dataset.id)
  ids.forEach(id => { clearTimeout(autosaveTimers[id]); delete autosaveTimers[id] })
  const results = await Promise.all(ids.map(saveExerciseCard))

  if (results.some(ok => !ok)) {
    customAlert('Something went wrong saving one or more exercises - please try again')
    if (btn) { btn.disabled = false; btn.textContent = 'Save Day' }
    return
  }

  document.getElementById('programDayModal').classList.remove('active')
  currentModalDayId = null
  await loadWeeks()
}

// ==========================================================================
// ---- SUPERSETS (link up to 4 exercises into one giant-set group) ----
// Same pattern as training-builder.js, scoped to one day's .exercise-item
// instead of the whole page - every member of a group always has to be
// within the same day. Draft-until-Save, exactly like set_targets/notes.
// ==========================================================================
let pickingGroupIds = null // array being built while picking, else null
const SUPERSET_CAP = 4

function handleLinkClick(id, listScopeEl) {
  const card = listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  const currentGroupId = card.dataset.supersetGroupId || null
  if (currentGroupId && !pickingGroupIds) { removeFromSupersetGroup(id, listScopeEl); return }
  if (pickingGroupIds && pickingGroupIds[0] === id) { finalizePicking(listScopeEl); return }
  if (pickingGroupIds && pickingGroupIds.includes(id)) return // already picked, not the original - ignore
  if (pickingGroupIds) { addToPickingGroup(id, listScopeEl); return }
  enterPickingMode(id, listScopeEl)
}

function enterPickingMode(id, listScopeEl) {
  pickingGroupIds = [id]
  refreshPickingHighlight(listScopeEl)
  updatePickingModeBar(listScopeEl)
}

// Tapping another unlinked card adds it to the group being built - once
// the cap is hit the group finalizes on its own, no extra tap needed
function addToPickingGroup(id, listScopeEl) {
  pickingGroupIds.push(id)
  if (pickingGroupIds.length >= SUPERSET_CAP) { finalizePicking(listScopeEl); return }
  refreshPickingHighlight(listScopeEl)
  updatePickingModeBar(listScopeEl)
}

function refreshPickingHighlight(listScopeEl) {
  listScopeEl.querySelectorAll('.builder-exercise-card').forEach(card => {
    const picked = pickingGroupIds.includes(card.dataset.id)
    const isLinked = !!card.dataset.supersetGroupId
    card.classList.toggle('picking-self', picked)
    card.classList.toggle('pickable', !picked && !isLinked)
  })
}

function exitPickingMode(listScopeEl) {
  pickingGroupIds = null
  listScopeEl.querySelectorAll('.builder-exercise-card').forEach(c => c.classList.remove('picking-self', 'pickable'))
  updatePickingModeBar(listScopeEl)
}

// Floating bar shown only while picking mode is active - the only way to
// confirm a superset used to be tapping the original card's 🔗 button
// again (undiscoverable, no visible affordance), so this gives an explicit
// "Finish Superset" button for stopping at 2 or 3 instead of the 4-cap
function updatePickingModeBar(listScopeEl) {
  const bar = document.getElementById('pickingModeBar')
  if (!bar) return
  if (!pickingGroupIds) { bar.style.display = 'none'; return }
  bar.style.display = 'flex'
  const n = pickingGroupIds.length
  document.getElementById('pickingModeBarCount').textContent = `${n} exercise${n === 1 ? '' : 's'} selected`
  const finishBtn = document.getElementById('pickingModeBarFinishBtn')
  finishBtn.disabled = n < 2
  finishBtn.onclick = () => finalizePicking(listScopeEl)
  document.getElementById('pickingModeBarCancelBtn').onclick = () => exitPickingMode(listScopeEl)
}

// Tapping the original card again finishes early with fewer than the cap -
// needs at least 2 to actually form a group, otherwise it's just a cancel
function finalizePicking(listScopeEl) {
  if (pickingGroupIds.length < 2) { exitPickingMode(listScopeEl); return }
  const groupId = crypto.randomUUID()
  const ids = pickingGroupIds
  ids.forEach(id => {
    listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`).dataset.supersetGroupId = groupId
  })
  exitPickingMode(listScopeEl)
  ids.forEach(id => refreshSupersetBadge(listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`), listScopeEl))
  ids.forEach(scheduleAutosave)
}

// Removes just this one card from its group (tapped via 🔗, or from
// deleteExerciseRow) - if that would leave only one member, that last one
// is cleared too, since a "group of 1" isn't a superset
function removeFromSupersetGroup(id, listScopeEl) {
  const card = listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  const groupId = card.dataset.supersetGroupId
  if (!groupId) return
  delete card.dataset.supersetGroupId
  const remaining = [...listScopeEl.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)]
  if (remaining.length === 1) delete remaining[0].dataset.supersetGroupId
  refreshSupersetBadge(card, listScopeEl)
  remaining.forEach(c => refreshSupersetBadge(c, listScopeEl))
  scheduleAutosave(id)
  remaining.forEach(c => scheduleAutosave(c.dataset.id))
}

// Deterministic color per superset group id, so several groups on the
// same day are visually distinguishable at a glance without spelling out
// which exercises are linked (that's in the 🔗 button's title tooltip
// instead) - same group id always resolves to the same color
const SUPERSET_COLORS = ['#4a4a8e', '#e0a030', '#3aa66e', '#c0466e', '#3a8ec0', '#a05fd6', '#c07a2e', '#5fb8b8']
function colorForSupersetGroup(groupId) {
  let hash = 0
  for (let i = 0; i < groupId.length; i++) hash = (hash * 31 + groupId.charCodeAt(i)) >>> 0
  return SUPERSET_COLORS[hash % SUPERSET_COLORS.length]
}

function refreshSupersetBadge(card, listScopeEl) {
  const linkBtn = card.querySelector('.builder-link-btn')
  const groupId = card.dataset.supersetGroupId
  linkBtn.classList.toggle('linked', !!groupId)

  if (!groupId) {
    linkBtn.style.borderColor = ''
    linkBtn.style.color = ''
    linkBtn.style.backgroundColor = ''
    linkBtn.title = 'Link with other exercises (superset)'
    return
  }

  const color = colorForSupersetGroup(groupId)
  linkBtn.style.borderColor = color
  linkBtn.style.color = color
  linkBtn.style.backgroundColor = color + '22'

  const others = [...listScopeEl.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)].filter(c => c !== card)
  const names = others.map(c => c.querySelector('.builder-exercise-name').textContent).filter(Boolean)
  linkBtn.title = names.length ? `Linked with ${names.join(', ')} - tap to remove` : 'Remove from superset'
}

// Small lookups into the in-memory tree, used instead of extra queries
function findDay(dayId) {
  for (const week of weeksCache) {
    const day = week.program_days.find(d => d.id === dayId)
    if (day) return day
  }
  return null
}

function findPE(peId) {
  for (const week of weeksCache) {
    for (const day of week.program_days) {
      const pe = day.program_exercises.find(p => p.id === peId)
      if (pe) return pe
    }
  }
  return null
}

// One click listener for the whole tree, instead of re-binding listeners
// on every re-render
document.getElementById('weeksList').addEventListener('click', async function(e) {
  const thumbBtn = e.target.closest('.builder-exercise-thumb')
  if (thumbBtn && thumbBtn.dataset.videoUrl) {
    playInlineVideo(thumbBtn, thumbBtn.dataset.videoUrl)
    return
  }

  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action

  if (action === 'add-exercise') openExercisePickerModal(btn.dataset.dayId)
  else if (action === 'add-section') openAddSectionModal(btn.dataset.dayId)
  else if (action === 'add-training') openAddTrainingModal(btn.dataset.dayId)
  else if (action === 'delete-day') await deleteDay(btn.dataset.dayId)
  else if (action === 'delete-exercise') deleteExerciseRow(btn.closest('.builder-exercise-card').dataset.id)
  else if (action === 'save-day') await saveDay(btn.dataset.dayId)
  else if (action === 'add-set' || action === 'remove-set' || action === 'add-extra-field') {
    const card = btn.closest('.builder-exercise-card')
    const peId = card.dataset.id
    const pe = findPE(peId)
    const tracksReps = !!(pe && (!pe.exercises || pe.exercises.tracks_reps !== false))
    const isTimed = !!(pe && pe.exercises && pe.exercises.is_timed)
    const tracksWeight = !!(pe && (!pe.exercises || pe.exercises.tracks_weight))
    const isUnilateral = !!(pe && pe.exercises && pe.exercises.is_unilateral)
    const tracksDistance = !!(pe && pe.exercises && pe.exercises.tracks_distance)

    if (action === 'add-set') {
      addSetTargetRow(card.querySelector('.set-target-rows'), tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance)
      scheduleAutosave(peId)
      const dayScopeEl = card.closest('.exercise-item')
      for (const other of linkedCardsFor(card, dayScopeEl)) {
        const oPe = findPE(other.dataset.id)
        addSetTargetRow(
          other.querySelector('.set-target-rows'),
          !!(oPe && (!oPe.exercises || oPe.exercises.tracks_reps !== false)),
          !!(oPe && oPe.exercises && oPe.exercises.is_timed),
          !!(oPe && (!oPe.exercises || oPe.exercises.tracks_weight)),
          !!(oPe && oPe.exercises && oPe.exercises.is_unilateral),
          !!(oPe && oPe.exercises && oPe.exercises.tracks_distance)
        )
        scheduleAutosave(other.dataset.id)
      }
    } else if (action === 'remove-set') {
      const row = btn.closest('.set-target-row')
      const setNumber = row.dataset.setNumber
      removeSetTargetRow(row)
      scheduleAutosave(peId)
      const dayScopeEl = card.closest('.exercise-item')
      for (const other of linkedCardsFor(card, dayScopeEl)) {
        const otherRow = other.querySelector(`.set-target-row[data-set-number="${setNumber}"]`)
        if (otherRow && other.querySelectorAll('.set-target-row').length > 1) {
          removeSetTargetRow(otherRow)
          scheduleAutosave(other.dataset.id)
        }
      }
    }
    else if (action === 'add-extra-field') addExtraFieldRow(`extraFields-${peId}`)
  } else if (action === 'toggle-link') {
    handleLinkClick(btn.closest('.builder-exercise-card').dataset.id, btn.closest('.exercise-item'))
  }
})

// mm:ss time boxes: strip anything non-digit as it's typed, then pad back
// to 2 digits (and clamp seconds to 59) once the coach taps away. Selects
// the "00" on focus so typing a digit replaces it instead of needing a
// manual delete first
document.getElementById('weeksList').addEventListener('focusin', function(e) {
  if (e.target.matches('.set-time-mm, .set-time-ss')) {
    e.target.select()
  }
})
document.getElementById('weeksList').addEventListener('input', function(e) {
  if (e.target.matches('.set-time-mm, .set-time-ss')) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 2)
  }
})
document.getElementById('weeksList').addEventListener('focusout', function(e) {
  if (e.target.matches('.set-time-mm, .set-time-ss')) {
    const max = e.target.classList.contains('set-time-ss') ? 59 : 99
    const val = Math.min(parseInt(e.target.value) || 0, max)
    e.target.value = String(val).padStart(2, '0')
  }
})

// Any set field, note, or extra-field value - autosave the owning card a
// moment after the coach stops typing (see scheduleAutosave above)
const AUTOSAVE_FIELD_SELECTOR = '.set-reps-input, .set-weight-input, .set-distance-input, .set-time-mm, .set-time-ss, .exercise-notes-input, .extra-field-value'
document.getElementById('weeksList').addEventListener('input', function(e) {
  if (!e.target.matches(AUTOSAVE_FIELD_SELECTOR)) return
  const card = e.target.closest('.builder-exercise-card')
  if (card) scheduleAutosave(card.dataset.id)
})
document.getElementById('weeksList').addEventListener('change', function(e) {
  if (!e.target.matches('.set-type-select')) return
  const card = e.target.closest('.builder-exercise-card')
  if (card) scheduleAutosave(card.dataset.id)
})

// ---- Reorder exercises within a day by dragging the ⠿ handle ----
// Purely a DOM reorder while dragging (no network call), scoped to stay
// within the same day - the new order is only written to order_index when
// that day's own Save button is pressed, same as every other edit here.
// Dragging between different days isn't supported. Grabbing any member of
// a section drags the whole section together - see dataset.sectionInstanceId
// grouping below - since the whole point of a section is that it stays
// together.
let draggingCards = []
let draggingDayId = null

document.getElementById('weeksList').addEventListener('dragstart', function(e) {
  const handle = e.target.closest('.builder-drag-handle')
  if (!handle) return
  const card = handle.closest('.builder-exercise-card')
  const dayBlock = card.closest('.exercise-item')
  draggingDayId = dayBlock.dataset.dayId
  const instanceId = card.dataset.sectionInstanceId
  draggingCards = instanceId
    ? [...dayBlock.querySelectorAll(`.builder-exercise-card[data-section-instance-id="${instanceId}"]`)]
    : [card]
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', '')
  e.dataTransfer.setDragImage(card, 20, 20)
  setTimeout(function() { draggingCards.forEach(c => c.classList.add('dragging')) }, 0)
})

document.getElementById('weeksList').addEventListener('dragover', function(e) {
  if (!draggingCards.length) return
  const dayBlock = e.target.closest(`.exercise-item[data-day-id="${draggingDayId}"]`)
  if (!dayBlock) return
  e.preventDefault()

  // Only a standalone card, or the FIRST card of a stationary section,
  // counts as a valid drop-target boundary - this is what makes it
  // impossible to drop in the middle of someone else's section
  const cards = [...dayBlock.querySelectorAll('.builder-exercise-card:not(.dragging)')]
  const unitLeaders = cards.filter(function(c) {
    const id = c.dataset.sectionInstanceId
    if (!id) return true
    const prev = c.previousElementSibling
    return !prev || prev.dataset.sectionInstanceId !== id
  })
  const after = unitLeaders.reduce(function(closest, card) {
    const box = card.getBoundingClientRect()
    const offset = e.clientY - box.top - box.height / 2
    return (offset < 0 && offset > closest.offset) ? { offset, element: card } : closest
  }, { offset: -Infinity, element: null }).element

  if (after) {
    draggingCards.forEach(c => dayBlock.insertBefore(c, after))
  } else {
    // Nothing to insert before means "goes last" - but the Save Day button
    // is also a sibling in this container, so insert before that instead
    // of appendChild (which would drop the card below the Save button)
    const saveBtn = dayBlock.querySelector('[data-action="save-day"]')
    if (saveBtn) draggingCards.forEach(c => dayBlock.insertBefore(c, saveBtn))
    else draggingCards.forEach(c => dayBlock.appendChild(c))
  }
})

document.getElementById('weeksList').addEventListener('dragend', function() {
  draggingCards.forEach(c => c.classList.remove('dragging'))
  draggingCards = []
  draggingDayId = null
})

// ==========================================================================
// ---- ADD / DELETE WEEK ----
// ==========================================================================
// Jumps to whichever page the new week lands on, so the coach immediately
// sees the week they just added instead of having to page forward
// themselves.
document.getElementById('addWeekBtn').addEventListener('click', async function() {
  const nextNumber = weeksCache.length ? Math.max(...weeksCache.map(w => w.week_number)) + 1 : 1

  const { data, error } = await supabase
    .from('program_weeks')
    .insert([{ program_id: programId, week_number: nextNumber }])
    .select()

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  const newWeek = { ...data[0], program_days: [] }
  weeksCache.push(newWeek)
  currentWeekPage = Math.floor((weeksCache.length - 1) / WEEKS_PER_PAGE)
  renderWeekNav()
})

// The day-detail modal is the only place unsaved edits can be sitting - if
// it's open for a day inside the week being deleted, flush + close it
// first so nothing typed but not yet autosaved gets lost
async function deleteWeek(weekId) {
  if (!(await customConfirm('Delete this week and everything in it?'))) return

  const week = findWeek(weekId)
  if (week && currentModalDayId && week.program_days.some(d => d.id === currentModalDayId)) {
    await flushAllPendingSaves(document.getElementById('weeksList'))
    document.getElementById('programDayModal').classList.remove('active')
    currentModalDayId = null
  }

  const { error } = await supabase.from('program_weeks').delete().eq('id', weekId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  weeksCache = weeksCache.filter(w => w.id !== weekId)

  const totalPages = Math.max(1, Math.ceil(weeksCache.length / WEEKS_PER_PAGE))
  if (currentWeekPage >= totalPages) currentWeekPage = totalPages - 1
  renderWeekNav()
}

// ==========================================================================
// ---- DELETE DAY ----
// A day slot isn't "added" separately from the grid anymore (see
// findOrCreateProgramDay) - only deleting one is still an explicit action,
// from inside the day-detail modal itself.
// ==========================================================================
async function deleteDay(dayId) {
  if (!(await customConfirm('Delete this day and its exercises?'))) return

  const { error } = await supabase.from('program_days').delete().eq('id', dayId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  // Cancel any pending autosave for this day's cards - the row (and its
  // exercises, cascade-deleted) is already gone, so a stray timer firing
  // afterward would just be a wasted no-op write at best
  document.querySelectorAll(`.exercise-item[data-day-id="${dayId}"] .builder-exercise-card`).forEach(card => {
    clearTimeout(autosaveTimers[card.dataset.id])
    delete autosaveTimers[card.dataset.id]
  })

  for (const week of weeksCache) {
    const idx = week.program_days.findIndex(d => d.id === dayId)
    if (idx === -1) continue
    week.program_days.splice(idx, 1)
    break
  }

  if (currentModalDayId === dayId) {
    document.getElementById('programDayModal').classList.remove('active')
    currentModalDayId = null
  }
  renderWeekNav()
}

// ==========================================================================
// ---- ADD EXERCISE (picker, with inline "create new") ----
// Adds a bare row (no prescribed values yet) - it renders immediately as
// one blank, empty set row on its card (see deriveSetTargets), ready to
// edit right there, same as dragging an exercise into a Training.
// ==========================================================================
function openExercisePickerModal(dayId) {
  currentDayIdForAddExercise = dayId
  populateExerciseSelect()
  document.getElementById('exercisePickerModal').classList.add('active')
}

document.getElementById('cancelExercisePickerBtn').addEventListener('click', function() {
  document.getElementById('exercisePickerModal').classList.remove('active')
})

// Appends just the new card instead of reloading + re-rendering the whole
// tree, so any unsaved edits sitting in other cards' rows aren't wiped out
document.getElementById('saveExercisePickerBtn').addEventListener('click', async function() {
  const exerciseId = document.getElementById('pickerExerciseSelect').value
  if (!exerciseId) { customAlert('Please choose an exercise'); return }

  const day = findDay(currentDayIdForAddExercise)
  const nextOrder = day.program_exercises.length ? Math.max(...day.program_exercises.map(pe => pe.order_index)) + 1 : 0

  const { data, error } = await supabase.from('program_exercises').insert([{
    day_id: currentDayIdForAddExercise,
    exercise_id: exerciseId,
    order_index: nextOrder
  }]).select('*, exercises!exercise_id(id, name, category, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  const newPE = data[0]
  day.program_exercises.push(newPE)

  const dayBlock = document.querySelector(`.exercise-item[data-day-id="${day.id}"]`)
  const noExMsg = dayBlock.querySelector('.no-metrics')
  const saveBtn = dayBlock.querySelector('[data-action="save-day"]')
  if (noExMsg) {
    noExMsg.outerHTML = renderExerciseCard(newPE) + `<button type="button" class="btn-save" data-action="save-day" data-day-id="${day.id}" style="margin-top:8px">Save Day</button>`
  } else if (saveBtn) {
    saveBtn.insertAdjacentHTML('beforebegin', renderExerciseCard(newPE))
  } else {
    dayBlock.insertAdjacentHTML('beforeend', renderExerciseCard(newPE))
  }

  document.getElementById('exercisePickerModal').classList.remove('active')
})

// ---- Create New Exercise, inline (opens on top of the picker) ----
function populateCreateCategorySelect() {
  const select = document.getElementById('createExerciseCategory')
  const categories = [...new Set(allExercises.map(ex => ex.category).filter(c => c && c.trim()))].sort()
  select.innerHTML = '<option value="">Choose Category</option>' +
    categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'
  select.value = ''
  toggleCreateNewCategoryField()
}

function toggleCreateNewCategoryField() {
  const isNew = document.getElementById('createExerciseCategory').value === '__new__'
  document.getElementById('createExerciseNewCategoryGroup').style.display = isNew ? 'block' : 'none'
}

document.getElementById('createExerciseCategory').addEventListener('change', toggleCreateNewCategoryField)

// Type dropdown: always offers the two built-ins, plus any custom type a
// coach has already made up, plus "+ Add New Type" - same pattern as Category
const BUILT_IN_TYPES = { weights: 'Weightlifting (sets, reps, weight)', timed: 'Timed (sets, duration)', plyometric: 'Plyometric (sets, foot contacts, intensity)' }

function populateCreateTypeSelect() {
  const select = document.getElementById('createExerciseType')
  const customTypes = [...new Set(allExercises.map(ex => ex.type).filter(t => t && !(t in BUILT_IN_TYPES)))].sort()
  select.innerHTML =
    Object.entries(BUILT_IN_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('') +
    customTypes.map(t => `<option value="${t}">${t}</option>`).join('') +
    '<option value="__new__">+ Add New Type</option>'
  select.value = 'weights'
  toggleCreateNewTypeField()
}

function toggleCreateNewTypeField() {
  const isNew = document.getElementById('createExerciseType').value === '__new__'
  document.getElementById('createExerciseNewTypeGroup').style.display = isNew ? 'block' : 'none'
}

// Nudges the logging-field toggles to their common defaults when the coach
// actually picks a type - the coach can still flip either toggle back
// afterward for a less common combination (e.g. a weighted timed hold)
function applyTypeLoggingDefaults(type) {
  if (type === 'timed') {
    document.getElementById('createExerciseTracksReps').checked = false
    document.getElementById('createExerciseIsTimed').checked = true
    document.getElementById('createExerciseTracksWeight').checked = false
  } else if (type === 'weights') {
    document.getElementById('createExerciseTracksReps').checked = true
    document.getElementById('createExerciseIsTimed').checked = false
    document.getElementById('createExerciseTracksWeight').checked = true
  }
}

document.getElementById('createExerciseType').addEventListener('change', function() {
  toggleCreateNewTypeField()
  applyTypeLoggingDefaults(this.value)
})

document.getElementById('createNewExerciseBtn').addEventListener('click', function() {
  document.getElementById('createExerciseName').value = ''
  document.getElementById('createExerciseNewCategory').value = ''
  populateCreateCategorySelect()
  document.getElementById('createExerciseNewType').value = ''
  populateCreateTypeSelect()
  document.getElementById('createExerciseTracksReps').checked = true
  document.getElementById('createExerciseTracksWeight').checked = true
  document.getElementById('createExerciseIsTimed').checked = false
  document.getElementById('createExerciseIsUnilateral').checked = false
  document.getElementById('createExerciseTracksDistance').checked = false
  document.getElementById('createExerciseVideoUrl').value = ''
  document.getElementById('createExerciseInstructions').value = ''
  document.getElementById('createExerciseModal').classList.add('active')
})

document.getElementById('cancelCreateExerciseBtn').addEventListener('click', function() {
  document.getElementById('createExerciseModal').classList.remove('active')
})

document.getElementById('saveCreateExerciseBtn').addEventListener('click', async function() {
  const name = document.getElementById('createExerciseName').value.trim()
  const categorySelect = document.getElementById('createExerciseCategory').value
  const category = categorySelect === '__new__'
    ? document.getElementById('createExerciseNewCategory').value.trim()
    : categorySelect
  const typeSelect = document.getElementById('createExerciseType').value
  const type = typeSelect === '__new__'
    ? document.getElementById('createExerciseNewType').value.trim() || 'weights'
    : typeSelect
  const videoUrl = document.getElementById('createExerciseVideoUrl').value.trim()
  const instructions = document.getElementById('createExerciseInstructions').value.trim()
  const tracksReps = document.getElementById('createExerciseTracksReps').checked
  const tracksWeight = document.getElementById('createExerciseTracksWeight').checked
  const isTimed = document.getElementById('createExerciseIsTimed').checked
  const isUnilateral = document.getElementById('createExerciseIsUnilateral').checked
  const tracksDistance = document.getElementById('createExerciseTracksDistance').checked

  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('exercises')
    .insert([{ coach_id: session.user.id, name, category, type, video_url: videoUrl, instructions, tracks_reps: tracksReps, tracks_weight: tracksWeight, is_timed: isTimed, is_unilateral: isUnilateral, tracks_distance: tracksDistance }])
    .select()

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  allExercises.push(data[0])
  allExercises.sort((a, b) => a.name.localeCompare(b.name))
  populateExerciseSelect(data[0].id)
  document.getElementById('createExerciseModal').classList.remove('active')
})

// ==========================================================================
// ---- DELETE A SCHEDULED EXERCISE ----
// Swapping which exercise a row points to isn't supported inline - delete +
// re-add covers it
// ==========================================================================
// Removes just this one card instead of reloading the whole tree, so
// unsaved edits sitting in other cards aren't wiped out
async function deleteExerciseRow(peId) {
  if (!(await customConfirm('Remove this exercise from the day?'))) return

  clearTimeout(autosaveTimers[peId])
  delete autosaveTimers[peId]
  const card = document.querySelector(`.builder-exercise-card[data-id="${peId}"]`)
  if (card && card.dataset.supersetGroupId) removeFromSupersetGroup(peId, card.closest('.exercise-item'))

  const { error } = await supabase.from('program_exercises').delete().eq('id', peId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  for (const week of weeksCache) {
    for (const day of week.program_days) {
      const idx = day.program_exercises.findIndex(pe => pe.id === peId)
      if (idx === -1) continue
      day.program_exercises.splice(idx, 1)
      if (card) card.remove()
      if (day.program_exercises.length === 0) {
        const dayBlock = document.querySelector(`.exercise-item[data-day-id="${day.id}"]`)
        const saveBtn = dayBlock ? dayBlock.querySelector('[data-action="save-day"]') : null
        if (saveBtn) saveBtn.remove()
        if (dayBlock) dayBlock.insertAdjacentHTML('beforeend', '<p class="no-metrics">No exercises yet</p>')
      }
      return
    }
  }
}

// ==========================================================================
// ---- ADD SECTION (bulk-insert a saved reusable group of exercises) ----
// Day-scoped version of training-builder.js's "Add Section" - list +
// preview, same UX as the calendar's "Add Workout" popup. Inserted
// exercises are offset past whatever's already in the day (never copied
// verbatim - a verbatim copy would collide/interleave order_index with
// exercises already in the day) and stamped with section_label so they
// render grouped under a header (see renderExerciseListHtml).
// ==========================================================================
let cachedSections = null
let selectedSectionId = null
let selectedSectionName = null
let currentDayIdForAddSection = null

async function getSectionsList() {
  if (cachedSections) return cachedSections
  const { data, error } = await fetchWithRetry((signal) => supabase.from('sections').select('*').order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your sections - check your connection and try again'); return null }
  cachedSections = data
  return cachedSections
}

function resetSectionPreview() {
  selectedSectionId = null
  selectedSectionName = null
  document.getElementById('addSectionPreview').innerHTML = '<p class="no-metrics">Select a section to preview it</p>'
  document.getElementById('insertSectionBtn').disabled = true
}

async function openAddSectionModal(dayId) {
  currentDayIdForAddSection = dayId
  resetSectionPreview()
  const list = document.getElementById('addSectionList')
  const data = await getSectionsList()

  if (data === null) {
    list.innerHTML = '<p class="no-metrics">Something went wrong loading the Section Library</p>'
  } else if (data.length === 0) {
    list.innerHTML = '<p class="no-metrics">No sections saved yet - create one in the Section Library first</p>'
  } else {
    list.innerHTML = data.map(s => `
      <div class="training-pick-row" data-id="${s.id}" data-name="${s.name}">
        <span>${s.name}</span>
      </div>
    `).join('')

    list.querySelectorAll('.training-pick-row').forEach(row => {
      row.addEventListener('click', function() {
        list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        previewSection(row.dataset.id, row.dataset.name)
      })
    })
  }

  document.getElementById('addSectionModal').classList.add('active')
}

function renderSectionPreviewExercise(se) {
  const thumb = getYouTubeThumbnail(se.exercises && se.exercises.video_url)
  const setCount = deriveSetTargets(se).length
  return `
    <div class="workout-preview-exercise">
      <div class="workout-preview-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg>'}</div>
      <div class="workout-preview-info">
        <div class="workout-preview-name">${se.exercises ? se.exercises.name : 'Unknown exercise'}</div>
        <div class="workout-preview-target">${setCount} set${setCount === 1 ? '' : 's'}</div>
      </div>
    </div>
  `
}

async function previewSection(sectionId, name) {
  selectedSectionId = sectionId
  selectedSectionName = name
  document.getElementById('insertSectionBtn').disabled = false

  const preview = document.getElementById('addSectionPreview')
  preview.innerHTML = '<p class="no-metrics">Loading...</p>'

  const { data, error } = await supabase
    .from('section_exercises')
    .select('*, exercises!exercise_id(id, name, video_url)')
    .eq('section_id', sectionId)

  if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this section</p>'; return }

  data.sort((a, b) => a.order_index - b.order_index)
  preview.innerHTML = data.length === 0
    ? '<p class="no-metrics">No exercises in this section</p>'
    : data.map(renderSectionPreviewExercise).join('')
}

document.getElementById('insertSectionBtn').addEventListener('click', async function() {
  if (!selectedSectionId) return
  await insertSectionIntoDay(selectedSectionId, selectedSectionName)
})

document.getElementById('closeAddSectionBtn').addEventListener('click', function() {
  document.getElementById('addSectionModal').classList.remove('active')
})

async function insertSectionIntoDay(sectionId, sectionName) {
  const day = findDay(currentDayIdForAddSection)
  if (!day) return

  const { data: sectionExercises, error } = await supabase.from('section_exercises').select('*').eq('section_id', sectionId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }
  sectionExercises.sort((a, b) => a.order_index - b.order_index)
  if (sectionExercises.length === 0) { document.getElementById('addSectionModal').classList.remove('active'); return }

  const baseOrder = day.program_exercises.length ? Math.max(...day.program_exercises.map(pe => pe.order_index)) + 1 : 0

  // Fresh group id per distinct superset_group_id in this batch, so
  // inserting the same section twice into one day doesn't make both
  // copies' supersets collide into a single group - same reasoning as the
  // baseOrder offset just above, applied to group ids instead of order_index
  const groupIdMap = {}
  for (const se of sectionExercises) {
    if (se.superset_group_id && !groupIdMap[se.superset_group_id]) groupIdMap[se.superset_group_id] = crypto.randomUUID()
  }

  // One id shared by the WHOLE batch (unlike groupIdMap above, which is
  // per superset sub-group within the batch) - this is what keeps the
  // section together as a single block in the drag-reorder UI from now on
  const sectionInstanceId = crypto.randomUUID()

  const { data: inserted, error: insertError } = await supabase.from('program_exercises').insert(
    sectionExercises.map((se, i) => ({
      day_id: day.id, exercise_id: se.exercise_id, order_index: baseOrder + i,
      prescribed_sets: se.prescribed_sets, prescribed_reps: se.prescribed_reps,
      prescribed_weight: se.prescribed_weight, rest_seconds: se.rest_seconds,
      extra_fields: se.extra_fields, set_targets: se.set_targets, notes: se.notes,
      section_label: sectionName,
      section_instance_id: sectionInstanceId,
      superset_group_id: se.superset_group_id ? groupIdMap[se.superset_group_id] : null
    }))
  ).select('*, exercises!exercise_id(id, name, category, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
  if (insertError) { console.log(insertError); customAlert('Something went wrong copying the exercises'); return }

  day.program_exercises.push(...inserted)

  const dayBlock = document.querySelector(`.exercise-item[data-day-id="${day.id}"]`)
  await flushAllPendingSaves(dayBlock)
  const noExMsg = dayBlock.querySelector('.no-metrics')
  const html = renderExerciseListHtml(day.program_exercises)
  if (noExMsg) {
    noExMsg.outerHTML = html + `<button type="button" class="btn-save" data-action="save-day" data-day-id="${day.id}" style="margin-top:8px">Save Day</button>`
  } else {
    // Full re-render of this day's list keeps section-header grouping
    // correct without hand-splicing insertion points mid-list
    const saveBtn = dayBlock.querySelector('[data-action="save-day"]')
    dayBlock.querySelectorAll('.builder-exercise-card, .builder-section-header').forEach(el => el.remove())
    const target = saveBtn || null
    if (target) target.insertAdjacentHTML('beforebegin', html)
    else dayBlock.insertAdjacentHTML('beforeend', html)
  }

  document.getElementById('addSectionModal').classList.remove('active')
}

// ==========================================================================
// ---- ADD WORKOUT (clone a saved Workout Library training into a day) ----
// Same list + preview + insert UX as Add Section above, and the same clone
// shape athlete-calendar.js's cloneTrainingToDay uses for a real athlete
// day - carries section/superset links and any "Adjust Fields"/Alternative
// Exercise overrides from the Training over, so assigning one that was
// fine-tuned in Workout Builder doesn't silently lose that. Reachable two
// ways: the "+" on an empty grid cell (day-detail modal isn't open yet),
// or the "Add Workout" button inside an already-open day - insertTrainingIntoDay
// below handles both.
// ==========================================================================
let cachedTrainings = null
let selectedTrainingId = null
let selectedTrainingName = null
let currentDayIdForAddTraining = null

async function getTrainingsList() {
  if (cachedTrainings) return cachedTrainings
  const { data, error } = await fetchWithRetry((signal) => supabase.from('trainings').select('*').order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your Workout Library - check your connection and try again'); return null }
  cachedTrainings = data
  return cachedTrainings
}

function resetTrainingPreview() {
  selectedTrainingId = null
  selectedTrainingName = null
  document.getElementById('addTrainingPreview').innerHTML = '<p class="no-metrics">Select a workout to preview it</p>'
  document.getElementById('insertTrainingBtn').disabled = true
}

async function openAddTrainingModal(dayId) {
  currentDayIdForAddTraining = dayId
  resetTrainingPreview()
  const list = document.getElementById('addTrainingList')
  const data = await getTrainingsList()

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

  document.getElementById('addTrainingModal').classList.add('active')
}

async function previewTraining(trainingId, name) {
  selectedTrainingId = trainingId
  selectedTrainingName = name
  document.getElementById('insertTrainingBtn').disabled = false

  const preview = document.getElementById('addTrainingPreview')
  preview.innerHTML = '<p class="no-metrics">Loading...</p>'

  const { data, error } = await supabase
    .from('training_exercises')
    .select('*, exercises!exercise_id(id, name, video_url)')
    .eq('training_id', trainingId)

  if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this workout</p>'; return }

  data.sort((a, b) => a.order_index - b.order_index)
  preview.innerHTML = data.length === 0
    ? '<p class="no-metrics">No exercises in this workout</p>'
    : data.map(renderSectionPreviewExercise).join('')
}

document.getElementById('insertTrainingBtn').addEventListener('click', async function() {
  if (!selectedTrainingId) return
  await insertTrainingIntoDay(selectedTrainingId, selectedTrainingName)
})

document.getElementById('closeAddTrainingBtn').addEventListener('click', function() {
  document.getElementById('addTrainingModal').classList.remove('active')
})

async function insertTrainingIntoDay(trainingId, trainingName) {
  const day = findDay(currentDayIdForAddTraining)
  if (!day) return

  const { data: trainingExercises, error } = await supabase.from('training_exercises').select('*').eq('training_id', trainingId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }
  trainingExercises.sort((a, b) => a.order_index - b.order_index)
  if (trainingExercises.length === 0) { document.getElementById('addTrainingModal').classList.remove('active'); return }

  const baseOrder = day.program_exercises.length ? Math.max(...day.program_exercises.map(pe => pe.order_index)) + 1 : 0

  // Fresh id per distinct superset/section-instance value in this batch,
  // same reasoning as insertSectionIntoDay above - so dropping the same
  // Workout onto two different days never makes them look linked
  const groupIdMap = {}
  const sectionInstanceMap = {}
  for (const te of trainingExercises) {
    if (te.superset_group_id && !groupIdMap[te.superset_group_id]) groupIdMap[te.superset_group_id] = crypto.randomUUID()
    if (te.section_instance_id && !sectionInstanceMap[te.section_instance_id]) sectionInstanceMap[te.section_instance_id] = crypto.randomUUID()
  }

  const { data: inserted, error: insertError } = await supabase.from('program_exercises').insert(
    trainingExercises.map((te, i) => ({
      day_id: day.id, exercise_id: te.exercise_id, order_index: baseOrder + i,
      prescribed_sets: te.prescribed_sets, prescribed_reps: te.prescribed_reps,
      prescribed_weight: te.prescribed_weight, rest_seconds: te.rest_seconds,
      extra_fields: te.extra_fields, set_targets: te.set_targets, notes: te.notes,
      section_label: te.section_label,
      section_instance_id: te.section_instance_id ? sectionInstanceMap[te.section_instance_id] : null,
      superset_group_id: te.superset_group_id ? groupIdMap[te.superset_group_id] : null,
      tracks_weight_override: te.tracks_weight_override,
      is_timed_override: te.is_timed_override,
      is_unilateral_override: te.is_unilateral_override,
      tracks_distance_override: te.tracks_distance_override,
      alternative_exercise_id: te.alternative_exercise_id
    }))
  ).select('*, exercises!exercise_id(id, name, category, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
  if (insertError) { console.log(insertError); customAlert('Something went wrong copying the exercises'); return }

  day.program_exercises.push(...inserted)

  // A still-unlabeled day gets the workout's name stamped on as its label,
  // so the grid cell shows something meaningful without the coach having
  // to rename it themselves - never overwrites a label they already set
  if (!day.label) {
    const { error: labelError } = await supabase.from('program_days').update({ label: trainingName }).eq('id', day.id)
    if (!labelError) day.label = trainingName
  }

  // Same "only if not already set" reasoning as the label above - a day
  // that already has a type (e.g. the coach changed it, or a second
  // Workout was already dropped on) keeps whatever it has
  if (!day.workout_type) {
    const training = (cachedTrainings || []).find(t => t.id === trainingId)
    const workoutType = training ? training.workout_type : null
    if (workoutType) {
      const { error: typeError } = await supabase.from('program_days').update({ workout_type: workoutType }).eq('id', day.id)
      if (!typeError) day.workout_type = workoutType
    }
  }

  document.getElementById('addTrainingModal').classList.remove('active')

  if (currentModalDayId === day.id) {
    await flushAllPendingSaves(document.getElementById('weeksList'))
    refreshProgramDayModalBody()
  } else {
    refreshDayCellFor(day.id)
  }
}

// ==========================================================================
// ---- COPY A DAY'S EXERCISES ONTO ANOTHER DAY (⋮ menu on a grid cell,
// and "Copy full week" below) ----
// Appends sourceDay's exercises onto targetDay - never overwrites, always
// appends after whatever's already there (same order_index-offset +
// superset/section id remap as insertTrainingIntoDay above), so copying can
// never destroy existing work already on the target day.
// ==========================================================================
async function cloneProgramDayExercises(sourceDay, targetDay) {
  const { data: sourceExercises, error } = await supabase.from('program_exercises').select('*').eq('day_id', sourceDay.id)
  if (error) { console.log(error); customAlert('Something went wrong'); return }
  sourceExercises.sort((a, b) => a.order_index - b.order_index)
  if (sourceExercises.length === 0) return

  const baseOrder = targetDay.program_exercises.length ? Math.max(...targetDay.program_exercises.map(pe => pe.order_index)) + 1 : 0
  const groupIdMap = {}
  const sectionInstanceMap = {}
  for (const pe of sourceExercises) {
    if (pe.superset_group_id && !groupIdMap[pe.superset_group_id]) groupIdMap[pe.superset_group_id] = crypto.randomUUID()
    if (pe.section_instance_id && !sectionInstanceMap[pe.section_instance_id]) sectionInstanceMap[pe.section_instance_id] = crypto.randomUUID()
  }

  const { data: inserted, error: insertError } = await supabase.from('program_exercises').insert(
    sourceExercises.map((pe, i) => ({
      day_id: targetDay.id, exercise_id: pe.exercise_id, order_index: baseOrder + i,
      prescribed_sets: pe.prescribed_sets, prescribed_reps: pe.prescribed_reps, prescribed_weight: pe.prescribed_weight,
      rest_seconds: pe.rest_seconds, extra_fields: pe.extra_fields, set_targets: pe.set_targets, notes: pe.notes,
      section_label: pe.section_label,
      section_instance_id: pe.section_instance_id ? sectionInstanceMap[pe.section_instance_id] : null,
      superset_group_id: pe.superset_group_id ? groupIdMap[pe.superset_group_id] : null,
      tracks_weight_override: pe.tracks_weight_override,
      is_timed_override: pe.is_timed_override,
      is_unilateral_override: pe.is_unilateral_override,
      tracks_distance_override: pe.tracks_distance_override,
      alternative_exercise_id: pe.alternative_exercise_id
    }))
  ).select('*, exercises!exercise_id(id, name, category, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
  if (insertError) { console.log(insertError); customAlert('Something went wrong copying the exercises'); return }
  targetDay.program_exercises.push(...inserted)

  if (!targetDay.label && sourceDay.label) {
    const { error: labelError } = await supabase.from('program_days').update({ label: sourceDay.label }).eq('id', targetDay.id)
    if (!labelError) targetDay.label = sourceDay.label
  }

  if (!targetDay.workout_type && sourceDay.workout_type) {
    const { error: typeError } = await supabase.from('program_days').update({ workout_type: sourceDay.workout_type }).eq('id', targetDay.id)
    if (!typeError) targetDay.workout_type = sourceDay.workout_type
  }
}

let copyDaySourceId = null

function openCopyProgramDayModal(dayId) {
  copyDaySourceId = dayId
  const weekSelect = document.getElementById('copyDayWeekSelect')
  weekSelect.innerHTML = weeksCache.map(w => `<option value="${w.id}">Week ${w.week_number}</option>`).join('')
  document.getElementById('copyDayDaySelect').value = '1'
  document.getElementById('copyProgramDayModal').classList.add('active')
}

document.getElementById('cancelCopyProgramDayBtn').addEventListener('click', function() {
  document.getElementById('copyProgramDayModal').classList.remove('active')
})

document.getElementById('saveCopyProgramDayBtn').addEventListener('click', async function() {
  const sourceDay = findDay(copyDaySourceId)
  if (!sourceDay) return
  const targetWeekId = document.getElementById('copyDayWeekSelect').value
  const targetDayNumber = parseInt(document.getElementById('copyDayDaySelect').value)

  const btn = this
  btn.disabled = true
  btn.textContent = 'Copying...'
  const targetDay = await findOrCreateProgramDay(targetWeekId, targetDayNumber)
  if (targetDay) await cloneProgramDayExercises(sourceDay, targetDay)
  btn.disabled = false
  btn.textContent = 'Copy'

  document.getElementById('copyProgramDayModal').classList.remove('active')
  renderWeekNav()
})

// ==========================================================================
// ---- COPY A FULL WEEK ----
// ==========================================================================
let copyWeekSourceId = null

function openCopyWeekModal(weekId) {
  copyWeekSourceId = weekId
  const otherWeeks = weeksCache.filter(w => w.id !== weekId)
  const select = document.getElementById('copyWeekTarget')
  const emptyMsg = document.getElementById('copyWeekEmptyMsg')
  const saveBtn = document.getElementById('saveCopyWeekBtn')

  if (otherWeeks.length === 0) {
    select.style.display = 'none'
    emptyMsg.style.display = 'block'
    saveBtn.disabled = true
  } else {
    select.style.display = ''
    emptyMsg.style.display = 'none'
    saveBtn.disabled = false
    select.innerHTML = otherWeeks.map(w => `<option value="${w.id}">Week ${w.week_number}</option>`).join('')
  }

  document.getElementById('copyWeekModal').classList.add('active')
}

document.getElementById('cancelCopyWeekBtn').addEventListener('click', function() {
  document.getElementById('copyWeekModal').classList.remove('active')
})

document.getElementById('saveCopyWeekBtn').addEventListener('click', async function() {
  const targetWeekId = document.getElementById('copyWeekTarget').value
  if (!targetWeekId) return
  const sourceWeek = findWeek(copyWeekSourceId)
  const targetWeek = findWeek(targetWeekId)
  if (!sourceWeek || !targetWeek) return

  const btn = this
  btn.disabled = true
  btn.textContent = 'Copying...'
  for (let dayNumber = 1; dayNumber <= 7; dayNumber++) {
    const sourceDay = sourceWeek.program_days.find(d => d.day_number === dayNumber)
    if (!sourceDay || (!sourceDay.label && sourceDay.program_exercises.length === 0)) continue
    const targetDay = await findOrCreateProgramDay(targetWeek.id, dayNumber)
    if (targetDay) await cloneProgramDayExercises(sourceDay, targetDay)
  }
  btn.disabled = false
  btn.textContent = 'Copy'

  document.getElementById('copyWeekModal').classList.remove('active')
  renderWeekNav()
})

// ==========================================================================
// ---- RENAME TEMPLATE ----
// ==========================================================================
document.getElementById('renameProgramBtn').addEventListener('click', function() {
  document.getElementById('renameProgramInput').value = document.getElementById('programNameHeading').textContent
  document.getElementById('renameProgramModal').classList.add('active')
})

document.getElementById('cancelRenameProgramBtn').addEventListener('click', function() {
  document.getElementById('renameProgramModal').classList.remove('active')
})

document.getElementById('saveRenameProgramBtn').addEventListener('click', async function() {
  const name = document.getElementById('renameProgramInput').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const { error } = await supabase.from('programs').update({ name }).eq('id', programId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  document.getElementById('programNameHeading').textContent = name
  document.getElementById('renameProgramModal').classList.remove('active')
})
