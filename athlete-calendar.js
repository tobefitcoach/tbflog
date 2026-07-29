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
let allExercisesCache = []
let calendarLoaded = false
let currentDayIdForExercise = null // day being added to, set before opening the exercise picker
let currentDayDateForModal = null // date currently shown in the day-detail modal
let reopenDayModalAfterSave = false // whether saving the exercise picker should reopen the day modal
let currentEditScheduledPE = null

const today = new Date()
let currentViewYear = today.getFullYear()
let currentViewMonth = today.getMonth() // 0-indexed

window.addEventListener('calendar-tab-activated', function() {
  if (calendarLoaded) return
  calendarLoaded = true
  loadAllExercisesForCalendar()
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
  if (entry.program.is_adhoc) return entry.program.name || 'Training'
  return entry.day.label || ('Day ' + entry.day.day_number)
}

// ==========================================================================
// ---- LOAD + RENDER MONTH GRID ----
// ==========================================================================
async function loadCalendarMonth(year, month) {
  document.getElementById('calMonthLabel').textContent = `${MONTH_NAMES[month]} ${year}`

  const { data, error } = await supabase
    .from('programs')
    .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises(name, category, type))))')
    .eq('athlete_id', athleteId)
    .eq('is_template', false)

  if (error) { console.log('Error loading calendar:', error); return }

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

  renderCalendarGrid(year, month)
}

