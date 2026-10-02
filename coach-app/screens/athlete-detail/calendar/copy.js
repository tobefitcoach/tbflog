// ==========================================================================
// ATHLETE DETAIL - calendar: arm-and-drop copying and moving
// ==========================================================================
import { supabase } from '../../../../coachClient.js?v=__V__'
import { coachId } from '../../../session.js?v=__V__'
import { toDateStr, parseDateStr } from '../../../../shared/dates.js?v=__V__'
import { copyExercises } from '../../../../shared/copy-exercises.js?v=__V__'
import { root, athleteId, cal } from '../state.js?v=__V__'
import { formatShortDateCal, loadCalendarMonth, moveWorkoutToDate, trainingDisplayName } from './grid.js?v=__V__'
import { setDayLiveLink } from './pickers.js?v=__V__'

// ==========================================================================
// ---- ARM-AND-DROP COPYING (single workout, from the ⋮ menu, and a full
// week, from the copy icon in the grid's left gutter) ----
// No date-picker popup - clicking either entry point "arms" a copy (shown
// via the floating bar below) and the grid itself becomes the target
// picker: hovering highlights the day (workout mode) or whole week (week
// mode) under the cursor with a "Drop Here"/"Drop Week Here" label, and
// clicking commits it there. Nothing outside the grid is blocked while
// armed - Prev/Next, the sidebar, etc. all still work normally, since only
// clicks that land inside #calendarGrid are intercepted (see
// wireCalendarCopyArming below). Escape disarms too - see the keydown listener in mount()
// in mount(), which already calls disarmCopy() below.
// ==========================================================================
function armCopyWeek(mondayStr) {
  cal.copyArmedMode = 'week'
  cal.copyArmedIsMove = false // guards against re-arming week-copy while a workout-move was left armed
  cal.copyArmedSourceMonday = mondayStr
  cal.copyArmedSourceDayId = null
  cal.copyArmedSourceName = null
  cal.copyArmedHoverKey = null
  showCopyArmedBar(`Copying week of ${formatShortDateCal(mondayStr)} — click a week on the calendar to copy it there (hold Shift to paste onto more than one)`)
}

export function armCopyWorkout(dayId, name) {
  cal.copyArmedMode = 'workout'
  cal.copyArmedIsMove = false
  cal.copyArmedSourceDayId = dayId
  cal.copyArmedSourceName = name
  cal.copyArmedSourceMonday = null
  cal.copyArmedHoverKey = null
  showCopyArmedBar(`Copying "${name}" — click a day on the calendar to copy it there (hold Shift to paste onto more than one)`)
}

// Same arm-then-tap targeting as armCopyWorkout (mousemove highlight,
// click-a-cell-to-commit, Escape to back out) - the only real fix this
// needed for a phone, since the existing move path (wireCalendarDragToMove
// above) is honest native drag-and-drop, which doesn't fire from touch at
// all. copyArmedIsMove is what tells wireCalendarCopyArming's click
// handler to call moveWorkoutToDate instead of cloneDayToDate - moving
// somewhere doesn't make sense to repeat, so Shift-to-keep-armed is
// ignored here even though the bar reuses the same commit path.
export function armMoveWorkout(dayId, name) {
  cal.copyArmedMode = 'workout'
  cal.copyArmedIsMove = true
  cal.copyArmedSourceDayId = dayId
  cal.copyArmedSourceName = name
  cal.copyArmedSourceMonday = null
  cal.copyArmedHoverKey = null
  showCopyArmedBar(`Moving "${name}" — click a day on the calendar to move it there`)
}

export function disarmCopy() {
  cal.copyArmedMode = null
  cal.copyArmedIsMove = false
  cal.copyArmedSourceDayId = null
  cal.copyArmedSourceName = null
  cal.copyArmedSourceMonday = null
  cal.copyArmedHoverKey = null
  root.querySelector('#copyArmedBar').classList.remove('active')
  clearCopyHoverHighlight()
}

function showCopyArmedBar(text) {
  root.querySelector('#copyArmedBarText').textContent = text
  root.querySelector('#copyArmedBar').classList.add('active')
}

function clearCopyHoverHighlight() {
  root.querySelectorAll('#calendarGrid .calendar-day.copy-target-hover').forEach(el => el.classList.remove('copy-target-hover'))
  root.querySelector('#copyDropLabel').classList.remove('active')
}

