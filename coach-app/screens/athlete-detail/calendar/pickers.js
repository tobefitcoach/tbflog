// ==========================================================================
// ATHLETE DETAIL - calendar: Program / Section / Form tabs of the add popup
// Lists, previews, the program day-range picker, live-linking, and inline
// exercise video.
// ==========================================================================
import { supabase } from '../../../../coachClient.js?v=__V__'
import * as nav from '../../../nav.js?v=__V__'
import { coachId } from '../../../session.js?v=__V__'
import { escapeHtml } from '../../../../escape.js?v=__V__'
import { getYouTubeEmbedUrl } from '../../../../shared/video.js?v=__V__'
import { copyExercises } from '../../../../shared/copy-exercises.js?v=__V__'
import { root, mountToken, athleteId, cal } from '../state.js?v=__V__'
import { getProgramTemplates, renderWorkoutPreviewExercise } from './add-day.js?v=__V__'
import { loadCalendarMonth } from './grid.js?v=__V__'

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
export async function loadDayAddProgramList() {
  const data = await getProgramTemplates()
  const list = root.querySelector('#dayAddProgramList')
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
  cal.selectedTemplateId = null
  cal.selectedTemplateName = null
  root.querySelector('#dayAddProgramPreview').innerHTML = '<p class="no-metrics">Select a program to preview it</p>'
  root.querySelector('#dayRangeRow').style.display = 'none'
  root.querySelector('#saveDayAddProgramBtn').disabled = true
}

async function previewTemplate(templateId, templateName) {
  const token = mountToken
  cal.selectedTemplateId = templateId
  cal.selectedTemplateName = templateName

  const preview = root.querySelector('#dayAddProgramPreview')
  preview.innerHTML = '<p class="no-metrics">Loading…</p>'

  let details = cal.cachedTemplateDays[templateId]
  if (!details) {
    const { data, error } = await supabase
      .from('program_weeks')
      .select('*, program_days(*, program_exercises(id))')
      .eq('program_id', templateId)
    if (!nav.isCurrent(token)) return
    if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this preview</p>'; return }
    details = buildTemplateDayList(data)
    cal.cachedTemplateDays[templateId] = details
  }

  // A different row may have been clicked while this was still loading -
  // don't overwrite that newer preview/range with this now-stale one
  if (cal.selectedTemplateId !== templateId) return

  cal.totalProgramDays = Math.max(details.totalWeeks * 7, 1)
  cal.programStartDay = 1
  cal.programEndDay = cal.totalProgramDays
  updateDayRangeLabels()
  root.querySelector('#dayRangeRow').style.display = 'flex'
  root.querySelector('#saveDayAddProgramBtn').disabled = false

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
  root.querySelector('#programStartDayLabel').textContent = 'Day ' + cal.programStartDay
  root.querySelector('#programEndDayLabel').textContent = 'Day ' + cal.programEndDay
}

function setProgramStartDay(day) {
  cal.programStartDay = day
  if (cal.programStartDay > cal.programEndDay) cal.programEndDay = cal.programStartDay
  updateDayRangeLabels()
}

function setProgramEndDay(day) {
  cal.programEndDay = day
  if (cal.programEndDay < cal.programStartDay) cal.programStartDay = cal.programEndDay
  updateDayRangeLabels()
}

// ---- Day Picker modal: a paginated grid of day numbers (4 weeks/28 days
// per page), reused for both the Start and End fields via dayPickerTarget ----
export function openDayPicker(target) {
  cal.dayPickerTarget = target
  const current = target === 'start' ? cal.programStartDay : cal.programEndDay
  cal.dayPickerPage = Math.floor((current - 1) / 28)
  renderDayPickerGrid()
  root.querySelector('#dayPickerModal').classList.add('active')
}

