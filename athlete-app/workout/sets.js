// ==========================================================================
// ATHLETE APP - workout: set logging
// Set rows, checking/unchecking a set, adding/removing extra sets.
// ==========================================================================
import { athlete, wk } from '../state.js?v=__V__'
import { findPE, logSetsByPE } from '../data.js?v=__V__'
import { formatWeight, parseTimeToParts, weightToKg } from '../format.js?v=__V__'
import { queueUpsert, scheduleFlush } from '../outbox.js?v=__V__'
import { playInlineVideo } from '../screens/home.js?v=__V__'
import { goToNextGroupStep } from './group.js?v=__V__'
import { clearRestTimer, maybeStartRestTimer } from './rest-timer.js?v=__V__'

// Whatever the athlete has typed into a not-yet-checked set's inputs, keyed
// by "peId-setNumber" - { reps, duration, weight, distance }. renderSetRow reads from
// here first, falling back to the coach's target/previously-logged value
// only when nothing's been typed yet. Every exercise slide fully replaces
// pageContent's innerHTML on render (swiping, or a group step-through
// advancing), so without this, typing weights into a couple of sets and
// then swiping away - or just checking a DIFFERENT set, which re-renders
// the whole card - silently lost anything not yet checked off. Cleared for
// a set the instant it's actually checked (see checkSet), since the real
// saved value takes over as the source of truth at that point.
let draftSetValues = {}
// pe.id -> how many athlete-added extra sets (beyond pe.prescribed_sets)
// currently exist for that exercise. Same reason as draftSetValues above:
// renderSingleSlideBody rebuilds its rows from pe.prescribed_sets/loggedSets
// alone every time a slide re-renders, so an added-but-not-yet-logged set
// used to vanish (along with anything typed into it) the moment the
// athlete swiped to another exercise and back. Kept in sync with the DOM
// on every add/remove (see addSetRow and the remove-set handler) rather
// than just incremented/decremented, so removing a non-last extra row
// still leaves the count matching reality.
export let extraSetCountByPE = {}

