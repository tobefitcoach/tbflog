// ==========================================================================
// ATHLETE APP - workout: superset / section step-through
// plus the exercise slide body every workout screen renders
// (renderSingleSlideBody).
// ==========================================================================
import * as nav from '../nav.js?v=__V__'
import { getYouTubeThumbnail } from '../../shared/video.js?v=__V__'
import { pageContent, athlete, wk } from '../state.js?v=__V__'
import { logSetsByPE } from '../data.js?v=__V__'
import { buildGroupSteps, renderActiveExercise } from './active.js?v=__V__'
import { lastTimeLineHtml, openExerciseHistoryModal, renderEndOfWorkoutSlide } from './history.js?v=__V__'
import { startRestTimer } from './rest-timer.js?v=__V__'
import { extraSetCountByPE, renderSetRow, wireExerciseCardEvents } from './sets.js?v=__V__'
import { attachSwipeHandlers, mountSlide } from './swipe.js?v=__V__'

// ==========================================================================
// ---- GROUP STEP-THROUGH (superset / section) ----
// A linked group is done as one continuous round-robin sequence instead of
// a single merged card: "Start Superset/Section" gate, then exercise 1's
// set 1, exercise 2's set 1, ... straight through with no pause, a rest
// only once every member has done that round, then the next round starts
// automatically. See buildGroupSteps for the exact step order.
// ==========================================================================
export function renderGroupGate(entry, dateStr, slides, index, sessionPromise, direction) {
  nav.enter('workout', { variant: 'groupGate', entry, dateStr, slides, index, sessionPromise, direction }, { collapse: true, keepRest: true })

  const slide = slides[index]
  wk.currentSlideContext = slide
  wk.currentGroupNav = null

  const kindLabel = slide.groupKind === 'section' ? 'Section' : 'Superset'
  const title = slide.label || (slide.groupKind === 'section' ? 'Section' : 'Superset')

  pageContent.innerHTML = `
    <div class="workout-active" style="display:none"></div>
    <div class="active-exercise-header-row">
      <p class="active-exercise-progress">Exercise ${index + 1} of ${slides.length}</p>
    </div>
    <div id="activeExerciseCard" class="workout-slide group-gate">
      <p class="group-gate-kind">${kindLabel}</p>
      <h2 class="group-gate-title">${title}</h2>
      <p class="group-gate-desc">${slide.members.length} exercises, back to back</p>
      <div class="group-gate-list">
        ${slide.members.map(function(pe) {
          const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
          const thumb = getYouTubeThumbnail(videoUrl)
          return `
            <div class="group-gate-item">
              <span class="group-gate-item-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg>'}</span>
              <span>${pe.exercises ? pe.exercises.name : 'Exercise'}</span>
            </div>
          `
        }).join('')}
      </div>
      <button type="button" class="btn-save start-workout-btn" id="groupStartBtn">▶ Start ${slide.groupKind === 'section' ? 'Section' : 'Superset'}</button>
    </div>
    <p class="swipe-hint"><span class="swipe-hint-arrow">‹</span> Swipe for next exercise <span class="swipe-hint-arrow">›</span></p>
    <div id="restTimerBar" class="rest-timer-bar"></div>
  `

  const steps = buildGroupSteps(slide.members)
  document.getElementById('groupStartBtn').addEventListener('click', function() {
    renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, 0, 1)
  })

  attachSwipeHandlers(
    function onSwipeLeft() {
      renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, 0, 1)
    },
    index > 0 ? function onSwipeRight() {
      renderActiveExercise(entry, dateStr, slides, index - 1, sessionPromise, -1)
    } : null
  )

  mountSlide(direction)
}

