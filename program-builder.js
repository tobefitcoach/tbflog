// ==========================================================================
// PROGRAM BUILDER
// Edits one template's Weeks -> Days -> Exercises. A template has no real
// dates yet - day_number just means "the Nth day of that week, once this
// gets assigned to an athlete with a start date" (see athlete-calendar.js
// for the date math that uses this). The coach's own label field is what
// actually describes a day ("Day 1 — Upper Body").
// ==========================================================================
import { supabase } from './coachClient.js'

const params = new URLSearchParams(window.location.search)
const programId = params.get('id')

let allExercises = []
let weeksCache = [] // last-loaded weeks (with nested days/exercises), used to compute next week/day/order numbers without extra queries
let currentWeekIdForAddDay = null
let currentDayIdForAddExercise = null
let currentEditPE = null // the program_exercises row currently open in the edit modal

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
  updatePickerFieldsForType()
}

// Timed exercises store their duration in the same prescribed_reps text
// column reps normally uses ("45 sec", "2 min") - these two helpers convert
// between that stored string and the separate value+unit inputs in the UI
function formatDuration(value, unit) {
  if (!value) return null
  return `${value} ${unit}`
}

function parseDuration(text) {
  if (!text) return { value: '', unit: 'sec' }
  const match = String(text).match(/^(\d+(?:\.\d+)?)\s*(sec|min)/i)
  if (match) return { value: match[1], unit: match[2].toLowerCase() }
  return { value: text, unit: 'sec' }
}

// "Timed" exercises show Sets + Duration (value + unit) and hide Weight;
// "weights" (and any custom type) show Sets + Reps + Weight - matches
// whichever exercise is currently selected in the picker
function updatePickerFieldsForType() {
  const exerciseId = document.getElementById('pickerExerciseSelect').value
  const exercise = allExercises.find(ex => ex.id === exerciseId)
  const isTimed = exercise && exercise.type === 'timed'

  document.getElementById('pickerRepsGroup').style.display = isTimed ? 'none' : 'block'
  document.getElementById('pickerDurationGroup').style.display = isTimed ? 'block' : 'none'
  document.getElementById('pickerWeightGroup').style.display = isTimed ? 'none' : 'block'
}

document.getElementById('pickerExerciseSelect').addEventListener('change', updatePickerFieldsForType)