// ==========================================================================
// ---- SET LOGGING ----
// Unchanged from the per-set logging built earlier - now dropped into the
// single active-exercise card above instead of an all-exercises list.
// ==========================================================================
export function renderSetRow(pe, setNumber, logged, tracksReps, isTimed, tracksWeight, isExtra, exerciseLabel) {
  const checked = !!(logged && logged.completed_at)
  // A not-yet-checked set's draft (see draftSetValues above) wins over the
  // coach's target/previously-logged value - it's whatever the athlete
  // most recently typed, which is more current than either of those. A
  // checked set ignores it entirely - completed_at means the real saved
  // row is now the source of truth, and its inputs are disabled anyway.
  const draft = !checked ? draftSetValues[`${pe.id}-${setNumber}`] : null
  // Each set can have its own coach-set target now (a pyramid) - fall back
  // to the old shared prescribed_reps/prescribed_weight for sets beyond
  // what the coach targeted (an athlete-added extra set) or for
  // pre-pyramid data that has no set_targets at all
  const target = pe.set_targets && pe.set_targets[setNumber - 1]
  // draft.<field> is undefined when that field was never typed into (fall
  // through to logged/target as before) but explicitly null/'' once typed
  // then fully cleared - !== undefined (not != null) is what keeps a
  // deliberately-cleared field from reverting to the prescribed value
  const repsVal = draft && draft.reps !== undefined ? draft.reps : (logged ? (logged.actual_reps || '') : ((target ? target.reps : pe.prescribed_reps) || ''))
  // Duration is its own field now (Reps and Timed used to be mutually
  // exclusive, sharing the same reps/actual_reps slot) - falls back to
  // reading repsVal itself for exercises that predate the split and are
  // still reps-off/timed-only, since that's exactly where the old data lives.
  let durationVal = draft && draft.duration !== undefined ? draft.duration : (logged ? (logged.actual_duration || '') : ((target && target.duration != null) ? target.duration : ''))
  if (!durationVal && isTimed && !tracksReps) durationVal = repsVal
  // Each row starts out in the athlete's default unit (data-unit), but can
  // be flipped per-row with the unit toggle button below - actual_weight is
  // always stored in kg regardless of which unit was used to type it in.
  // The draft is cached in kg too (see wireExerciseCardEvents' input
  // listener), for the same reason - so it re-displays correctly in
  // whichever unit is currently active, not whichever unit happened to be
  // showing at the moment it was typed.
  const unit = athlete.weight_unit || 'kg'
  const loggedWeightKg = logged ? logged.actual_weight : (target ? target.weight : pe.prescribed_weight)
  const weightKg = draft && draft.weight !== undefined ? draft.weight : loggedWeightKg
  const weightVal = weightKg != null ? formatWeight(weightKg, unit) : ''
  // Only flag warmup/failure sets - a plain "Main Set" on every row would
  // just be noise, since that's the default for most sets in a workout
  const setType = target && target.type && target.type !== 'main' ? target.type : null
  const typeLabel = setType === 'warmup' ? 'Warmup' : setType === 'failure' ? 'Failure' : ''
  const isUnilateral = pe.exercises && pe.exercises.is_unilateral
  // Reps + time + weight together means 3 flex:1 inputs competing for
  // whatever's left after the fixed-width label/unit-toggle/check-button -
  // tight enough on a phone that the full "reps each side" placeholder was
  // getting cut off mid-word. Dropping to just "reps" when crowded isn't
  // losing information: isUnilateral already gets its own "Each Side"
  // badge right next to the Set N label on the same row.
  const crowded = tracksReps && isTimed && tracksWeight
  const repsPlaceholder = 'reps' + (isUnilateral && !crowded ? ' each side' : '')
  const { mm, ss } = parseTimeToParts(durationVal)
  const tracksDistance = pe.exercises && pe.exercises.tracks_distance
  const distanceVal = draft && draft.distance !== undefined ? draft.distance : (logged ? (logged.actual_distance != null ? logged.actual_distance : '') : ((target && target.distance != null) ? target.distance : ''))

  return `
    <div class="set-row ${checked ? 'completed' : ''} ${crowded ? 'set-row-crowded' : ''}" data-set-number="${setNumber}" data-unit="${unit}" data-pe-id="${pe.id}">
      <span class="set-label">${exerciseLabel ? `<span class="set-row-exercise-label">${exerciseLabel}</span>` : ''}Set ${setNumber}${typeLabel ? `<span class="set-type-badge set-type-${setType}">${typeLabel}</span>` : ''}${isUnilateral ? '<span class="set-type-badge set-type-unilateral">Each Side</span>' : ''}</span>
      ${tracksReps ? `<div class="set-field ${crowded ? '' : 'set-field-reps'}"><input type="text" inputmode="numeric" class="set-reps-input" value="${repsVal}" placeholder="${repsPlaceholder}" ${checked ? 'disabled' : ''}>${crowded ? '' : '<span class="set-field-unit">reps</span>'}</div>` : ''}
      ${isTimed ? `
        <div class="set-time-input">
          <input type="text" inputmode="numeric" class="set-time-mm" value="${String(mm).padStart(2, '0')}" maxlength="2" ${checked ? 'disabled' : ''}>
          <span class="set-time-sep">:</span>
          <input type="text" inputmode="numeric" class="set-time-ss" value="${String(ss).padStart(2, '0')}" maxlength="2" ${checked ? 'disabled' : ''}>
        </div>
      ` : ''}
      ${tracksWeight ? `
        <input type="number" inputmode="decimal" class="set-weight-input" value="${weightVal}" placeholder="${unit}" step="0.5" ${checked ? 'disabled' : ''}>
        <button type="button" class="set-unit-toggle" data-action="toggle-unit" title="Switch to ${unit === 'kg' ? 'lbs' : 'kg'}" ${checked ? 'disabled' : ''}>${unit}</button>
      ` : ''}
      ${tracksDistance ? `<div class="set-field set-field-distance"><input type="number" inputmode="numeric" class="set-distance-input" value="${distanceVal}" placeholder="meters" step="1" ${checked ? 'disabled' : ''}><span class="set-field-unit">m</span></div>` : ''}
      <button type="button" class="set-check-btn ${checked ? 'checked' : ''}" data-action="check-set" title="${checked ? 'Undo' : 'Mark done'}">${checked ? '✓' : ''}</button>
      ${isExtra && !checked ? '<button type="button" class="set-remove-btn" data-action="remove-set" title="Remove set">✕</button>' : ''}
    </div>
  `
}