export function renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, stepIndex, direction) {
  nav.enter('workout', { variant: 'groupStep', entry, dateStr, slides, index, sessionPromise, steps, stepIndex, direction }, { collapse: true, keepRest: true })

  const slide = slides[index]
  const { pe, round } = steps[stepIndex]
  const tracksReps = !pe.exercises || pe.exercises.tracks_reps !== false
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const logged = (logSetsByPE[pe.id] || []).find(s => s.set_number === round)
  const isSelfLogged = !!(entry.program && entry.program.created_by_athlete)
  wk.currentSlideContext = slide
  wk.currentGroupNav = { entry, dateStr, slides, index, sessionPromise, steps, stepIndex }

  const rounds = Math.max(...steps.map(s => s.round))

  pageContent.innerHTML = `
    <div class="workout-active" style="display:none"></div>
    <div class="active-exercise-header-row">
      <p class="active-exercise-progress">Exercise ${index + 1} of ${slides.length} · Round ${round} of ${rounds}</p>
    </div>
    <div id="activeExerciseCard" class="workout-slide">
      <button type="button" class="active-exercise-thumb" data-video-url="${videoUrl}" ${videoUrl ? '' : 'disabled'}>
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="active-exercise-thumb-placeholder"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
      </button>
      <div class="active-exercise-title-row">
        <div class="active-exercise-title">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${exerciseActionButtonsHtml(pe, isSelfLogged, true)}
      </div>
      ${pe.notes ? `<p class="exercise-log-notes">${pe.notes}</p>` : ''}
      ${lastTimeLineHtml(pe)}
      <div class="set-rows">${renderSetRow(pe, round, logged, tracksReps, isTimed, tracksWeight, false)}</div>
    </div>
    <p class="swipe-hint"><span class="swipe-hint-arrow">‹</span> Swipe to skip <span class="swipe-hint-arrow">›</span></p>
    <div id="restTimerBar" class="rest-timer-bar"></div>
  `

  wireExerciseCardEvents('activeExerciseCard', dateStr, null)

  document.getElementById('activeExerciseCard').addEventListener('click', function(e) {
    const historyBtn = e.target.closest('.exercise-history-btn')
    if (historyBtn) {
      openExerciseHistoryModal(historyBtn.dataset.exerciseId, historyBtn.dataset.exerciseName, !!historyBtn.dataset.tracksReps, !!historyBtn.dataset.isTimed, !!historyBtn.dataset.tracksWeight, !!historyBtn.dataset.tracksDistance)
    }
    // No Swap inside a group step - swapping one exercise mid-round has no
    // clean "which round does the new exercise start at" answer, so
    // exerciseActionButtonsHtml is told (via its 3rd arg) never to render
    // the Swap button here at all
  })

  attachSwipeHandlers(
    function onSwipeLeft() {
      // Swiping is always "move on", and a rest already counting down just
      // keeps going on the next slide. Without skipRest, goToNextGroupStep
      // at the end of a round starts a rest timer instead of advancing -
      // the card slid off screen, the timer restarted from full, and
      // nothing replaced the card.
      goToNextGroupStep(entry, dateStr, slides, index, sessionPromise, steps, stepIndex, true)
    },
    function onSwipeRight() {
      if (stepIndex === 0) renderGroupGate(entry, dateStr, slides, index, sessionPromise, -1)
      else renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, stepIndex - 1, -1)
    }
  )

  mountSlide(direction)
}

// Shared by checkSet's auto-advance and the manual swipe-left "skip"
// fallback - decides whether the next step is later in the same round
// (advance immediately, no rest), the start of a new round (rest first,
// using the round's last-ordered member's rest_seconds/target - same rule
// this app already used for supersets before this rework), or past the
// end of the group (hand off to the normal top-level next-slide/
// end-of-workout flow). skipRest (swipe-left) skips
// the rest pause and always advances.
export function goToNextGroupStep(entry, dateStr, slides, index, sessionPromise, steps, stepIndex, skipRest) {
  const next = stepIndex + 1
  if (next >= steps.length) {
    const isLast = index === slides.length - 1
    if (isLast) renderEndOfWorkoutSlide(entry, dateStr, slides, sessionPromise, 1)
    else renderActiveExercise(entry, dateStr, slides, index + 1, sessionPromise, 1)
    return
  }

  const finishedRound = steps[stepIndex].round
  const enteringNewRound = steps[next].round !== finishedRound
  if (!enteringNewRound) {
    renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, next, 1)
    return
  }

  const lastMemberOfRound = steps[stepIndex].pe
  const target = lastMemberOfRound.set_targets && lastMemberOfRound.set_targets[finishedRound - 1]
  const restSeconds = target && target.rest != null ? target.rest : lastMemberOfRound.rest_seconds
  if (restSeconds && !skipRest) {
    startRestTimer(restSeconds, function() {
      renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, next, 1)
    })
  } else {
    renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, next, 1)
  }
}