function positionCopyDropLabel(cellEls, text) {
  const wrap = root.querySelector('#calendarGridWrap')
  const wrapRect = wrap.getBoundingClientRect()
  const rects = [...cellEls].map(el => el.getBoundingClientRect())
  const left = Math.min(...rects.map(r => r.left)) - wrapRect.left
  const right = Math.max(...rects.map(r => r.right)) - wrapRect.left
  const top = Math.min(...rects.map(r => r.top)) - wrapRect.top
  const bottom = Math.max(...rects.map(r => r.bottom)) - wrapRect.top
  const label = root.querySelector('#copyDropLabel')
  label.style.left = `${(left + right) / 2}px`
  label.style.top = `${(top + bottom) / 2}px`
  label.textContent = text
  label.classList.add('active')
}

function updateCopyHoverHighlight(cellEl) {
  if (!cal.copyArmedMode || !cellEl) { clearCopyHoverHighlight(); cal.copyArmedHoverKey = null; return }

  if (cal.copyArmedMode === 'week') {
    const weekMonday = cellEl.dataset.weekMonday
    if (weekMonday === cal.copyArmedHoverKey) return
    cal.copyArmedHoverKey = weekMonday
    if (weekMonday === cal.copyArmedSourceMonday) { clearCopyHoverHighlight(); return }
    root.querySelectorAll('#calendarGrid .calendar-day.copy-target-hover').forEach(el => el.classList.remove('copy-target-hover'))
    const rowCells = root.querySelectorAll(`#calendarGrid .calendar-day[data-week-monday="${weekMonday}"]`)
    rowCells.forEach(el => el.classList.add('copy-target-hover'))
    positionCopyDropLabel(rowCells, 'Drop Week Here')
  } else {
    const dateStr = cellEl.dataset.date
    if (dateStr === cal.copyArmedHoverKey) return
    cal.copyArmedHoverKey = dateStr
    root.querySelectorAll('#calendarGrid .calendar-day.copy-target-hover').forEach(el => el.classList.remove('copy-target-hover'))
    cellEl.classList.add('copy-target-hover')
    positionCopyDropLabel([cellEl], 'Drop Here')
  }
}

// Loops the 7 days from sourceMonday to targetMonday, reusing
// cloneDayToDate() below as-is for each scheduled day - it already does the
// full clone (fresh ad-hoc program/week/day, superset/section id remap,
// overrides carried over), so this is just that function called once per
// matched day. Dedupes by day.id the same way renderCalendarGrid's own
// badge list does, so a day with several workouts scheduled gets all of
// them copied, not just the first.
async function performCopyWeek(sourceMonday, targetMonday) {
  const fromStart = parseDateStr(sourceMonday)
  const toStart = parseDateStr(targetMonday)
  for (let i = 0; i < 7; i++) {
    const sourceDate = toDateStr(new Date(fromStart.getFullYear(), fromStart.getMonth(), fromStart.getDate() + i))
    const targetDate = toDateStr(new Date(toStart.getFullYear(), toStart.getMonth(), toStart.getDate() + i))
    const entries = [...new Map((cal.calendarEntriesByDate[sourceDate] || []).map(e => [e.day.id, e])).values()]
    for (const entry of entries) {
      await cloneDayToDate(entry.day.id, trainingDisplayName(entry), targetDate)
    }
  }
  await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
}