// Flips one row's kg/lbs display without changing the weight it represents
// - converts the number currently typed in so switching units relabels it
// instead of silently reinterpreting it (100kg staying "100" after a
// switch would quietly turn it into 100lbs, which is wrong)
function toggleRowUnit(rowEl) {
  const weightInput = rowEl.querySelector('.set-weight-input')
  const unitBtn = rowEl.querySelector('.set-unit-toggle')
  if (!weightInput || !unitBtn) return

  const currentUnit = rowEl.dataset.unit || 'kg'
  const nextUnit = currentUnit === 'kg' ? 'lbs' : 'kg'
  const typed = parseFloat(weightInput.value)
  if (!isNaN(typed)) {
    const kgVal = weightToKg(typed, currentUnit)
    weightInput.value = formatWeight(kgVal, nextUnit)
  }

  rowEl.dataset.unit = nextUnit
  weightInput.placeholder = nextUnit
  unitBtn.textContent = nextUnit
  unitBtn.title = `Switch to ${nextUnit === 'kg' ? 'lbs' : 'kg'}`

  // Tapping the toggle button (not the input itself) steals focus, which
  // is what was dismissing the on-screen keyboard - refocusing the
  // weight input right after brings it straight back up instead of
  // leaving the athlete to tap back into the field themselves
  weightInput.focus()
}

// onExerciseEmptied(peId): called when a remove-set tap leaves an exercise
// with zero set rows left - only reachable for a self-logged exercise
// (prescribed_sets is null there, so even its first/only row carries a
// remove button; a coach-assigned exercise always keeps at least
// prescribed_sets rows, whose remove buttons never show in the first
// place - see renderSingleSlideBody's isExtra check)
export function wireExerciseCardEvents(containerId, dateStr, onExerciseEmptied) {
  document.getElementById(containerId).addEventListener('click', async function(e) {
    const thumbBtn = e.target.closest('.active-exercise-thumb')
    if (thumbBtn && thumbBtn.dataset.videoUrl) {
      playInlineVideo(thumbBtn, thumbBtn.dataset.videoUrl)
      return
    }

    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const row = btn.closest('.set-row')
    // add-set buttons carry their own data-pe-id (there can be two on a
    // superset slide, one per exercise); check/uncheck/remove-set read it
    // off the row they're inside instead
    const peId = btn.dataset.peId || (row && row.dataset.peId)

    if (btn.dataset.action === 'add-set') {
      addSetRow(peId)
    } else if (btn.dataset.action === 'toggle-unit') {
      toggleRowUnit(row)
    } else if (btn.dataset.action === 'check-set') {
      const setNumber = parseInt(row.dataset.setNumber)
      if (row.classList.contains('completed')) {
        await uncheckSet(peId, setNumber, dateStr, row)
      } else {
        await checkSet(peId, setNumber, dateStr, row)
      }
    } else if (btn.dataset.action === 'remove-set') {
      delete draftSetValues[`${peId}-${row.dataset.setNumber}`]
      row.remove()
      const remaining = document.getElementById(containerId).querySelectorAll(`.set-row[data-pe-id="${peId}"]`).length
      const pe = findPE(peId)
      if (pe) extraSetCountByPE[peId] = Math.max(0, remaining - (pe.prescribed_sets || 0))
      if (onExerciseEmptied && remaining === 0) onExerciseEmptied(peId)
    }
  })

  // mm:ss time boxes: strip anything non-digit as it's typed, then pad back
  // to 2 digits (and clamp seconds to 59) once the athlete taps away - kept
  // as two small text inputs rather than type="number" so the "00" padding
  // actually stays visible instead of browsers stripping the leading zero
  const container = document.getElementById(containerId)
  // Selects the "00" the moment a box is tapped, so typing a digit replaces
  // it immediately instead of needing a manual delete first - focusin
  // (not focus) since this is delegated from the container, and plain
  // focus doesn't bubble
  container.addEventListener('focusin', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      e.target.select()
    }
  })
  container.addEventListener('input', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 2)
    }
  })
  container.addEventListener('focusout', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      const max = e.target.classList.contains('set-time-ss') ? 59 : 99
      const val = Math.min(parseInt(e.target.value) || 0, max)
      e.target.value = String(val).padStart(2, '0')
    }
  })

  // Saves every keystroke into draftSetValues (see its declaration) so a
  // typed-but-not-yet-checked value survives the next re-render instead of
  // silently reverting to the coach's target - see renderSetRow, which
  // reads from this cache first.
  container.addEventListener('input', function(e) {
    const row = e.target.closest('.set-row')
    if (!row) return
    const key = `${row.dataset.peId}-${row.dataset.setNumber}`
    if (!draftSetValues[key]) draftSetValues[key] = {}

    if (e.target.matches('.set-reps-input')) {
      draftSetValues[key].reps = e.target.value
    } else if (e.target.matches('.set-time-mm, .set-time-ss')) {
      const mmVal = row.querySelector('.set-time-mm').value
      const ssVal = row.querySelector('.set-time-ss').value
      draftSetValues[key].duration = (mmVal === '' && ssVal === '') ? '' : `${mmVal}:${ssVal}`
    } else if (e.target.matches('.set-weight-input')) {
      // Cached in kg (not whatever unit the row happens to be showing
      // right now) so it re-displays correctly if the athlete's default
      // unit changes later - same reasoning as actual_weight itself
      const rowUnit = row.dataset.unit || 'kg'
      draftSetValues[key].weight = e.target.value === '' ? null : weightToKg(parseFloat(e.target.value), rowUnit)
    } else if (e.target.matches('.set-distance-input')) {
      draftSetValues[key].distance = e.target.value
    }
  })
}