// Swap only makes sense on a still-unstarted, coach-prescribed exercise -
// once a set's logged, swapping would orphan it under the wrong exercise
// (exercise_log_sets links by program_exercise_id, not exercise_id), and an
// exercise the athlete already added/self-logged is already fully theirs
// to remove and re-add instead.
function canSwapExercise(pe, isSelfLogged) {
  if (isSelfLogged || pe.added_by_athlete || !athlete.can_change_exercises) return false
  return (logSetsByPE[pe.id] || []).every(s => !s.completed_at)
}

// History is unconditional (every exercise); Swap only shows when
// canSwapExercise allows it.
// hideSwap: true inside a group step (see renderGroupStep) - swapping one
// exercise mid-round has no clean "which round does the replacement start
// at" answer, so Swap is only ever offered outside a group's step-through
function exerciseActionButtonsHtml(pe, isSelfLogged, hideSwap) {
  const name = pe.exercises ? pe.exercises.name : 'Exercise'
  const tracksReps = !pe.exercises || pe.exercises.tracks_reps !== false
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const tracksDistance = pe.exercises && pe.exercises.tracks_distance
  // Coach-curated single fallback (set via Workout Builder's kebab menu) -
  // a quick one-tap alternative for "can't do this / no equipment",
  // distinct from the free-search Swap button below. Same gating as Swap
  // (canSwapExercise/hideSwap) - once a set's logged, switching would
  // orphan it, and mid-round in a group has no clean answer either.
  const onAlternative = pe.alternative_exercise_id && pe.exercise_id === pe.alternative_exercise_id
  const showAlternative = !hideSwap && pe.alternative_exercise_id && canSwapExercise(pe, isSelfLogged)
  return `
    <div class="exercise-action-btns">
      <button type="button" class="exercise-history-btn" data-action="history" data-exercise-id="${pe.exercise_id}" data-exercise-name="${name}" data-tracks-reps="${tracksReps ? '1' : ''}" data-is-timed="${isTimed ? '1' : ''}" data-tracks-weight="${tracksWeight ? '1' : ''}" data-tracks-distance="${tracksDistance ? '1' : ''}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg> History</button>
      ${showAlternative ? `<button type="button" class="exercise-alternative-btn" data-action="use-alternative" data-pe-id="${pe.id}" title="${onAlternative ? 'Switch back to the original exercise' : "Can't do this one? Switch to the alternative"}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg> ${onAlternative ? 'Original' : 'Alternative'}</button>` : ''}
      ${!hideSwap && canSwapExercise(pe, isSelfLogged) ? `<button type="button" class="exercise-swap-btn" data-action="swap" data-pe-id="${pe.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg> Swap</button>` : ''}
    </div>
  `
}

// A normal, ungrouped exercise's slide - takes isSelfLogged so it can gate
// the Swap button. A linked group (superset/section) never reaches this -
// see renderGroupGate/renderGroupStep instead.
export function renderSingleSlideBody(pe, isSelfLogged) {
  const tracksReps = !pe.exercises || pe.exercises.tracks_reps !== false
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)

  const loggedSets = logSetsByPE[pe.id] || []
  const rowCount = Math.max(pe.prescribed_sets || 1, loggedSets.length, (pe.prescribed_sets || 0) + (extraSetCountByPE[pe.id] || 0))
  let rowsHtml = ''
  for (let setNumber = 1; setNumber <= rowCount; setNumber++) {
    const logged = loggedSets.find(s => s.set_number === setNumber)
    const isExtra = setNumber > (pe.prescribed_sets || 0)
    rowsHtml += renderSetRow(pe, setNumber, logged, tracksReps, isTimed, tracksWeight, isExtra)
  }

  return `
    <div id="activeExerciseCard" class="workout-slide">
      <button type="button" class="active-exercise-thumb" data-video-url="${videoUrl}" ${videoUrl ? '' : 'disabled'}>
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="active-exercise-thumb-placeholder"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
      </button>
      ${pe.section_label ? `<p class="active-exercise-section-label">${pe.section_label}</p>` : ''}
      <div class="active-exercise-title-row">
        <div class="active-exercise-title">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${exerciseActionButtonsHtml(pe, isSelfLogged)}
      </div>
      ${pe.notes ? `<p class="exercise-log-notes">${pe.notes}</p>` : ''}
      ${lastTimeLineHtml(pe)}
      <div class="set-rows">${rowsHtml}</div>
      <button type="button" class="add-set-btn" data-action="add-set" data-pe-id="${pe.id}">+ Add Set</button>
    </div>
  `
}