export function renderDayPickerGrid() {
  const totalWeeks = Math.max(Math.ceil(cal.totalProgramDays / 7), 1)
  const pageCount = Math.max(Math.ceil(totalWeeks / 4), 1)
  cal.dayPickerPage = Math.max(0, Math.min(cal.dayPickerPage, pageCount - 1))

  const firstWeek = cal.dayPickerPage * 4 + 1
  const lastWeek = Math.min(firstWeek + 3, totalWeeks)
  root.querySelector('#dayPickerRangeLabel').textContent = `Week ${firstWeek} - ${lastWeek} of ${totalWeeks}`

  const firstDay = (firstWeek - 1) * 7 + 1
  const lastDay = Math.min(lastWeek * 7, cal.totalProgramDays)
  const current = cal.dayPickerTarget === 'start' ? cal.programStartDay : cal.programEndDay

  let cellsHtml = ''
  for (let d = firstDay; d <= lastDay; d++) {
    cellsHtml += `<button type="button" class="day-picker-cell ${d === current ? 'selected' : ''}" data-day="${d}">${String(d).padStart(2, '0')}</button>`
  }
  const grid = root.querySelector('#dayPickerGrid')
  grid.innerHTML = cellsHtml

  grid.querySelectorAll('.day-picker-cell').forEach(cell => {
    cell.addEventListener('click', function() {
      const day = parseInt(cell.dataset.day)
      if (cal.dayPickerTarget === 'start') setProgramStartDay(day)
      else setProgramEndDay(day)
      root.querySelector('#dayPickerModal').classList.remove('active')
    })
  })

  root.querySelector('#dayPickerPrevBtn').disabled = cal.dayPickerPage === 0
  root.querySelector('#dayPickerNextBtn').disabled = cal.dayPickerPage >= pageCount - 1
}

// Just closes back to the calendar month view afterward - already saw a
// preview of this training before hitting Select, so popping the day
// detail modal open again on top of that would just be showing it a
// second time. Clicking the day itself still opens it if wanted.
export async function applyTrainingToDay(trainingId, trainingName, dateStr) {
  const dayId = await findOrCreateAdHocDay(dateStr, trainingName)
  await cloneTrainingToDay(trainingId, dayId)

  // Only stamps the type if this day doesn't already have one - same
  // "don't clobber what's already set" reasoning as the day's label. A
  // separate query since findOrCreateAdHocDay (shared with the Section tab,
  // which reuses the same day within one "+ Add Workout" popup session)
  // only ever returns an id, not the day's current fields
  const training = (cal.cachedTrainings || []).find(t => t.id === trainingId)
  if (training && training.workout_type) {
    const { data: dayRow } = await supabase.from('program_days').select('workout_type').eq('id', dayId).single()
    if (dayRow && !dayRow.workout_type) {
      await supabase.from('program_days').update({ workout_type: training.workout_type }).eq('id', dayId)
    }
  }

  root.querySelector('#dayAddTrainingModal').classList.remove('active')
  await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
}

// ==========================================================================
// ---- LIVE-LINKED WORKOUTS ----
// source_training_id on a program_days row means that day still tracks a
// Workout Library Training's current content - see sync_live_training_days
// in sql-history.sql, which is what actually keeps it in sync at read time.
// Set only when a Training lands on a day that was completely empty before
// it; cleared (detached, frozen from then on - today's old copy-only
// behavior) the moment anything else touches that day, including a second
// Training or Section added alongside it. Pass a training id to set/replace
// the link, or null to detach - synced_at always resets to null either way,
// so the next read naturally performs (and timestamps) the first real sync
// rather than this call guessing at a timestamp itself.
// ==========================================================================
export async function setDayLiveLink(dayId, trainingId) {
  const { error } = await supabase
    .from('program_days')
    .update({ source_training_id: trainingId, source_training_synced_at: null })
    .eq('id', dayId)
  if (error) console.log('Error updating live-link:', error)
}

// Copies a saved training's exercise list onto an ad-hoc day - a real copy,
// appended after whatever's already on that day (adding a second Training
// to a day never interleaves with the first); whether the day keeps
// tracking the Training going forward (see setDayLiveLink above) depends on
// whether it was empty before this call.
async function cloneTrainingToDay(trainingId, dayId) {
  const { data: copied, error } = await copyExercises(supabase, { from: 'training', fromId: trainingId, to: 'day', toId: dayId })
  if (error) { console.log(error); customAlert('Something went wrong copying the exercises'); return }
  if (copied.length === 0) return

  // The copy starts right after the day's last exercise, so a copy that
  // starts at 0 means the day was empty before it
  const dayWasEmpty = Math.min(...copied.map(r => r.order_index)) === 0
  await setDayLiveLink(dayId, dayWasEmpty ? trainingId : null)
}