// ==========================================================================
// ---- EXTRA FIELDS (name/value pairs, e.g. "% of 1RM": "75", "RPE": "8") ---
// ==========================================================================
function addExtraFieldRow(containerId, name, value) {
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

document.getElementById('pickerAddFieldBtn').addEventListener('click', function() {
  addExtraFieldRow('pickerExtraFields')
})

document.getElementById('editAddFieldBtn').addEventListener('click', function() {
  addExtraFieldRow('editExtraFields')
})

// ==========================================================================
// ---- LOAD + RENDER WEEKS / DAYS / EXERCISES ----
// One nested query pulls the whole tree; sorted client-side since the
// dataset per template is always small.
// ==========================================================================
async function loadWeeks() {
  const { data, error } = await supabase
    .from('program_weeks')
    .select('*, program_days(*, program_exercises(*, exercises(id, name, category, type)))')
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
        : `<ul class="detail-list">${day.program_exercises.map(renderExerciseRow).join('')}</ul>`}
    </div>
  `
}

function renderExerciseRow(pe) {
  const isTimed = pe.exercises && pe.exercises.type === 'timed'
  const parts = []
  if (pe.prescribed_sets) parts.push(`${pe.prescribed_sets} sets`)
  if (pe.prescribed_reps) parts.push(isTimed ? pe.prescribed_reps : `${pe.prescribed_reps} reps`)
  if (pe.prescribed_weight) parts.push(`${pe.prescribed_weight}kg`)
  if (pe.extra_fields) {
    for (const [k, v] of Object.entries(pe.extra_fields)) parts.push(`${k}: ${v}`)
  }
  const summary = parts.join(' × ')

  return `
    <li class="detail-row">
      <span>${pe.exercises ? pe.exercises.name : 'Unknown exercise'}${summary ? ' — ' + summary : ''}${pe.notes ? ' (' + pe.notes + ')' : ''}</span>
      <span style="display:flex; gap:8px">
        <button class="btn-edit-entry" data-action="edit-exercise" data-pe-id="${pe.id}">✏</button>
        <button class="btn-delete-measurement" data-action="delete-exercise" data-pe-id="${pe.id}">🗑</button>
      </span>
    </li>
  `
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
document.getElementById('weeksList').addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action

  if (action === 'add-day') openAddDayModal(btn.dataset.weekId)
  else if (action === 'delete-week') deleteWeek(btn.dataset.weekId)
  else if (action === 'add-exercise') openExercisePickerModal(btn.dataset.dayId)
  else if (action === 'delete-day') deleteDay(btn.dataset.dayId)
  else if (action === 'edit-exercise') openEditExerciseModal(btn.dataset.peId)
  else if (action === 'delete-exercise') deleteExerciseRow(btn.dataset.peId)
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
// ==========================================================================
function openExercisePickerModal(dayId) {
  currentDayIdForAddExercise = dayId
  populateExerciseSelect()
  document.getElementById('pickerSets').value = ''
  document.getElementById('pickerReps').value = ''
  document.getElementById('pickerDurationValue').value = ''
  document.getElementById('pickerDurationUnit').value = 'sec'
  document.getElementById('pickerWeight').value = ''
  document.getElementById('pickerNotes').value = ''
  document.getElementById('pickerExtraFields').innerHTML = ''
  document.getElementById('exercisePickerModal').classList.add('active')
}

document.getElementById('cancelExercisePickerBtn').addEventListener('click', function() {
  document.getElementById('exercisePickerModal').classList.remove('active')
})

document.getElementById('saveExercisePickerBtn').addEventListener('click', async function() {
  const exerciseId = document.getElementById('pickerExerciseSelect').value
  if (!exerciseId) { alert('Please choose an exercise'); return }

  const exercise = allExercises.find(ex => ex.id === exerciseId)
  const isTimed = exercise && exercise.type === 'timed'

  const sets = document.getElementById('pickerSets').value ? parseInt(document.getElementById('pickerSets').value) : null
  // Timed exercises store their duration (value + unit) in the same
  // prescribed_reps column reps normally uses, and never store a weight
  const reps = isTimed
    ? formatDuration(document.getElementById('pickerDurationValue').value, document.getElementById('pickerDurationUnit').value)
    : (document.getElementById('pickerReps').value.trim() || null)
  const weight = isTimed ? null : (document.getElementById('pickerWeight').value ? parseFloat(document.getElementById('pickerWeight').value) : null)
  const notes = document.getElementById('pickerNotes').value.trim() || null
  const extraFields = collectExtraFields('pickerExtraFields')

  const day = findDay(currentDayIdForAddExercise)
  const nextOrder = day.program_exercises.length ? Math.max(...day.program_exercises.map(pe => pe.order_index)) + 1 : 0

  const { error } = await supabase.from('program_exercises').insert([{
    day_id: currentDayIdForAddExercise,
    exercise_id: exerciseId,
    order_index: nextOrder,
    prescribed_sets: sets,
    prescribed_reps: reps,
    prescribed_weight: weight,
    extra_fields: extraFields,
    notes
  }])

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('exercisePickerModal').classList.remove('active')
  loadWeeks()
})

// ---- Create New Exercise, inline (opens on top of the picker) ----
function populateCreateCategorySelect() {
  const select = document.getElementById('createExerciseCategory')
  const categories = [...new Set(allExercises.map(ex => ex.category).filter(c => c && c.trim()))].sort()
  select.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'
  select.value = '__new__'
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
// ---- EDIT / DELETE A SCHEDULED EXERCISE ----
// Only prescribed sets/reps/weight/notes are editable - swapping which
// exercise a row points to isn't supported inline, delete + re-add covers it
// ==========================================================================
function openEditExerciseModal(peId) {
  currentEditPE = findPE(peId)
  if (!currentEditPE) return

  const isTimed = currentEditPE.exercises && currentEditPE.exercises.type === 'timed'
  const duration = parseDuration(currentEditPE.prescribed_reps)

  document.getElementById('editExerciseTitle').textContent =
    'Edit ' + (currentEditPE.exercises ? currentEditPE.exercises.name : 'Exercise')
  document.getElementById('editSets').value = currentEditPE.prescribed_sets || ''
  document.getElementById('editReps').value = isTimed ? '' : (currentEditPE.prescribed_reps || '')
  document.getElementById('editDurationValue').value = isTimed ? duration.value : ''
  document.getElementById('editDurationUnit').value = isTimed ? duration.unit : 'sec'
  document.getElementById('editWeight').value = currentEditPE.prescribed_weight || ''
  document.getElementById('editNotes').value = currentEditPE.notes || ''
  document.getElementById('editRepsGroup').style.display = isTimed ? 'none' : 'block'
  document.getElementById('editDurationGroup').style.display = isTimed ? 'block' : 'none'
  document.getElementById('editWeightGroup').style.display = isTimed ? 'none' : 'block'

  document.getElementById('editExtraFields').innerHTML = ''
  if (currentEditPE.extra_fields) {
    for (const [k, v] of Object.entries(currentEditPE.extra_fields)) addExtraFieldRow('editExtraFields', k, v)
  }

  document.getElementById('editExerciseModal').classList.add('active')
}

document.getElementById('cancelEditExerciseBtn').addEventListener('click', function() {
  document.getElementById('editExerciseModal').classList.remove('active')
})

document.getElementById('saveEditExerciseBtn').addEventListener('click', async function() {
  const isTimed = currentEditPE.exercises && currentEditPE.exercises.type === 'timed'

  const sets = document.getElementById('editSets').value ? parseInt(document.getElementById('editSets').value) : null
  const reps = isTimed
    ? formatDuration(document.getElementById('editDurationValue').value, document.getElementById('editDurationUnit').value)
    : (document.getElementById('editReps').value.trim() || null)
  const weight = isTimed ? null : (document.getElementById('editWeight').value ? parseFloat(document.getElementById('editWeight').value) : null)
  const notes = document.getElementById('editNotes').value.trim() || null
  const extraFields = collectExtraFields('editExtraFields')

  const { error } = await supabase
    .from('program_exercises')
    .update({ prescribed_sets: sets, prescribed_reps: reps, prescribed_weight: weight, extra_fields: extraFields, notes })
    .eq('id', currentEditPE.id)

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('editExerciseModal').classList.remove('active')
  loadWeeks()
})

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