function addSetRow(peId) {
  const pe = findPE(peId)
  if (!pe) return
  const rowsContainer = document.getElementById('activeExerciseCard').querySelector('.set-rows')
  // "+ Add Set" isn't offered inside a group step (see renderGroupStep),
  // so this container only ever holds one exercise's own rows now - no
  // exerciseLabel/scoping-within-a-shared-container needed any more
  const ownRows = [...rowsContainer.querySelectorAll(`.set-row[data-pe-id="${peId}"]`)]
  const nextNumber = ownRows.length + 1
  const tracksReps = !pe.exercises || pe.exercises.tracks_reps !== false
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const html = renderSetRow(pe, nextNumber, null, tracksReps, isTimed, tracksWeight, true)
  const lastOwnRow = ownRows[ownRows.length - 1]
  if (lastOwnRow) lastOwnRow.insertAdjacentHTML('afterend', html)
  else rowsContainer.insertAdjacentHTML('beforeend', html)
  extraSetCountByPE[peId] = Math.max(0, nextNumber - (pe.prescribed_sets || 0))
}

// Optimistic UI: the row flips to "checked" instantly, and logSetsByPE
// (the state every render reads from) is updated right away too - not just
// the DOM. Without that second part, swiping to another exercise before a
// slow save finished and then swiping back would re-render this row from
// stale data and show it as unchecked again, even though the tap "worked".
//
// A failed save never reverts what you tapped. It's also durable: every
// check/uncheck is written to a small localStorage queue *before* the
// network call even starts, so if the connection is bad enough that
// saveWithRetry (a few attempts with backoff and a per-attempt timeout)
// exhausts all its attempts - or the tab gets backgrounded/killed by the
// phone mid-retry, which a purely in-memory retry can't survive - the
// pending change is still sitting in the queue. It gets flushed again on
// the next page load and whenever the tab becomes visible again (see
// flushPendingQueue). Only once every attempt (live + later retries) has
// failed does the row get flagged "unsynced", and even then it stays as
// tapped rather than reverting.
// Upsert on (program_exercise_id, date, set_number) - re-checking an
// already-logged set updates it instead of creating a duplicate row.
async function checkSet(peId, setNumber, dateStr, rowEl) {
  const pe = findPE(peId)
  const isTimed = pe.exercises && pe.exercises.is_timed
  const repsInput = rowEl.querySelector('.set-reps-input')
  const mmInput = rowEl.querySelector('.set-time-mm')
  const ssInput = rowEl.querySelector('.set-time-ss')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const distanceInput = rowEl.querySelector('.set-distance-input')
  const actualReps = repsInput ? (repsInput.value.trim() || null) : null
  let actualDuration = null
  if (isTimed) {
    const mm = parseInt(mmInput.value) || 0
    const ss = parseInt(ssInput.value) || 0
    actualDuration = (mm === 0 && ss === 0) ? null : `${mm}:${String(ss).padStart(2, '0')}`
  }
  // Convert whatever unit this row is currently showing back to kg - that's
  // the only thing that ever gets saved
  const rowUnit = rowEl.dataset.unit || 'kg'
  const actualWeight = weightInput ? (weightInput.value ? weightToKg(parseFloat(weightInput.value), rowUnit) : null) : null
  const actualDistance = distanceInput ? (distanceInput.value ? parseFloat(distanceInput.value) : null) : null
  const removedBtn = rowEl.querySelector('.set-remove-btn')

  // This set is now actually saved - the draft (if any) has served its
  // purpose and would otherwise linger and shadow the real logged value on
  // a future re-render
  delete draftSetValues[`${peId}-${setNumber}`]

  rowEl.classList.add('completed')
  rowEl.classList.remove('unsynced')
  if (repsInput) repsInput.disabled = true
  if (isTimed) { mmInput.disabled = true; ssInput.disabled = true }
  if (weightInput) weightInput.disabled = true
  if (distanceInput) distanceInput.disabled = true
  const checkBtn = rowEl.querySelector('.set-check-btn')
  checkBtn.textContent = '✓'
  checkBtn.classList.add('checked')
  checkBtn.title = 'Undo'
  if (removedBtn) removedBtn.remove()
  // Short haptic tap so checking a set is felt, not just seen - much
  // shorter than the rest timer's own 300ms "time's up" buzz (see
  // playRestDoneSound) since this fires constantly through a workout and
  // should read as a light confirmation, not a full alert
  if (navigator.vibrate) navigator.vibrate(30)
  // Inside a group step-through, checking the set auto-advances (straight
  // to the next member, or a rest then the next round) instead of the
  // plain rest-timer-only behavior a normal single exercise gets
  // A rest still running from an earlier set (this exercise's or another's,
  // the timer follows the athlete across swipes) counts as skipped the
  // moment a new set is checked - startRestTimer below then replaces it
  clearRestTimer()
  if (wk.currentSlideContext && wk.currentSlideContext.type === 'group' && wk.currentGroupNav) {
    const { entry, slides, index, sessionPromise, steps, stepIndex } = wk.currentGroupNav
    goToNextGroupStep(entry, dateStr, slides, index, sessionPromise, steps, stepIndex)
  } else {
    maybeStartRestTimer(pe, rowEl)
  }

  const queueEntry = {
    program_exercise_id: peId,
    athlete_id: athlete.id,
    date: dateStr,
    set_number: setNumber,
    actual_reps: actualReps,
    actual_duration: actualDuration,
    actual_weight: actualWeight,
    actual_distance: actualDistance,
    weight_unit: actualWeight != null ? rowUnit : null,
    completed_at: new Date().toISOString(),
    deleted: false
  }

  if (!logSetsByPE[peId]) logSetsByPE[peId] = []
  logSetsByPE[peId] = logSetsByPE[peId].filter(s => s.set_number !== setNumber)
  logSetsByPE[peId].push(queueEntry)

  queueUpsert(queueEntry)
  scheduleFlush()
}

