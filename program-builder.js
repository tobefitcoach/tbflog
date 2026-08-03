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
let currentWeekIdForAddDay = null
let currentDayIdForAddExercise = null

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadProgram()
  loadWeeks()
  loadAllExercises()
}

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'login.html'
})

// ==========================================================================
// ---- LOAD PROGRAM NAME ----
// ==========================================================================
async function loadProgram() {
  const { data, error } = await supabase
    .from('programs')
    .select('*')
    .eq('id', programId)
    .single()

  if (error) {
    console.log('Error loading program:', error)
    document.getElementById('programNameHeading').textContent = 'Program not found'
    return
  }

  document.getElementById('programNameHeading').textContent = data.name
}

// ==========================================================================
// ---- EXERCISE LIBRARY CACHE (for the "Add Exercise" picker dropdown) ----
// ==========================================================================
async function loadAllExercises() {
  const { data, error } = await supabase.from('exercises').select('*').order('name')
  if (error) { console.log('Error loading exercises:', error); return }
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

// rest_seconds is stored as a plain int (a rest timer counts down from a
// number, not a parsed string) - these convert to/from the value+unit inputs
function restToSeconds(value, unit) {
  if (!value) return null
  return Math.round(parseFloat(value) * (unit === 'min' ? 60 : 1))
}

function secondsToRest(seconds) {
  if (!seconds) return { value: '', unit: 'sec' }
  if (seconds >= 60 && seconds % 60 === 0) return { value: seconds / 60, unit: 'min' }
  return { value: seconds, unit: 'sec' }
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
// A program_exercises row keeps one set_targets array ([{reps, weight}, ...],
// index 0 = Set 1) so each set can have its own target (a pyramid: 12/10/8
// reps at increasing weight) instead of one shared value for every set.
// prescribed_sets/prescribed_reps/prescribed_weight are kept in sync with it
// on every save (length / first set's values) purely so every other place
// in the app that only reads those old columns keeps working untouched.
// ==========================================================================
function deriveSetTargets(row) {
  if (row.set_targets && row.set_targets.length) return row.set_targets
  const count = row.prescribed_sets || 1
  return Array.from({ length: count }, () => ({ reps: row.prescribed_reps || null, weight: row.prescribed_weight || null }))
}

function renderSetTargetRow(setNumber, target, isTimed, onlyRow) {
  return `
    <div class="set-target-row" data-set-number="${setNumber}">
      <span class="set-label">Set ${setNumber}</span>
      <input type="text" class="set-reps-input" value="${target.reps || ''}" placeholder="${isTimed ? 'e.g. 45 sec' : 'reps'}">
      ${isTimed ? '' : `<input type="number" class="set-weight-input" value="${target.weight != null ? target.weight : ''}" placeholder="kg" step="0.5">`}
      <button type="button" class="set-remove-btn" data-action="remove-set" ${onlyRow ? 'disabled' : ''}>✕</button>
    </div>
  `
}

function addSetTargetRow(rowsEl, isTimed) {
  const rows = [...rowsEl.querySelectorAll('.set-target-row')]
  if (rows.length === 1) rows[0].querySelector('.set-remove-btn').disabled = false
  rowsEl.insertAdjacentHTML('beforeend', renderSetTargetRow(rows.length + 1, { reps: null, weight: null }, isTimed, false))
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
async function loadWeeks() {
  const { data, error } = await supabase
    .from('program_weeks')
    .select('*, program_days(*, program_exercises(*, exercises(id, name, category, type, video_url)))')
    .eq('program_id', programId)

  if (error) { console.log('Error loading weeks:', error); return }

  data.sort((a, b) => a.week_number - b.week_number)
  data.forEach(week => {
    week.program_days.sort((a, b) => a.day_number - b.day_number)
    week.program_days.forEach(day => {
      day.program_exercises.sort((a, b) => a.order_index - b.order_index)
    })
  })

  weeksCache = data
  renderWeeks(weeksCache)
}

function renderWeeks(weeks) {
  const container = document.getElementById('weeksList')

  if (weeks.length === 0) {
    container.innerHTML = '<p class="no-metrics">No weeks yet — click "+ Add Week" to get started</p>'
    return
  }

  container.innerHTML = weeks.map(renderWeekBlock).join('')

  // innerHTML wipes any dynamically-built children, so extra field rows
  // (built with document.createElement, not template strings) get
  // re-populated here for every card, same as the old edit modal did
  for (const week of weeks) {
    for (const day of week.program_days) {
      for (const pe of day.program_exercises) {
        if (pe.extra_fields) {
          for (const [k, v] of Object.entries(pe.extra_fields)) addExtraFieldRow(`extraFields-${pe.id}`, k, v)
        }
      }
    }
  }
}

function renderWeekBlock(week) {
  return `
    <div class="metric-category">
      <div class="metrics-header">
        <h3 class="category-title">Week ${week.week_number}</h3>
        <div style="display:flex; gap:8px">
          <button class="btn-profile-action" data-action="add-day" data-week-id="${week.id}">+ Add Day</button>
          <button class="btn-delete-metric" data-action="delete-week" data-week-id="${week.id}">🗑 Delete Week</button>
        </div>
      </div>
      ${week.program_days.length === 0
        ? '<p class="no-metrics">No days yet</p>'
        : week.program_days.map(renderDayBlock).join('')}
    </div>
  `
}

function renderDayBlock(day) {
  return `
    <div class="exercise-item" style="margin-bottom:16px">
      <div class="metric-item-header">
        <h4>${day.label || ('Day ' + day.day_number)}</h4>
        <div style="display:flex; gap:8px">
          <button class="btn-edit-entry" data-action="add-exercise" data-day-id="${day.id}">+ Add Exercise</button>
          <button class="btn-delete-measurement" data-action="delete-day" data-day-id="${day.id}">🗑 Delete Day</button>
        </div>
      </div>
      ${day.program_exercises.length === 0
        ? '<p class="no-metrics">No exercises yet</p>'
        : day.program_exercises.map(renderExerciseCard).join('')}
    </div>
  `
}

function renderExerciseCard(pe) {
  const isTimed = pe.exercises && pe.exercises.type === 'timed'
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const targets = deriveSetTargets(pe)
  const rest = secondsToRest(pe.rest_seconds)
  const rowsHtml = targets.map((t, i) => renderSetTargetRow(i + 1, t, isTimed, targets.length === 1)).join('')

  return `
    <div class="builder-exercise-card" data-id="${pe.id}">
      <div class="builder-exercise-card-header">
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder">🏋</span>'}
        </button>
        <div class="builder-exercise-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        <button type="button" class="btn-delete-measurement" data-action="delete-exercise" title="Remove from day">🗑</button>
      </div>
      <div class="builder-exercise-rest-row">
        <span>Rest between sets:</span>
        <input type="number" class="rest-value-input" value="${rest.value}" placeholder="e.g. 90">
        <select class="rest-unit-select">
          <option value="sec" ${rest.unit === 'sec' ? 'selected' : ''}>sec</option>
          <option value="min" ${rest.unit === 'min' ? 'selected' : ''}>min</option>
        </select>
      </div>
      <div class="set-target-rows">
        ${rowsHtml}
      </div>
      <button type="button" class="builder-add-set-btn" data-action="add-set">+ Add Set</button>
      <div class="builder-exercise-notes" style="margin-top:16px">
        <label>Extra Fields (optional)</label>
        <div class="extra-fields-container" id="extraFields-${pe.id}"></div>
        <button type="button" class="btn-create-metric" data-action="add-extra-field" style="margin-top:6px">+ Add Field</button>
      </div>
      <div class="builder-exercise-notes">
        <label>Notes (visible to the athlete)</label>
        <input type="text" class="exercise-notes-input" value="${pe.notes || ''}" placeholder="e.g. Focus on controlled tempo">
      </div>
      <div class="builder-exercise-footer">
        <span></span>
        <button type="button" class="btn-save" data-action="save-exercise">💾 Save</button>
      </div>
    </div>
  `
}

async function saveExerciseCard(peId) {
  const card = document.querySelector(`.builder-exercise-card[data-id="${peId}"]`)
  if (!card) return

  const rows = [...card.querySelectorAll('.set-target-row')]
  const setTargets = rows.map(row => {
    const reps = row.querySelector('.set-reps-input').value.trim() || null
    const weightInput = row.querySelector('.set-weight-input')
    const weight = weightInput && weightInput.value ? parseFloat(weightInput.value) : null
    return { reps, weight }
  })

  const restSeconds = restToSeconds(card.querySelector('.rest-value-input').value, card.querySelector('.rest-unit-select').value)
  const notes = card.querySelector('.exercise-notes-input').value.trim() || null
  const extraFields = collectExtraFields(`extraFields-${peId}`)
  const first = setTargets[0] || { reps: null, weight: null }

  const { error } = await supabase
    .from('program_exercises')
    .update({
      set_targets: setTargets,
      prescribed_sets: setTargets.length,
      prescribed_reps: first.reps,
      prescribed_weight: first.weight,
      rest_seconds: restSeconds,
      extra_fields: extraFields,
      notes
    })
    .eq('id', peId)

  if (error) { console.log(error); alert('Something went wrong'); return }
  await loadWeeks()
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

  if (action === 'add-day') openAddDayModal(btn.dataset.weekId)
  else if (action === 'delete-week') deleteWeek(btn.dataset.weekId)
  else if (action === 'add-exercise') openExercisePickerModal(btn.dataset.dayId)
  else if (action === 'delete-day') deleteDay(btn.dataset.dayId)
  else if (action === 'delete-exercise') deleteExerciseRow(btn.closest('.builder-exercise-card').dataset.id)
  else if (action === 'add-set' || action === 'remove-set' || action === 'save-exercise' || action === 'add-extra-field') {
    const card = btn.closest('.builder-exercise-card')
    const peId = card.dataset.id
    const pe = findPE(peId)
    const isTimed = !!(pe && pe.exercises && pe.exercises.type === 'timed')

    if (action === 'add-set') addSetTargetRow(card.querySelector('.set-target-rows'), isTimed)
    else if (action === 'remove-set') removeSetTargetRow(btn.closest('.set-target-row'))
    else if (action === 'save-exercise') await saveExerciseCard(peId)
    else if (action === 'add-extra-field') addExtraFieldRow(`extraFields-${peId}`)
  }
})

// ==========================================================================
// ---- ADD / DELETE WEEK ----
// ==========================================================================
document.getElementById('addWeekBtn').addEventListener('click', async function() {
  const nextNumber = weeksCache.length ? Math.max(...weeksCache.map(w => w.week_number)) + 1 : 1

  const { error } = await supabase
    .from('program_weeks')
    .insert([{ program_id: programId, week_number: nextNumber }])

  if (error) { console.log(error); alert('Something went wrong'); return }
  loadWeeks()
})

async function deleteWeek(weekId) {
  if (!confirm('Delete this week and everything in it?')) return

  const { error } = await supabase.from('program_weeks').delete().eq('id', weekId)
  if (error) { console.log(error); alert('Something went wrong'); return }
  loadWeeks()
}

// ==========================================================================
// ---- ADD / DELETE DAY ----
// ==========================================================================
function openAddDayModal(weekId) {
  currentWeekIdForAddDay = weekId
  document.getElementById('addDayLabel').value = ''
  document.getElementById('addDayModal').classList.add('active')
}

document.getElementById('cancelAddDayBtn').addEventListener('click', function() {
  document.getElementById('addDayModal').classList.remove('active')
})

document.getElementById('saveAddDayBtn').addEventListener('click', async function() {
  const label = document.getElementById('addDayLabel').value.trim()
  const week = weeksCache.find(w => w.id === currentWeekIdForAddDay)
  const nextNumber = week.program_days.length ? Math.max(...week.program_days.map(d => d.day_number)) + 1 : 1

  const { error } = await supabase
    .from('program_days')
    .insert([{ week_id: currentWeekIdForAddDay, day_number: nextNumber, label }])

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('addDayModal').classList.remove('active')
  loadWeeks()
})

async function deleteDay(dayId) {
  if (!confirm('Delete this day and its exercises?')) return

  const { error } = await supabase.from('program_days').delete().eq('id', dayId)
  if (error) { console.log(error); alert('Something went wrong'); return }
  loadWeeks()
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

document.getElementById('saveExercisePickerBtn').addEventListener('click', async function() {
  const exerciseId = document.getElementById('pickerExerciseSelect').value
  if (!exerciseId) { alert('Please choose an exercise'); return }

  const day = findDay(currentDayIdForAddExercise)
  const nextOrder = day.program_exercises.length ? Math.max(...day.program_exercises.map(pe => pe.order_index)) + 1 : 0

  const { error } = await supabase.from('program_exercises').insert([{
    day_id: currentDayIdForAddExercise,
    exercise_id: exerciseId,
    order_index: nextOrder
  }])

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('exercisePickerModal').classList.remove('active')
  loadWeeks()
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
const BUILT_IN_TYPES = { weights: 'Weightlifting (sets, reps, weight)', timed: 'Timed (sets, duration)' }

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

document.getElementById('createExerciseType').addEventListener('change', toggleCreateNewTypeField)

document.getElementById('createNewExerciseBtn').addEventListener('click', function() {
  document.getElementById('createExerciseName').value = ''
  document.getElementById('createExerciseNewCategory').value = ''
  populateCreateCategorySelect()
  document.getElementById('createExerciseNewType').value = ''
  populateCreateTypeSelect()
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

  if (!name) { alert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('exercises')
    .insert([{ coach_id: session.user.id, name, category, type, video_url: videoUrl, instructions }])
    .select()

  if (error) { console.log(error); alert('Something went wrong'); return }

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
async function deleteExerciseRow(peId) {
  if (!confirm('Remove this exercise from the day?')) return

  const { error } = await supabase.from('program_exercises').delete().eq('id', peId)
  if (error) { console.log(error); alert('Something went wrong'); return }
  loadWeeks()
}

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
  if (!name) { alert('Please enter a name'); return }

  const { error } = await supabase.from('programs').update({ name }).eq('id', programId)
  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('programNameHeading').textContent = name
  document.getElementById('renameProgramModal').classList.remove('active')
})
