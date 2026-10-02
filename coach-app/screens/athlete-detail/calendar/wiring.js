// ==========================================================================
// ATHLETE DETAIL - calendar: Assign Program + static event wiring
// bindCalendarStaticEvents() wires every calendar control that exists in the
// markup from the start; mount() in index.js calls it once.
// ==========================================================================
import { supabase } from '../../../../coachClient.js?v=__V__'
import { coachId } from '../../../session.js?v=__V__'
import { openBuilderOverlay, closeBuilderOverlay } from '../../../builder-overlay.js?v=__V__'
import { root, athleteId, cal } from '../state.js?v=__V__'
import { openDayAddTrainingModal, switchDayAddTab, wireCoachTournamentForm } from './add-day.js?v=__V__'
import { disarmCopy } from './copy.js?v=__V__'
import { openWorkoutBuilderOverlay } from './day-modal.js?v=__V__'
import { loadCalendarMonth, renderCalendarGrid, resolveDate } from './grid.js?v=__V__'
import { applySectionToDayCal, applyTrainingToDay, openDayPicker, playInlineVideoCal, renderDayPickerGrid } from './pickers.js?v=__V__'

// ==========================================================================
// ---- ASSIGN PROGRAM ----
// Clones a SLICE of a template's weeks/days/exercises tree (rangeStart to
// rangeEnd, both "Day N" counting straight through the whole program) into
// a brand new set of rows owned by this athlete - a real copy. A day that
// was still live-linked to a Workout Library Training in the template
// carries that link forward onto the athlete's copy too (see
// setDayLiveLink above), so it keeps tracking the Training until the
// athlete starts it or the coach hand-edits that specific day; a day that
// wasn't linked stays a plain frozen copy, same as before this feature.
// Reached only through the "+" popup's Program tab (see the
// saveDayAddProgramBtn handler in bindCalendarStaticEvents).
// ==========================================================================

// One database call (copy_program in sql-history.sql): the whole slice is
// copied in a single transaction, so a dropped connection can't leave the
// athlete with half a program - it's either all there or not there at all.
async function cloneTemplateToAthlete(templateId, startDate, rangeStart, rangeEnd) {
  // startDate is the calendar day that was clicked to open this popup, and
  // it's always meant to line up with rangeStart (day 1 of whatever slice
  // was picked) - resolveDate() always counts from the program's own day 1,
  // so the new program's start_date has to be shifted back by
  // (rangeStart - 1) days for that day to land on startDate. Reusing
  // resolveDate() itself for this (week 1, day "2 - rangeStart") instead of
  // separate date-math: with week=1 it reduces to startDate + (day - 1),
  // and day = 2 - rangeStart gives startDate - (rangeStart - 1).
  const newStartDate = resolveDate(startDate, 1, 2 - rangeStart)

  const { error } = await supabase.rpc('copy_program', {
    p_source_program_id: templateId,
    p_athlete_id: Number(athleteId),
    p_start_date: newStartDate,
    p_range_start: rangeStart,
    p_range_end: rangeEnd
  })
  if (error) throw error
}