// Same reasoning as checkSet - unchecks immediately, queues + schedules the
// delete, and only flags "unsynced" (staying visually unchecked) if every
// attempt fails, rather than silently snapping back to checked. Never
// auto-advances (only checking does) - but if unchecking the set that just
// started a rest countdown (or a group's between-round rest), that timer
// no longer makes sense, so it's cleared rather than left counting down
// toward an advance the athlete just undid.
function uncheckSet(peId, setNumber, dateStr, rowEl) {
  const pe = findPE(peId)
  const isTimed = pe.exercises && pe.exercises.is_timed
  const repsInput = rowEl.querySelector('.set-reps-input')
  const mmInput = rowEl.querySelector('.set-time-mm')
  const ssInput = rowEl.querySelector('.set-time-ss')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const distanceInput = rowEl.querySelector('.set-distance-input')
  const checkBtn = rowEl.querySelector('.set-check-btn')
  const isExtra = setNumber > (pe.prescribed_sets || 0)

  clearRestTimer()
  rowEl.classList.remove('completed', 'unsynced')
  // Mirror checkSet: each input only exists for the fields this exercise
  // tracks - a row can have reps AND time, or neither (weight-only)
  if (repsInput) repsInput.disabled = false
  if (isTimed) { mmInput.disabled = false; ssInput.disabled = false }
  if (weightInput) weightInput.disabled = false
  if (distanceInput) distanceInput.disabled = false
  checkBtn.textContent = ''
  checkBtn.classList.remove('checked')
  checkBtn.title = 'Mark done'
  if (isExtra && !rowEl.querySelector('.set-remove-btn')) {
    rowEl.insertAdjacentHTML('beforeend', '<button type="button" class="set-remove-btn" data-action="remove-set" title="Remove set">✕</button>')
  }
  logSetsByPE[peId] = (logSetsByPE[peId] || []).filter(s => s.set_number !== setNumber)

  const queueEntry = { program_exercise_id: peId, date: dateStr, set_number: setNumber, deleted: true }
  queueUpsert(queueEntry)
  scheduleFlush()
}