function renderCalendarGrid(year, month) {
  const grid = document.getElementById('calendarGrid')
  const startWeekday = new Date(year, month, 1).getDay() // 0=Sun..6=Sat
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
    // Show the training's own name (ad-hoc) or its day label (assigned
    // template) rather than a generic "N exercises" count - one badge per
    // distinct training, since an ad-hoc add and an assigned program can
    // both land on the same date
    const names = [...new Set(entries.map(trainingDisplayName))]

    const classes = ['calendar-day']
    if (cell.outside) classes.push('calendar-day-outside')
    if (dateStr === todayStr) classes.push('calendar-day-today')

    return `
      <div class="${classes.join(' ')}" data-date="${dateStr}">
        <span class="calendar-day-number">${cell.date.getDate()}</span>
        ${names.map(name => `<span class="calendar-day-badge">${name}</span>`).join('')}
      </div>
    `
  }).join('')

  grid.querySelectorAll('.calendar-day').forEach(cellEl => {
    cellEl.addEventListener('click', function() {
      openDayModal(cellEl.dataset.date)
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
            <button class="btn-delete-metric" ${deleteAction}>🗑 Delete Training</button>
          </div>
          ${exercises.length === 0
            ? '<p class="no-metrics">No exercises</p>'
            : `<ul class="detail-list">${exercises.map(renderScheduledExerciseRow).join('')}</ul>`}
        </div>
      `
    }).join('')
  }

  document.getElementById('dayDetailModal').classList.add('active')
}

function renderScheduledExerciseRow(pe) {
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
        <button class="btn-edit-entry" data-action="edit-scheduled" data-pe-id="${pe.id}">✏</button>
        <button class="btn-delete-measurement" data-action="delete-scheduled" data-pe-id="${pe.id}">🗑</button>
      </span>
    </li>
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

document.getElementById('dayDetailContent').addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]')
  if (!btn) return
  if (btn.dataset.action === 'edit-scheduled') openEditScheduledModal(btn.dataset.peId)
  else if (btn.dataset.action === 'delete-scheduled') deleteScheduledExercise(btn.dataset.peId)
  else if (btn.dataset.action === 'delete-training') deleteTraining(btn.dataset.mode, btn.dataset.programId, btn.dataset.programDayId)
})

// Ad-hoc trainings only ever cover the one day they were created for, so
// deleting the whole `programs` row is exactly "delete this training"
// (cascades its week/day/exercises). An assigned template instance can span
// many weeks, so only that one program_days row is removed - the rest of
// the assigned program stays on the calendar untouched.
async function deleteTraining(mode, programId, programDayId) {
  if (!confirm(mode === 'adhoc'
    ? 'Delete this training?'
    : 'Remove this day from the assigned program? (The rest of the program stays intact.)')) return

  const { error } = mode === 'adhoc'
    ? await supabase.from('programs').delete().eq('id', programId)
    : await supabase.from('program_days').delete().eq('id', programDayId)

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('dayDetailModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

document.getElementById('closeDayDetailBtn').addEventListener('click', function() {
  document.getElementById('dayDetailModal').classList.remove('active')
})

document.getElementById('dayDetailAddExerciseBtn').addEventListener('click', async function() {
  const name = prompt('Name this training:', 'Training')
  if (name === null) return
  const dayId = await findOrCreateAdHocDay(currentDayDateForModal, name.trim() || 'Training')
  document.getElementById('dayDetailModal').classList.remove('active')
  reopenDayModalAfterSave = true
  openCalendarExercisePicker(dayId)
})

// ==========================================================================
// ---- EDIT / DELETE A SCHEDULED EXERCISE ----
// ==========================================================================
function openEditScheduledModal(peId) {
  currentEditScheduledPE = findScheduledPE(peId)
  if (!currentEditScheduledPE) return

  const isTimed = currentEditScheduledPE.exercises && currentEditScheduledPE.exercises.type === 'timed'

  const duration = parseDurationCal(currentEditScheduledPE.prescribed_reps)

  document.getElementById('editScheduledExerciseTitle').textContent =
    'Edit ' + (currentEditScheduledPE.exercises ? currentEditScheduledPE.exercises.name : 'Exercise')
  document.getElementById('editScheduledSets').value = currentEditScheduledPE.prescribed_sets || ''
  document.getElementById('editScheduledReps').value = isTimed ? '' : (currentEditScheduledPE.prescribed_reps || '')
  document.getElementById('editScheduledDurationValue').value = isTimed ? duration.value : ''
  document.getElementById('editScheduledDurationUnit').value = isTimed ? duration.unit : 'sec'
  document.getElementById('editScheduledWeight').value = currentEditScheduledPE.prescribed_weight || ''
  document.getElementById('editScheduledNotes').value = currentEditScheduledPE.notes || ''
  document.getElementById('editScheduledRepsGroup').style.display = isTimed ? 'none' : 'block'
  document.getElementById('editScheduledDurationGroup').style.display = isTimed ? 'block' : 'none'
  document.getElementById('editScheduledWeightGroup').style.display = isTimed ? 'none' : 'block'

  document.getElementById('editScheduledExtraFields').innerHTML = ''
  if (currentEditScheduledPE.extra_fields) {
    for (const [k, v] of Object.entries(currentEditScheduledPE.extra_fields)) addExtraFieldRowCal('editScheduledExtraFields', k, v)
  }

  document.getElementById('editScheduledExerciseModal').classList.add('active')
}

document.getElementById('cancelEditScheduledBtn').addEventListener('click', function() {
  document.getElementById('editScheduledExerciseModal').classList.remove('active')
})

document.getElementById('saveEditScheduledBtn').addEventListener('click', async function() {
  const isTimed = currentEditScheduledPE.exercises && currentEditScheduledPE.exercises.type === 'timed'

  const sets = document.getElementById('editScheduledSets').value ? parseInt(document.getElementById('editScheduledSets').value) : null
  const reps = isTimed
    ? formatDurationCal(document.getElementById('editScheduledDurationValue').value, document.getElementById('editScheduledDurationUnit').value)
    : (document.getElementById('editScheduledReps').value.trim() || null)
  const weight = isTimed ? null : (document.getElementById('editScheduledWeight').value ? parseFloat(document.getElementById('editScheduledWeight').value) : null)
  const notes = document.getElementById('editScheduledNotes').value.trim() || null
  const extraFields = collectExtraFieldsCal('editScheduledExtraFields')

  const { error } = await supabase
    .from('program_exercises')
    .update({ prescribed_sets: sets, prescribed_reps: reps, prescribed_weight: weight, extra_fields: extraFields, notes })
    .eq('id', currentEditScheduledPE.id)

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('editScheduledExerciseModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
  openDayModal(currentDayDateForModal)
})

async function deleteScheduledExercise(peId) {
  if (!confirm('Remove this exercise?')) return

  const { error } = await supabase.from('program_exercises').delete().eq('id', peId)
  if (error) { console.log(error); alert('Something went wrong'); return }

  await loadCalendarMonth(currentViewYear, currentViewMonth)
  openDayModal(currentDayDateForModal)
}

// ==========================================================================
// ---- AD-HOC ADD ("+ Add Training") ----
// findOrCreateAdHocDay reuses the same (is_adhoc=true, start_date=dateStr)
// container for repeated adds to the same date, instead of creating a new
// one each time.
// ==========================================================================
document.getElementById('calAddTrainingBtn').addEventListener('click', function() {
  document.getElementById('adHocNameInput').value = ''
  document.getElementById('adHocDateInput').value = toDateStr(new Date())
  document.getElementById('adHocDateModal').classList.add('active')
})

document.getElementById('cancelAdHocDateBtn').addEventListener('click', function() {
  document.getElementById('adHocDateModal').classList.remove('active')
})

document.getElementById('continueAdHocDateBtn').addEventListener('click', async function() {
  const dateStr = document.getElementById('adHocDateInput').value
  const name = document.getElementById('adHocNameInput').value.trim()
  if (!dateStr) { alert('Please choose a date'); return }

  document.getElementById('adHocDateModal').classList.remove('active')
  const dayId = await findOrCreateAdHocDay(dateStr, name || 'Training')
  currentDayDateForModal = dateStr
  reopenDayModalAfterSave = false
  openCalendarExercisePicker(dayId)
})

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
    .insert([{ coach_id: session.user.id, athlete_id: athleteId, is_template: false, is_adhoc: true, start_date: dateStr, name: name || 'Training' }])
    .select()
  if (programError) { console.log(programError); alert('Something went wrong'); throw programError }

  const { data: newWeek, error: weekError } = await supabase
    .from('program_weeks')
    .insert([{ program_id: newProgram[0].id, week_number: 1 }])
    .select()
  if (weekError) { console.log(weekError); alert('Something went wrong'); throw weekError }

  const { data: newDay, error: dayError } = await supabase
    .from('program_days')
    .insert([{ week_id: newWeek[0].id, day_number: 1 }])
    .select()
  if (dayError) { console.log(dayError); alert('Something went wrong'); throw dayError }

  return newDay[0].id
}

// ==========================================================================
// ---- EXERCISE PICKER (shared by ad-hoc add and "+ Add Exercise" in the
// day modal) - same pick-existing-or-create-new pattern as
// program-builder.js, duplicated rather than shared (see the plan: nothing
// gets factored out until it's copy-pasted a third time)
// ==========================================================================
async function loadAllExercisesForCalendar() {
  const { data, error } = await supabase.from('exercises').select('*').order('name')
  if (error) { console.log(error); return }
  allExercisesCache = data
  populateCalExerciseSelect()
}

function populateCalExerciseSelect(selectedId) {
  const select = document.getElementById('calPickerExerciseSelect')
  select.innerHTML = '<option value="">Choose an exercise...</option>' +
    allExercisesCache.map(ex => `<option value="${ex.id}">${ex.name}</option>`).join('')
  if (selectedId) select.value = selectedId
  updateCalPickerFieldsForType()
}

// Timed exercises store their duration in the same prescribed_reps text
// column reps normally uses ("45 sec", "2 min") - these two helpers convert
// between that stored string and the separate value+unit inputs in the UI
function formatDurationCal(value, unit) {
  if (!value) return null
  return `${value} ${unit}`
}

function parseDurationCal(text) {
  if (!text) return { value: '', unit: 'sec' }
  const match = String(text).match(/^(\d+(?:\.\d+)?)\s*(sec|min)/i)
  if (match) return { value: match[1], unit: match[2].toLowerCase() }
  return { value: text, unit: 'sec' }
}

// "Timed" exercises show Sets + Duration and hide Weight; "weights" (and
// any custom type) show Sets + Reps + Weight
function updateCalPickerFieldsForType() {
  const exerciseId = document.getElementById('calPickerExerciseSelect').value
  const exercise = allExercisesCache.find(ex => ex.id === exerciseId)
  const isTimed = exercise && exercise.type === 'timed'

  document.getElementById('calPickerRepsGroup').style.display = isTimed ? 'none' : 'block'
  document.getElementById('calPickerDurationGroup').style.display = isTimed ? 'block' : 'none'
  document.getElementById('calPickerWeightGroup').style.display = isTimed ? 'none' : 'block'
}

document.getElementById('calPickerExerciseSelect').addEventListener('change', updateCalPickerFieldsForType)

// ==========================================================================
// ---- EXTRA FIELDS (name/value pairs, e.g. "% of 1RM": "75", "RPE": "8") ---
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

document.getElementById('calPickerAddFieldBtn').addEventListener('click', function() {
  addExtraFieldRowCal('calPickerExtraFields')
})

document.getElementById('editScheduledAddFieldBtn').addEventListener('click', function() {
  addExtraFieldRowCal('editScheduledExtraFields')
})

function openCalendarExercisePicker(dayId) {
  currentDayIdForExercise = dayId
  populateCalExerciseSelect()
  document.getElementById('calPickerSets').value = ''
  document.getElementById('calPickerReps').value = ''
  document.getElementById('calPickerDurationValue').value = ''
  document.getElementById('calPickerDurationUnit').value = 'sec'
  document.getElementById('calPickerWeight').value = ''
  document.getElementById('calPickerNotes').value = ''
  document.getElementById('calPickerExtraFields').innerHTML = ''
  document.getElementById('calendarExercisePickerModal').classList.add('active')
}

document.getElementById('cancelCalExercisePickerBtn').addEventListener('click', function() {
  document.getElementById('calendarExercisePickerModal').classList.remove('active')
})

document.getElementById('saveCalExercisePickerBtn').addEventListener('click', async function() {
  const exerciseId = document.getElementById('calPickerExerciseSelect').value
  if (!exerciseId) { alert('Please choose an exercise'); return }

  const exercise = allExercisesCache.find(ex => ex.id === exerciseId)
  const isTimed = exercise && exercise.type === 'timed'

  const sets = document.getElementById('calPickerSets').value ? parseInt(document.getElementById('calPickerSets').value) : null
  const reps = isTimed
    ? formatDurationCal(document.getElementById('calPickerDurationValue').value, document.getElementById('calPickerDurationUnit').value)
    : (document.getElementById('calPickerReps').value.trim() || null)
  const weight = isTimed ? null : (document.getElementById('calPickerWeight').value ? parseFloat(document.getElementById('calPickerWeight').value) : null)
  const notes = document.getElementById('calPickerNotes').value.trim() || null
  const extraFields = collectExtraFieldsCal('calPickerExtraFields')

  const { data: existingPEs } = await supabase
    .from('program_exercises')
    .select('order_index')
    .eq('day_id', currentDayIdForExercise)

  const nextOrder = existingPEs && existingPEs.length ? Math.max(...existingPEs.map(pe => pe.order_index)) + 1 : 0

  const { error } = await supabase.from('program_exercises').insert([{
    day_id: currentDayIdForExercise,
    exercise_id: exerciseId,
    order_index: nextOrder,
    prescribed_sets: sets,
    prescribed_reps: reps,
    prescribed_weight: weight,
    extra_fields: extraFields,
    notes
  }])

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('calendarExercisePickerModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
  if (reopenDayModalAfterSave) openDayModal(currentDayDateForModal)
})

function populateCalCreateCategorySelect() {
  const select = document.getElementById('calCreateExerciseCategory')
  const categories = [...new Set(allExercisesCache.map(ex => ex.category).filter(c => c && c.trim()))].sort()
  select.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'
  select.value = '__new__'
  toggleCalCreateNewCategoryField()
}

function toggleCalCreateNewCategoryField() {
  const isNew = document.getElementById('calCreateExerciseCategory').value === '__new__'
  document.getElementById('calCreateExerciseNewCategoryGroup').style.display = isNew ? 'block' : 'none'
}

document.getElementById('calCreateExerciseCategory').addEventListener('change', toggleCalCreateNewCategoryField)

// Type dropdown: same extensible pattern as Category
const CAL_BUILT_IN_TYPES = { weights: 'Weightlifting (sets, reps, weight)', timed: 'Timed (sets, duration)' }

function populateCalCreateTypeSelect() {
  const select = document.getElementById('calCreateExerciseType')
  const customTypes = [...new Set(allExercisesCache.map(ex => ex.type).filter(t => t && !(t in CAL_BUILT_IN_TYPES)))].sort()
  select.innerHTML =
    Object.entries(CAL_BUILT_IN_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('') +
    customTypes.map(t => `<option value="${t}">${t}</option>`).join('') +
    '<option value="__new__">+ Add New Type</option>'
  select.value = 'weights'
  toggleCalCreateNewTypeField()
}

function toggleCalCreateNewTypeField() {
  const isNew = document.getElementById('calCreateExerciseType').value === '__new__'
  document.getElementById('calCreateExerciseNewTypeGroup').style.display = isNew ? 'block' : 'none'
}

document.getElementById('calCreateExerciseType').addEventListener('change', toggleCalCreateNewTypeField)

document.getElementById('calCreateNewExerciseBtn').addEventListener('click', function() {
  document.getElementById('calCreateExerciseName').value = ''
  document.getElementById('calCreateExerciseNewCategory').value = ''
  populateCalCreateCategorySelect()
  document.getElementById('calCreateExerciseNewType').value = ''
  populateCalCreateTypeSelect()
  document.getElementById('calCreateExerciseVideoUrl').value = ''
  document.getElementById('calCreateExerciseInstructions').value = ''
  document.getElementById('calCreateExerciseModal').classList.add('active')
})

document.getElementById('cancelCalCreateExerciseBtn').addEventListener('click', function() {
  document.getElementById('calCreateExerciseModal').classList.remove('active')
})

document.getElementById('saveCalCreateExerciseBtn').addEventListener('click', async function() {
  const name = document.getElementById('calCreateExerciseName').value.trim()
  const categorySelect = document.getElementById('calCreateExerciseCategory').value
  const category = categorySelect === '__new__'
    ? document.getElementById('calCreateExerciseNewCategory').value.trim()
    : categorySelect
  const typeSelect = document.getElementById('calCreateExerciseType').value
  const type = typeSelect === '__new__'
    ? document.getElementById('calCreateExerciseNewType').value.trim() || 'weights'
    : typeSelect
  const videoUrl = document.getElementById('calCreateExerciseVideoUrl').value.trim()
  const instructions = document.getElementById('calCreateExerciseInstructions').value.trim()
  if (!name) { alert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('exercises')
    .insert([{ coach_id: session.user.id, name, category, type, video_url: videoUrl, instructions }])
    .select()

  if (error) { console.log(error); alert('Something went wrong'); return }

  allExercisesCache.push(data[0])
  allExercisesCache.sort((a, b) => a.name.localeCompare(b.name))
  populateCalExerciseSelect(data[0].id)
  document.getElementById('calCreateExerciseModal').classList.remove('active')
})

// ==========================================================================
// ---- ASSIGN PROGRAM ----
// Clones a template's full weeks/days/exercises tree into a brand new set
// of rows owned by this athlete - a real copy, not a live link, so editing
// the template later never changes an already-assigned athlete's calendar.
// ==========================================================================
document.getElementById('calAssignProgramBtn').addEventListener('click', async function() {
  const { data, error } = await supabase.from('programs').select('*').eq('is_template', true).order('name')
  if (error) { console.log(error); return }

  const select = document.getElementById('assignTemplateSelect')
  select.innerHTML = '<option value="">Choose a template...</option>' +
    data.map(t => `<option value="${t.id}">${t.name}</option>`).join('')

  document.getElementById('assignStartDate').value = toDateStr(new Date())
  document.getElementById('assignProgramModal').classList.add('active')
})

document.getElementById('cancelAssignProgramBtn').addEventListener('click', function() {
  document.getElementById('assignProgramModal').classList.remove('active')
})

document.getElementById('saveAssignProgramBtn').addEventListener('click', async function() {
  const templateId = document.getElementById('assignTemplateSelect').value
  const startDate = document.getElementById('assignStartDate').value
  if (!templateId) { alert('Please choose a template'); return }
  if (!startDate) { alert('Please choose a start date'); return }

  const saveBtn = document.getElementById('saveAssignProgramBtn')
  saveBtn.disabled = true
  saveBtn.textContent = 'Cloning...'

  try {
    await cloneTemplateToAthlete(templateId, startDate)
    document.getElementById('assignProgramModal').classList.remove('active')
    await loadCalendarMonth(currentViewYear, currentViewMonth)
  } catch (err) {
    console.log(err)
    alert('Something went wrong while assigning the program. Check Supabase for a partially-created program under this athlete and delete it before retrying.')
  } finally {
    saveBtn.disabled = false
    saveBtn.textContent = 'Assign'
  }
})

// Not wrapped in a database transaction - a failure partway through leaves
// a partial clone. Since programs -> program_weeks -> program_days ->
// program_exercises all cascade-delete, recovery is just deleting that one
// programs row and retrying.
async function cloneTemplateToAthlete(templateId, startDate) {
  const { data: template, error: templateError } = await supabase
    .from('programs')
    .select('*')
    .eq('id', templateId)
    .single()
  if (templateError) throw templateError

  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{
      coach_id: session.user.id,
      athlete_id: athleteId,
      is_template: false,
      is_adhoc: false,
      name: template.name,
      start_date: startDate
    }])
    .select()
  if (programError) throw programError
  const newProgramId = newProgram[0].id

  const { data: weeks, error: weeksError } = await supabase
    .from('program_weeks')
    .select('*, program_days(*, program_exercises(*))')
    .eq('program_id', templateId)
  if (weeksError) throw weeksError

  weeks.sort((a, b) => a.week_number - b.week_number)

  for (const week of weeks) {
    const { data: newWeek, error: weekError } = await supabase
      .from('program_weeks')
      .insert([{ program_id: newProgramId, week_number: week.week_number }])
      .select()
    if (weekError) throw weekError
    const newWeekId = newWeek[0].id

    const days = [...week.program_days].sort((a, b) => a.day_number - b.day_number)

    for (const day of days) {
      const { data: newDay, error: dayError } = await supabase
        .from('program_days')
        .insert([{ week_id: newWeekId, day_number: day.day_number, label: day.label }])
        .select()
      if (dayError) throw dayError
      const newDayId = newDay[0].id

      const exercisesInDay = [...day.program_exercises].sort((a, b) => a.order_index - b.order_index)

      for (const pe of exercisesInDay) {
        const { error: peError } = await supabase.from('program_exercises').insert([{
          day_id: newDayId,
          exercise_id: pe.exercise_id,
          order_index: pe.order_index,
          prescribed_sets: pe.prescribed_sets,
          prescribed_reps: pe.prescribed_reps,
          prescribed_weight: pe.prescribed_weight,
          notes: pe.notes
        }])
        if (peError) throw peError
      }
    }
  }
}