// ==========================================================================
// ---- CALENDAR TAB: STATIC EVENT WIRING ----
// Everything athlete-calendar.js registered at module top-level, against
// markup that was already in the document on that page. Called once from
// bindEvents() (see mount()) - every element referenced here is part of the
// static TEMPLATE (the calendar toolbar, the Day Detail/Add Training/Day
// Picker/New Training/Training Builder modals, the copy-armed bar), not
// anything regenerated per render, so this only ever needs to run once.
// ==========================================================================
export function bindCalendarStaticEvents() {
  root.querySelector('#calPrevBtn').addEventListener('click', function() {
    cal.currentViewMonth--
    if (cal.currentViewMonth < 0) { cal.currentViewMonth = 11; cal.currentViewYear-- }
    loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
  })

  root.querySelector('#calNextBtn').addEventListener('click', function() {
    cal.currentViewMonth++
    if (cal.currentViewMonth > 11) { cal.currentViewMonth = 0; cal.currentViewYear++ }
    loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
  })

  const dayDetailContent = root.querySelector('#dayDetailContent')

  dayDetailContent.addEventListener('click', async function(e) {
    const thumbBtn = e.target.closest('.builder-exercise-thumb')
    if (thumbBtn && thumbBtn.dataset.videoUrl) {
      playInlineVideoCal(thumbBtn, thumbBtn.dataset.videoUrl)
      return
    }

    const btn = e.target.closest('[data-action]')
    if (!btn) return

    if (btn.dataset.action === 'toggle-review-edit') {
      const dayId = btn.closest('.detail-group').dataset.programDayId
      openWorkoutBuilderOverlay(dayId, cal.currentDayDateForModal)
      return
    }
  })

  dayDetailContent.addEventListener('change', async function(e) {
    if (e.target.matches('[data-action="set-workout-type"]')) {
      const dayId = e.target.dataset.dayId
      const { error } = await supabase.from('program_days').update({ workout_type: e.target.value }).eq('id', dayId)
      if (error) { console.log(error); customAlert('Something went wrong'); return }
      const entry = (cal.calendarEntriesByDate[cal.currentDayDateForModal] || []).find(en => en.day.id === dayId)
      if (entry) entry.day.workout_type = e.target.value
      renderCalendarGrid(cal.currentViewYear, cal.currentViewMonth)
    }
  })

  root.querySelector('#closeDayDetailBtn').addEventListener('click', function() {
    root.querySelector('#dayDetailModal').classList.remove('active')
  })

  root.querySelector('#selectTrainingForDayBtn').addEventListener('click', async function() {
    if (!cal.selectedTrainingId) return
    const btn = this
    btn.disabled = true
    btn.textContent = 'Adding...'
    await applyTrainingToDay(cal.selectedTrainingId, cal.selectedTrainingName, cal.currentDayDateForAddTraining)
    btn.textContent = 'Select'
  })

  root.querySelector('#dayAddTabWorkout').addEventListener('click', function() { switchDayAddTab('workout') })
  root.querySelector('#dayAddTabProgram').addEventListener('click', function() { switchDayAddTab('program') })
  root.querySelector('#dayAddTabSection').addEventListener('click', function() { switchDayAddTab('section') })
  root.querySelector('#dayAddTabForm').addEventListener('click', function() { switchDayAddTab('form') })
  root.querySelector('#dayAddTabTournament').addEventListener('click', function() { switchDayAddTab('tournament') })
  wireCoachTournamentForm()

  root.querySelector('#programStartDayField').addEventListener('click', function() { openDayPicker('start') })
  root.querySelector('#programEndDayField').addEventListener('click', function() { openDayPicker('end') })
  root.querySelector('#dayPickerPrevBtn').addEventListener('click', function() { cal.dayPickerPage--; renderDayPickerGrid() })
  root.querySelector('#dayPickerNextBtn').addEventListener('click', function() { cal.dayPickerPage++; renderDayPickerGrid() })
  root.querySelector('#dayPickerCancelBtn').addEventListener('click', function() {
    root.querySelector('#dayPickerModal').classList.remove('active')
  })

  root.querySelector('#saveDayAddProgramBtn').addEventListener('click', async function() {
    if (!cal.selectedTemplateId) { customAlert('Please choose a program'); return }

    const saveBtn = this
    saveBtn.disabled = true
    saveBtn.textContent = 'Assigning...'

    try {
      await cloneTemplateToAthlete(cal.selectedTemplateId, cal.currentDayDateForAddTraining, cal.programStartDay, cal.programEndDay)
      root.querySelector('#dayAddTrainingModal').classList.remove('active')
      await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
    } catch (err) {
      console.log(err)
      customAlert('Something went wrong while assigning the program - nothing was added, so it\'s safe to try again.')
    } finally {
      saveBtn.disabled = false
      saveBtn.textContent = 'Assign Program'
    }
  })

  root.querySelector('#closeDayAddTrainingBtn').addEventListener('click', function() {
    root.querySelector('#dayAddTrainingModal').classList.remove('active')
  })

  // ---- "+ New Training" - name it, then build it in an overlay without
  // leaving the calendar tab (the Workout Builder overlay) ----
  root.querySelector('#newTrainingFromDayBtn').addEventListener('click', function() {
    root.querySelector('#dayAddTrainingModal').classList.remove('active')
    root.querySelector('#newTrainingNameInput').value = ''
    root.querySelector('#newTrainingNameModal').classList.add('active')
  })

  root.querySelector('#cancelNewTrainingNameBtn').addEventListener('click', function() {
    root.querySelector('#newTrainingNameModal').classList.remove('active')
    openDayAddTrainingModal(cal.currentDayDateForAddTraining)
  })

  root.querySelector('#saveNewTrainingNameBtn').addEventListener('click', async function() {
    const name = root.querySelector('#newTrainingNameInput').value.trim()
    if (!name) { customAlert('Please enter a name'); return }

    const { data, error } = await supabase
      .from('trainings')
      .insert([{ coach_id: coachId(), name }])
      .select()

    if (error) { console.log(error); customAlert('Something went wrong'); return }

    cal.cachedTrainings = null // force a fresh fetch so the one just created shows up
    root.querySelector('#newTrainingNameModal').classList.remove('active')
    cal.trainingBuilderOverlayMode = 'new-training'
    root.querySelector('#trainingBuilderOverlayModal').classList.add('active')
    openBuilderOverlay(root.querySelector('#trainingBuilderHost'), { id: data[0].id })
  })

  // 'new-training': building a fresh Workout Library entry from the
  // day-add popup's "+ New" - Done goes back to that popup so the new one
  // can be selected. 'edit-day': adjusting an already-scheduled day's
  // exercises straight from its own calendar badge (see
  // openWorkoutBuilderOverlay) - Done just closes and refreshes the month,
  // there's no popup to return to. See trainingBuilderOverlayMode's own
  // declaration further up for the state var itself.
  root.querySelector('#doneTrainingBuilderBtn').addEventListener('click', async function() {
    root.querySelector('#trainingBuilderOverlayModal').classList.remove('active')
    // Save the last edit first, so the refresh below shows it
    await closeBuilderOverlay(root.querySelector('#trainingBuilderHost'))
    if (!root) return // left the screen meanwhile
    if (cal.trainingBuilderOverlayMode === 'edit-day') {
      await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
    } else {
      // Back to the day's training list, now including the one just built
      openDayAddTrainingModal(cal.currentDayDateForAddTraining)
    }
  })

  root.querySelector('#copyArmedCancelBtn').addEventListener('click', disarmCopy)

  root.querySelector('#selectSectionForDayBtn').addEventListener('click', async function() {
    if (!cal.selectedSectionIdCal) return
    const btn = this
    btn.disabled = true
    btn.textContent = 'Adding...'
    await applySectionToDayCal(cal.selectedSectionIdCal, cal.selectedSectionNameCal, cal.currentDayDateForAddTraining)
    btn.textContent = 'Insert'
  })

  root.querySelector('#selectFormForDayBtn').addEventListener('click', async function() {
    if (!cal.selectedFormIdCal) return
    const btn = this
    btn.disabled = true
    btn.textContent = 'Assigning...'

    const { error } = await supabase.from('form_assignments').insert([{
      coach_id: coachId(), athlete_id: athleteId, form_id: cal.selectedFormIdCal, date: cal.currentDayDateForAddTraining
    }])

    if (error) { console.log(error); customAlert('Something went wrong assigning that form'); btn.disabled = false; btn.textContent = 'Assign'; return }

    root.querySelector('#dayAddTrainingModal').classList.remove('active')
    btn.textContent = 'Assign'
    await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
  })
}
