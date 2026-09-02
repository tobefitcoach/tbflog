// ==========================================================================
// PROGRAM BUILDER
// Edits one template's Weeks -> Days -> Exercises. A template has no real
// dates yet - day_number just means "the Nth day of that week, once this
// gets assigned to an athlete with a start date" (see athlete-calendar.js
// for the date math that uses this). The coach's own label field is what
// actually describes a day ("Day 1 — Upper Body"). Clicking a filled-in day
// opens the real Workout Builder (training-builder.html, embedded - see
// openWorkoutBuilderOverlay) in day-editing mode - same search-the-library/
// drag-to-reorder UI as editing a Workout Library entry, instead of a
// separate, more limited inline editor.
// ==========================================================================
import { supabase } from './coachClient.js'

const params = new URLSearchParams(window.location.search)
const programId = params.get('id')

let weeksCache = [] // last-loaded weeks (with nested days/exercises), used to compute next week/day/order numbers without extra queries

// Weeks page 4-at-a-time (same paging pattern as the athlete calendar's
// month view). Every week always shows all 7 day slots (day_number 1-7) as
// a real calendar-style grid.
const WEEKS_PER_PAGE = 4
let currentWeekPage = 0

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadProgram()
  loadWeeks()
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

// YouTube's thumbnail images are available at a predictable URL from just
// the video id, no API key needed - other hosts fall back to a placeholder.
// Used by the Add Workout preview panel below (renderSectionPreviewExercise).
function getYouTubeThumbnail(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg` : null
}

// A program_exercises row keeps one set_targets array
// ([{reps, weight, rest, type}, ...], index 0 = Set 1). Used by the Add
// Workout preview panel below (renderSectionPreviewExercise) to show a set
// count - actually editing set targets now happens inside the real Workout
// Builder (see openWorkoutBuilderOverlay).
function deriveSetTargets(row) {
  if (row.set_targets && row.set_targets.length) return row.set_targets
  const count = row.prescribed_sets || 1
  return Array.from({ length: count }, () => ({ reps: row.prescribed_reps || null, weight: row.prescribed_weight || null, rest: row.rest_seconds || null, type: 'main' }))
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
// Workout), a filled one opens the real Workout Builder in day-editing mode
// (see openWorkoutBuilderOverlay).
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

function renderProgramDayCell(week, dayNumber) {
  const day = week.program_days.find(d => d.day_number === dayNumber)
  const hasContent = day && (day.label || day.program_exercises.length > 0)
  // Small colored dot, not an icon - status/planned already owns the
  // badge's background color, so type gets its own separate marker
  const typeDot = day && day.workout_type ? `<span class="workout-type-dot workout-type-dot-${day.workout_type}"></span>` : ''
  const badgeLabel = hasContent
    ? typeDot + (day.label || `${day.program_exercises.length} exercise${day.program_exercises.length === 1 ? '' : 's'}`)
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
// findDay() (see below) already uses elsewhere in this file.
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
  // trigger the cell's own click (which opens the Workout Builder)
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
    if (day) openWorkoutBuilderOverlay(day.id)
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
// ---- OPEN A DAY: THE REAL WORKOUT BUILDER (embedded) ----
// Same training-builder.html iframe overlay the athlete calendar's own
// per-day editing uses (see openWorkoutBuilderOverlay in
// athlete-calendar.js) - ?dayId= instead of ?id= puts training-builder.js
// into "edit this scheduled day's program_exercises" mode, giving the
// identical search-the-library-on-the-left/reorder-on-the-right UI as
// editing a Workout Library entry.
// ==========================================================================
function openWorkoutBuilderOverlay(dayId) {
  document.getElementById('trainingBuilderFrame').src = `training-builder.html?dayId=${dayId}&embed=1`
  document.getElementById('trainingBuilderOverlayModal').classList.add('active')
}

document.getElementById('doneTrainingBuilderBtn').addEventListener('click', async function() {
  document.getElementById('trainingBuilderOverlayModal').classList.remove('active')
  document.getElementById('trainingBuilderFrame').src = 'about:blank'
  await loadWeeks()
})

// Small lookup into the in-memory tree, used instead of an extra query
function findDay(dayId) {
  for (const week of weeksCache) {
    const day = week.program_days.find(d => d.id === dayId)
    if (day) return day
  }
  return null
}

// Refreshes just the one grid cell for a day, from weeksCache (already kept
// live-accurate) - avoids a full reload just to update one badge (used
// right after Add Workout below, which doesn't otherwise touch the grid)
function refreshDayCellFor(dayId) {
  const day = findDay(dayId)
  const week = weeksCache.find(w => w.program_days.some(d => d.id === dayId))
  if (!day || !week) return
  const cell = document.querySelector(`#programWeeksGrid .calendar-day[data-week-id="${week.id}"][data-day-number="${day.day_number}"]`)
  if (cell) cell.outerHTML = renderProgramDayCell(week, day.day_number)
}

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

async function deleteWeek(weekId) {
  if (!(await customConfirm('Delete this week and everything in it?'))) return

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
// from the grid cell's own kebab menu.
// ==========================================================================
async function deleteDay(dayId) {
  if (!(await customConfirm('Delete this day and its exercises?'))) return

  const { error } = await supabase.from('program_days').delete().eq('id', dayId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  for (const week of weeksCache) {
    const idx = week.program_days.findIndex(d => d.id === dayId)
    if (idx === -1) continue
    week.program_days.splice(idx, 1)
    break
  }

  renderWeekNav()
}

// ==========================================================================
// ---- ADD WORKOUT (clone a saved Workout Library training into a day) ----
// Same clone shape athlete-calendar.js's cloneTrainingToDay uses for a real
// athlete day - carries section/superset links and any "Adjust Fields"/
// Alternative Exercise overrides from the Training over, so assigning one
// that was fine-tuned in Workout Builder doesn't silently lose that. Only
// reachable from the "+" on an empty grid cell now - a day that already has
// something on it opens the real Workout Builder instead (see
// openWorkoutBuilderOverlay above), which has its own "Add Workout" button.
// ==========================================================================
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
  document.getElementById('addTrainingSearchInput').value = ''

  const data = await getTrainingsList()
  if (data === null) {
    document.getElementById('addTrainingList').innerHTML = '<p class="no-metrics">Something went wrong loading the Workout Library</p>'
  } else if (data.length === 0) {
    document.getElementById('addTrainingList').innerHTML = '<p class="no-metrics">No workouts saved yet - create one in the Workout Library first</p>'
  } else {
    renderAddTrainingList('')
  }

  document.getElementById('addTrainingModal').classList.add('active')
}

function renderAddTrainingList(filterText) {
  const list = document.getElementById('addTrainingList')
  const filter = filterText.trim().toLowerCase()
  const filtered = filter ? cachedTrainings.filter(t => t.name.toLowerCase().includes(filter)) : cachedTrainings

  if (filtered.length === 0) {
    list.innerHTML = '<p class="no-metrics">No workouts match your search</p>'
    return
  }

  list.innerHTML = filtered.map(t => `
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

document.getElementById('addTrainingSearchInput').addEventListener('input', function() {
  if (cachedTrainings) renderAddTrainingList(this.value)
})

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
  refreshDayCellFor(day.id)
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