// Wired once on the persistent #calendarGrid node, same reasoning as
// wireCalendarDragToMove/wireCalendarBadgeKebabs. Registered BEFORE
// wireCalendarBadgeKebabs (see activateCalendarTab) so its capture-phase
// listener runs first and can stopImmediatePropagation to swallow a click
// before the kebab/day-open listeners ever see it.
export function wireCalendarCopyArming(grid) {
  grid.addEventListener('mousemove', function(e) {
    if (!cal.copyArmedMode) return
    updateCopyHoverHighlight(e.target.closest('.calendar-day'))
  })
  grid.addEventListener('mouseleave', function() {
    if (!cal.copyArmedMode) return
    cal.copyArmedHoverKey = null
    clearCopyHoverHighlight()
  })

  // Touch has no hover, so the preview above never showed on a phone -
  // tapping to commit already worked fine (that's a real click event, not
  // dependent on hover state), this was only ever missing the preview
  // itself. touchmove's own e.target is always the element the touch
  // STARTED on, not the one currently under the finger, unlike a mouse's -
  // elementFromPoint at the live touch point is what mousemove gets for
  // free. preventDefault stops the page scrolling while dragging a finger
  // across the grid to preview a target before lifting to commit.
  grid.addEventListener('touchmove', function(e) {
    if (!cal.copyArmedMode) return
    const touch = e.touches[0]
    if (!touch) return
    e.preventDefault()
    const el = document.elementFromPoint(touch.clientX, touch.clientY)
    updateCopyHoverHighlight(el ? el.closest('.calendar-day') : null)
  }, { passive: false })
  // Mirrors mouseleave's cleanup - if the finger lifts somewhere that
  // isn't a valid target (dragged off the grid entirely), the click
  // handler below never fires (no .calendar-day to find) so nothing else
  // would otherwise clear the stale highlight.
  grid.addEventListener('touchend', function(e) {
    if (!cal.copyArmedMode) return
    const touch = e.changedTouches[0]
    if (!touch) return
    const el = document.elementFromPoint(touch.clientX, touch.clientY)
    if (!el || !el.closest('.calendar-day')) {
      cal.copyArmedHoverKey = null
      clearCopyHoverHighlight()
    }
  })

  grid.addEventListener('click', async function(e) {
    const armBtn = e.target.closest('[data-action="arm-copy-week"]')
    if (armBtn) {
      e.stopImmediatePropagation()
      e.preventDefault()
      if (cal.copyArmedMode === 'week' && cal.copyArmedSourceMonday === armBtn.dataset.weekMonday) disarmCopy()
      else armCopyWeek(armBtn.dataset.weekMonday)
      return
    }

    if (!cal.copyArmedMode) return
    const cell = e.target.closest('.calendar-day')
    if (!cell) return
    e.stopImmediatePropagation()
    e.preventDefault()

    // Holding Shift pastes without disarming, so copying one day onto
    // several others (or one week onto several) is just repeated
    // shift-clicks instead of re-arming from scratch each time.
    // loadCalendarMonth/the week-copy path both redraw the grid from fresh
    // HTML, wiping any .copy-target-hover class along with it - clearing
    // copyArmedHoverKey forces the very next mousemove to re-highlight
    // immediately instead of the old highlight just staying gone until the
    // mouse happens to move.
    const keepArmed = e.shiftKey

    if (cal.copyArmedMode === 'week') {
      const targetMonday = cell.dataset.weekMonday
      const sourceMonday = cal.copyArmedSourceMonday
      if (keepArmed) { cal.copyArmedHoverKey = null } else { disarmCopy() }
      if (targetMonday === sourceMonday) return
      await performCopyWeek(sourceMonday, targetMonday)
    } else if (cal.copyArmedIsMove) {
      const targetDate = cell.dataset.date
      const sourceDayId = cal.copyArmedSourceDayId
      disarmCopy()
      await moveWorkoutToDate(sourceDayId, targetDate) // already reloads the month grid itself, same as the drag-to-move path above
    } else {
      const targetDate = cell.dataset.date
      const sourceDayId = cal.copyArmedSourceDayId
      const sourceName = cal.copyArmedSourceName
      if (keepArmed) { cal.copyArmedHoverKey = null } else { disarmCopy() }
      await cloneDayToDate(sourceDayId, sourceName, targetDate)
      await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
    }
  }, true)
}

async function createFreshAdHocDay(dateStr, name, workoutType) {
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
    .insert([{ week_id: newWeek[0].id, day_number: 1, workout_type: workoutType || null }])
    .select()
  if (dayError) { console.log(dayError); customAlert('Something went wrong'); throw dayError }

  return newDay[0].id
}

// program_exercises never stores logged data (that lives in
// exercise_log_sets/workout_sessions, separate tables) - so copying these
// rows straight is already "fresh and unlogged" with no extra filtering
// needed, even when the source day is already completed. Same clone shape
// as cloneTrainingToDay above (order_index offset, superset/section id
// remap, Adjust Fields overrides carried over) - just sourced from an
// existing day's program_exercises instead of a Training Library entry.
//
// The destination is always a brand new, empty day (see
// createFreshAdHocDay), so if the source day was still live-linked, the
// copy just carries that same pointer forward - see setDayLiveLink above.
async function cloneDayToDate(sourceDayId, name, targetDateStr) {
  const { data: sourceDay, error } = await supabase.from('program_days').select('workout_type, source_training_id').eq('id', sourceDayId).single()
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  const newDayId = await createFreshAdHocDay(targetDateStr, name, sourceDay.workout_type)
  if (sourceDay.source_training_id) await setDayLiveLink(newDayId, sourceDay.source_training_id)

  const { error: copyError } = await copyExercises(supabase, { from: 'day', fromId: sourceDayId, to: 'day', toId: newDayId, baseOrder: 0 })
  if (copyError) { console.log(copyError); customAlert('Something went wrong copying the exercises'); return }
}