// name is only used the first time a training is created for this popup
// session - reusing across tabs (e.g. add a Section, then a Training, both
// in the same "+ Add Workout" popup) is what combines them into one day;
// see adHocDayIdForThisSession above for why this is no longer a
// date-based database lookup
async function findOrCreateAdHocDay(dateStr, name) {
  if (cal.adHocDayIdForThisSession && cal.adHocDayDateForThisSession === dateStr) {
    return cal.adHocDayIdForThisSession
  }

  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{ coach_id: coachId(), athlete_id: athleteId, is_template: false, is_adhoc: true, start_date: dateStr, name: name || 'Workout' }])
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

  cal.adHocDayIdForThisSession = newDay[0].id
  cal.adHocDayDateForThisSession = dateStr
  return newDay[0].id
}

// ==========================================================================
// ---- SECTION TAB: list + preview + bulk-insert ----
// Same list-then-preview pattern as the Single Workout tab. Reuses
// renderWorkoutPreviewExercise/targetLineForTraining as-is for the preview
// - a section_exercises row has the exact same shape (exercise_id,
// prescribed_*, set_targets, extra_fields, notes, joined exercises) those
// already render, so no new preview renderer is needed here.
// ==========================================================================
async function getSectionsListCal() {
  if (cal.cachedSectionsCal) return cal.cachedSectionsCal
  const { data, error } = await window.fetchWithRetry((signal) => supabase.from('sections').select('*').order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your sections - check your connection and try again'); return null }
  cal.cachedSectionsCal = data
  return cal.cachedSectionsCal
}

export function resetSectionPreviewCal() {
  cal.selectedSectionIdCal = null
  cal.selectedSectionNameCal = null
  root.querySelector('#dayAddSectionPreview').innerHTML = '<p class="no-metrics">Select a section to preview it</p>'
  root.querySelector('#selectSectionForDayBtn').disabled = true
}

export async function loadDayAddSectionListCal() {
  resetSectionPreviewCal()
  const data = await getSectionsListCal()
  const list = root.querySelector('#dayAddSectionList')

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
        previewSectionCal(row.dataset.id, row.dataset.name)
      })
    })
  }
}

