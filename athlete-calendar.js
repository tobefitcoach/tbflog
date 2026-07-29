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

// ==========================================================================
// ---- LOAD + RENDER MONTH GRID ----
// ==========================================================================
async function loadCalendarMonth(year, month) {
  document.getElementById('calMonthLabel').textContent = `${MONTH_NAMES[month]} ${year}`

  const { data, error } = await supabase
    .from('programs')
    .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises(name, category))))')
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
    const exerciseCount = entries.reduce((sum, e) => sum + e.day.program_exercises.length, 0)

    const classes = ['calendar-day']
    if (cell.outside) classes.push('calendar-day-outside')
    if (dateStr === todayStr) classes.push('calendar-day-today')

    return `
      <div class="${classes.join(' ')}" data-date="${dateStr}">
        <span class="calendar-day-number">${cell.date.getDate()}</span>
        ${exerciseCount > 0 ? `<span class="calendar-day-badge">${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}</span>` : ''}
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
        ? 'Ad-hoc'
        : `${entry.program.name} — Week ${entry.week.week_number}, ${entry.day.label || ('Day ' + entry.day.day_number)}`
      const exercises = entry.day.program_exercises

      return `
        <div class="detail-group">
          <h4 class="detail-group-title">${label}</h4>
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
  const parts = []
  if (pe.prescribed_sets) parts.push(`${pe.prescribed_sets} sets`)
  if (pe.prescribed_reps) parts.push(`${pe.prescribed_reps} reps`)
  if (pe.prescribed_weight) parts.push(`${pe.prescribed_weight}kg`)
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
})

document.getElementById('closeDayDetailBtn').addEventListener('click', function() {
  document.getElementById('dayDetailModal').classList.remove('active')
})

document.getElementById('dayDetailAddExerciseBtn').addEventListener('click', async function() {
  const dayId = await findOrCreateAdHocDay(currentDayDateForModal)
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

  document.getElementById('editScheduledExerciseTitle').textContent =
    'Edit ' + (currentEditScheduledPE.exercises ? currentEditScheduledPE.exercises.name : 'Exercise')
  document.getElementById('editScheduledSets').value = currentEditScheduledPE.prescribed_sets || ''
  document.getElementById('editScheduledReps').value = currentEditScheduledPE.prescribed_reps || ''
  document.getElementById('editScheduledWeight').value = currentEditScheduledPE.prescribed_weight || ''
  document.getElementById('editScheduledNotes').value = currentEditScheduledPE.notes || ''
  document.getElementById('editScheduledExerciseModal').classList.add('active')
}

document.getElementById('cancelEditScheduledBtn').addEventListener('click', function() {
  document.getElementById('editScheduledExerciseModal').classList.remove('active')
})

document.getElementById('saveEditScheduledBtn').addEventListener('click', async function() {
  const sets = document.getElementById('editScheduledSets').value ? parseInt(document.getElementById('editScheduledSets').value) : null
  const reps = document.getElementById('editScheduledReps').value.trim() || null
  const weight = document.getElementById('editScheduledWeight').value ? parseFloat(document.getElementById('editScheduledWeight').value) : null
  const notes = document.getElementById('editScheduledNotes').value.trim() || null

  const { error } = await supabase
    .from('program_exercises')
    .update({ prescribed_sets: sets, prescribed_reps: reps, prescribed_weight: weight, notes })
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
  document.getElementById('adHocDateInput').value = toDateStr(new Date())
  document.getElementById('adHocDateModal').classList.add('active')
})

document.getElementById('cancelAdHocDateBtn').addEventListener('click', function() {
  document.getElementById('adHocDateModal').classList.remove('active')
})

document.getElementById('continueAdHocDateBtn').addEventListener('click', async function() {
  const dateStr = document.getElementById('adHocDateInput').value
  if (!dateStr) { alert('Please choose a date'); return }

  document.getElementById('adHocDateModal').classList.remove('active')
  const dayId = await findOrCreateAdHocDay(dateStr)
  currentDayDateForModal = dateStr
  reopenDayModalAfterSave = false
  openCalendarExercisePicker(dayId)
})

async function findOrCreateAdHocDay(dateStr) {
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
    .insert([{ coach_id: session.user.id, athlete_id: athleteId, is_template: false, is_adhoc: true, start_date: dateStr, name: 'Ad-hoc Training' }])
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
}

function openCalendarExercisePicker(dayId) {
  currentDayIdForExercise = dayId
  populateCalExerciseSelect()
  document.getElementById('calPickerSets').value = ''
  document.getElementById('calPickerReps').value = ''
  document.getElementById('calPickerWeight').value = ''
  document.getElementById('calPickerNotes').value = ''
  document.getElementById('calendarExercisePickerModal').classList.add('active')
}

document.getElementById('cancelCalExercisePickerBtn').addEventListener('click', function() {
  document.getElementById('calendarExercisePickerModal').classList.remove('active')
})

document.getElementById('saveCalExercisePickerBtn').addEventListener('click', async function() {
  const exerciseId = document.getElementById('calPickerExerciseSelect').value
  if (!exerciseId) { alert('Please choose an exercise'); return }

  const sets = document.getElementById('calPickerSets').value ? parseInt(document.getElementById('calPickerSets').value) : null
  const reps = document.getElementById('calPickerReps').value.trim() || null
  const weight = document.getElementById('calPickerWeight').value ? parseFloat(document.getElementById('calPickerWeight').value) : null
  const notes = document.getElementById('calPickerNotes').value.trim() || null

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
    notes
  }])

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('calendarExercisePickerModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
  if (reopenDayModalAfterSave) openDayModal(currentDayDateForModal)
})

document.getElementById('calCreateNewExerciseBtn').addEventListener('click', function() {
  document.getElementById('calCreateExerciseName').value = ''
  document.getElementById('calCreateExerciseCategory').value = ''
  document.getElementById('calCreateExerciseInstructions').value = ''
  document.getElementById('calCreateExerciseModal').classList.add('active')
})

document.getElementById('cancelCalCreateExerciseBtn').addEventListener('click', function() {
  document.getElementById('calCreateExerciseModal').classList.remove('active')
})

document.getElementById('saveCalCreateExerciseBtn').addEventListener('click', async function() {
  const name = document.getElementById('calCreateExerciseName').value.trim()
  const category = document.getElementById('calCreateExerciseCategory').value.trim()
  const instructions = document.getElementById('calCreateExerciseInstructions').value.trim()
  if (!name) { alert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('exercises')
    .insert([{ coach_id: session.user.id, name, category, instructions }])
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