async function previewSectionCal(sectionId, sectionName) {
  cal.selectedSectionIdCal = sectionId
  cal.selectedSectionNameCal = sectionName
  root.querySelector('#selectSectionForDayBtn').disabled = false

  const preview = root.querySelector('#dayAddSectionPreview')
  preview.innerHTML = '<p class="no-metrics">Loading…</p>'

  let exercises = cal.cachedSectionExercisesCal[sectionId]
  if (!exercises) {
    const { data, error } = await supabase
      .from('section_exercises')
      .select('*, exercises!exercise_id(name, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
      .eq('section_id', sectionId)
      .order('order_index')
    if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this preview</p>'; return }
    exercises = data
    cal.cachedSectionExercisesCal[sectionId] = exercises
  }

  if (cal.selectedSectionIdCal !== sectionId) return

  preview.innerHTML = `
    <div class="workout-preview-header">
      <h3>${sectionName}</h3>
      <span class="workout-preview-count">${exercises.length} Exercise${exercises.length === 1 ? '' : 's'}</span>
    </div>
    ${exercises.length === 0
      ? '<p class="no-metrics">No exercises in this section</p>'
      : exercises.map(renderWorkoutPreviewExercise).join('')}
  `
}

export async function applySectionToDayCal(sectionId, sectionName, dateStr) {
  const dayId = await findOrCreateAdHocDay(dateStr, sectionName)
  await cloneSectionToDayCal(sectionId, sectionName, dayId)
  root.querySelector('#dayAddTrainingModal').classList.remove('active')
  await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
}

// Appends a Section's exercises after whatever's already on the day, as
// one block (copy_exercises gives them one shared section instance id), so
// repeated adds to the same day never collide or merge.
async function cloneSectionToDayCal(sectionId, sectionName, dayId) {
  const { data: copied, error } = await copyExercises(supabase, { from: 'section', fromId: sectionId, to: 'day', toId: dayId, sectionLabel: sectionName })
  if (error) { console.log(error); customAlert('Something went wrong copying the exercises'); return }
  if (copied.length === 0) return

  // A Section is never a Training, so this day is never purely one Training
  // anymore either way - detach if it was live-linked (a no-op write if it
  // wasn't).
  await setDayLiveLink(dayId, null)
}

// ==========================================================================
// ---- FORM TAB: list + preview + assign ----
// Same list-then-preview pattern as the Section tab, but assigning writes a
// form_assignments row directly - a form has no exercises to clone onto a
// program_day, it's a separate thing entirely that the athlete fills out.
// ==========================================================================
async function getFormsListCal() {
  if (cal.cachedFormsCal) return cal.cachedFormsCal
  const { data, error } = await window.fetchWithRetry((signal) => supabase.from('forms').select('*').order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your forms - check your connection and try again'); return null }
  cal.cachedFormsCal = data
  return cal.cachedFormsCal
}

export function resetFormPreviewCal() {
  cal.selectedFormIdCal = null
  cal.selectedFormNameCal = null
  root.querySelector('#dayAddFormPreview').innerHTML = '<p class="no-metrics">Select a form to preview it</p>'
  root.querySelector('#selectFormForDayBtn').disabled = true
}

export async function loadDayAddFormListCal() {
  const data = await getFormsListCal()
  const list = root.querySelector('#dayAddFormList')

  if (data === null) {
    list.innerHTML = '<p class="no-metrics">Something went wrong loading your Forms</p>'
  } else if (data.length === 0) {
    list.innerHTML = '<p class="no-metrics">No forms saved yet - create one in Forms first</p>'
  } else {
    list.innerHTML = data.map(f => `
      <div class="training-pick-row" data-id="${f.id}" data-name="${f.name}">
        <span>${f.name}</span>
      </div>
    `).join('')

    list.querySelectorAll('.training-pick-row').forEach(row => {
      row.addEventListener('click', function() {
        list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        previewFormCal(row.dataset.id, row.dataset.name)
      })
    })
  }
}

async function previewFormCal(formId, formName) {
  cal.selectedFormIdCal = formId
  cal.selectedFormNameCal = formName
  root.querySelector('#selectFormForDayBtn').disabled = false

  const preview = root.querySelector('#dayAddFormPreview')
  preview.innerHTML = '<p class="no-metrics">Loading…</p>'

  let questions = cal.cachedFormQuestionsCal[formId]
  if (!questions) {
    const { data, error } = await supabase.from('form_questions').select('*').eq('form_id', formId).order('order_index')
    if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this preview</p>'; return }
    questions = data
    cal.cachedFormQuestionsCal[formId] = questions
  }

  if (cal.selectedFormIdCal !== formId) return

  const form = (cal.cachedFormsCal || []).find(f => f.id === formId)

  preview.innerHTML = `
    <div class="workout-preview-header">
      <h3>${escapeHtml(formName)}</h3>
      <span class="workout-preview-count">${questions.length} Question${questions.length === 1 ? '' : 's'}</span>
    </div>
    ${form && form.gate_workout ? '<p class="form-gate-notice"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86l-8.18 14.18A2 2 0 0 0 4 21h16a2 2 0 0 0 1.89-2.96L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg> Gates that day\'s workout until completed</p>' : ''}
    ${questions.length === 0
      ? '<p class="no-metrics">No questions in this form</p>'
      : questions.map(q => `<div class="workout-preview-exercise"><span>${escapeHtml(q.question_text) || '<em>(untitled question)</em>'}</span></div>`).join('')}
  `
}

// ==========================================================================
// ---- INLINE VIDEO (exercise thumbnails in the day popup) ----
// ==========================================================================

// Tapping a card's thumbnail swaps it for a playing embed right in place,
// same as the athlete's own exercise card
export function playInlineVideoCal(containerEl, url) {
  if (!url) return
  const embedUrl = getYouTubeEmbedUrl(url)
  if (!embedUrl) { window.open(url, '_blank'); return }
  containerEl.innerHTML = `<iframe src="${embedUrl}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`
}
