// ==========================================================================
// ATHLETE APP - workout: one exercise at a time
// Starting/resuming a workout (session row, slide list, resume point) and
// rendering the active exercise.
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { toDateStr } from '../../shared/dates.js?v=__V__'
import { pageContent, athlete, wk } from '../state.js?v=__V__'
import { logSetsByPE, openSessionsByDayId } from '../data.js?v=__V__'
import { insertOnce, saveWithRetry } from '../outbox.js?v=__V__'
import { markMessagesSeen, showCoachMessagesModal } from '../screens/coach-messages.js?v=__V__'
import { removeEmptyOwnExercise, renderOwnWorkoutAddExercise, renderOwnWorkoutBuilder } from '../screens/own-workout.js?v=__V__'
import { renderGroupGate, renderGroupStep, renderSingleSlideBody } from './group.js?v=__V__'
import { loadLastTime, openExerciseHistoryModal, openSwapModal, renderEndOfWorkoutSlide, swapExercise } from './history.js?v=__V__'
import { wireExerciseCardEvents } from './sets.js?v=__V__'
import { attachSwipeHandlers, mountSlide } from './swipe.js?v=__V__'
import { customAlert } from '../../confirm-modal.js?v=__V__'

// ==========================================================================
// ---- ACTIVE WORKOUT (one exercise at a time) ----
// ==========================================================================
async function findOrCreateSession(programDayId) {
  const { data: existing, error: findError } = await saveWithRetry((signal) => supabase
    .from('workout_sessions')
    .select('*')
    .eq('program_day_id', programDayId)
    .eq('athlete_id', athlete.id)
    .is('ended_at', null)
    .maybeSingle()
    .abortSignal(signal)
  )

  if (findError) { console.log(findError) }
  if (existing) return existing

  // Starting a brand new session for this day - if it was still live-linked
  // to a Workout Library Training (see sql-history.sql's LIVE-LINKED
  // WORKOUTS block), detach it now rather than waiting for the next
  // read-time sync to notice the session and detach it there, so the
  // exercise list can never shift under an active workout. Not awaited-and-
  // blocking on its own error - a failure here just means the next sync
  // catches it instead (sync_live_training_days checks for a session too).
  supabase.from('program_days').update({ source_training_id: null, source_training_synced_at: null }).eq('id', programDayId).then(({ error }) => { if (error) console.log('Error detaching live-link at session start:', error) })

  const { data: newSession, error: insertError } = await insertOnce('workout_sessions',
    { id: crypto.randomUUID(), program_day_id: programDayId, athlete_id: athlete.id, local_date: toDateStr(new Date()) },
    { returnRow: true })

  if (insertError) {
    console.log(insertError)
    // Never let a failed session-creation insert take down the whole
    // workout - this used to throw, which silently killed "End Workout"
    // (the button's own click handler awaits this promise with no
    // try/catch, so the throw just vanished with zero feedback). Sets save
    // independently of this row (they're keyed by program_exercise_id, not
    // session id) - this session object only backs the duration/RPE
    // display, so a local placeholder lets the workout keep working
    // smoothly even when this one insert is down. That session's duration/
    // RPE just won't have a database row to attach to - a much smaller
    // loss than the workout appearing to do nothing.
    return { id: `local-${programDayId}`, program_day_id: programDayId, athlete_id: athlete.id, started_at: new Date().toISOString(), ended_at: null }
  }
  return newSession
}

// Groups a linked group of up to 4 exercises into one merged "slide" - the
// guided view walks slides, not raw exercises, so a group occupies exactly
// one slot wherever its earliest-ordered member falls (the coach doesn't
// need to keep linked exercises adjacent in the list). A section takes
// priority over a superset when an exercise carries both, since the
// section is the broader unit - confirmed a section should use the exact
// same step-through mechanics as a superset, just a different label.
// exercises is already in order_index order by the time this runs, so
// .filter() naturally keeps members in that same order.
export function buildWorkoutSlides(exercises) {
  const slides = []
  const consumed = new Set()
  for (const pe of exercises) {
    if (consumed.has(pe.id)) continue
    const groupId = pe.section_instance_id || pe.superset_group_id
    if (groupId) {
      const members = exercises.filter(x => (x.section_instance_id || x.superset_group_id) === groupId)
      if (members.length > 1) {
        members.forEach(m => consumed.add(m.id))
        slides.push({
          type: 'group',
          groupKind: pe.section_instance_id ? 'section' : 'superset',
          label: pe.section_instance_id ? pe.section_label : null,
          members
        })
        continue
      }
      // no other member in today's exercise list (defensive) - falls
      // through to a normal single slide instead
    }
    slides.push({ type: 'single', pe })
  }
  return slides
}

// The round-robin order a group is stepped through in: every member's
// round 1, then every member's round 2, etc, skipping a member once it
// runs out of sets (a 3-set exercise linked with a 2-set one just stops
// appearing after round 2). Recomputed fresh each time a group is entered/
// re-entered (not cached) since logSetsByPE - and therefore each member's
// count - can change between visits (an athlete-added extra set).
export function buildGroupSteps(members) {
  const info = members.map(pe => ({ pe, count: Math.max(pe.prescribed_sets || 1, (logSetsByPE[pe.id] || []).length) }))
  const rounds = Math.max(...info.map(m => m.count))
  const steps = []
  for (let round = 1; round <= rounds; round++) {
    for (const m of info) {
      if (round <= m.count) steps.push({ pe: m.pe, round })
    }
  }
  return steps
}

function slideIsFullyLogged(slide) {
  const pes = slide.type === 'group' ? slide.members : [slide.pe]
  return pes.every(function(pe) {
    const prescribed = pe.prescribed_sets || 1
    const logged = (logSetsByPE[pe.id] || []).filter(s => s.completed_at && s.set_number <= prescribed)
    return logged.length >= prescribed
  })
}

// Resumes at the first slide whose exercise(s) aren't all logged yet -
// derived from already-loaded logSetsByPE, no extra column needed
function findResumeIndex(slides) {
  for (let i = 0; i < slides.length; i++) {
    if (!slideIsFullyLogged(slides[i])) return i
  }
  return Math.max(slides.length - 1, 0)
}

// Same idea as findResumeIndex, one level down - the first step within a
// group whose specific (exercise, round) set isn't logged yet
function findResumeStepIndex(steps) {
  for (let i = 0; i < steps.length; i++) {
    const { pe, round } = steps[i]
    const logged = (logSetsByPE[pe.id] || []).some(s => s.completed_at && s.set_number === round)
    if (!logged) return i
  }
  return Math.max(steps.length - 1, 0)
}

// Gate for any queued 'before_workout' coach messages - shown once, right
// before Start/Continue Workout actually proceeds (both buttons call this
// same function, see renderDayPreviewGroup's actionButton wiring)
export function startWorkout(entry, dateStr) {
  if (wk.beforeWorkoutMessagesCache.length > 0) {
    const messages = wk.beforeWorkoutMessagesCache
    wk.beforeWorkoutMessagesCache = []
    markMessagesSeen(messages)
    showCoachMessagesModal(messages, function() { proceedToStartWorkout(entry, dateStr) })
    return
  }
  proceedToStartWorkout(entry, dateStr)
}

// Renders the first exercise immediately - findResumeIndex only needs data
// already loaded in memory, no network required. findOrCreateSession does
// need a round trip (look up an in-progress session, or create one), but
// nothing on screen actually needs the session row until End Workout is
// pressed, so it's kicked off in the background instead of being awaited
// here - awaiting it first was the actual cause of "pressing Start Workout
// does nothing for a second or more", especially on a slow connection.
function proceedToStartWorkout(entry, dateStr) {
  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  const isSelfLogged = !!(entry.program && entry.program.created_by_athlete)
  if (exercises.length === 0 && !isSelfLogged) { customAlert('No exercises in this training'); return }

  const sessionPromise = findOrCreateSession(entry.day.id).then(function(session) {
    openSessionsByDayId[entry.day.id] = session
    return session
  })

  // A self-logged workout has no coach-built list to start from - the
  // athlete picks their whole list up front via renderOwnWorkoutBuilder
  if (exercises.length === 0) { renderOwnWorkoutBuilder(entry, dateStr, sessionPromise); return }

  const slides = buildWorkoutSlides(exercises)
  const resumeIndex = findResumeIndex(slides)
  loadLastTime(exercises, dateStr) // not awaited - fills in the "Last time" lines when it lands
  renderActiveExercise(entry, dateStr, slides, resumeIndex, sessionPromise)
}

// direction: 1 when arriving from a Next/swipe-left (new slide enters from
// the right), -1 from Previous/swipe-right (enters from the left), omitted
// for the very first exercise shown (no animation, nothing to slide from)
export function renderActiveExercise(entry, dateStr, slides, index, sessionPromise, direction) {
  const slide = slides[index]

  // A linked group (superset or section) gets its own gate + step-through
  // instead of the single-exercise rendering below - see renderGroupGate/
  // renderGroupStep. A freshly-entered group (nothing logged yet) shows
  // the gate; revisiting a partially- or fully-done group skips straight
  // to where it left off, same "pick up where you left off" principle
  // findResumeIndex already applies one level up.
  if (slide.type === 'group') {
    const steps = buildGroupSteps(slide.members)
    const resumeStep = findResumeStepIndex(steps)
    const anythingLogged = steps.some(s => (logSetsByPE[s.pe.id] || []).some(x => x.completed_at && x.set_number === s.round))
    if (!anythingLogged) renderGroupGate(entry, dateStr, slides, index, sessionPromise, direction)
    else renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, resumeStep, direction)
    return
  }

  nav.enter('workout', { variant: 'activeExercise', entry, dateStr, slides, index, sessionPromise, direction }, { collapse: true, keepRest: true })

  const isLast = index === slides.length - 1
  const isSelfLogged = !!(entry.program && entry.program.created_by_athlete)
  // Coach-assigned workouts get the same "+ Add Exercise" flow as
  // self-logged ones when the coach has turned it on for this athlete -
  // addExerciseToOwnWorkout/removeEmptyOwnExercise are already generic
  // enough (see their comments) that no fork is needed beyond this gate
  const canAddExercises = isSelfLogged || !!athlete.can_add_exercises
  wk.currentSlideContext = slide
  wk.currentGroupNav = null

  pageContent.innerHTML = `
    <div class="workout-active" style="display:none"></div>
    <div class="active-exercise-header-row">
      <p class="active-exercise-progress">Exercise ${index + 1} of ${slides.length}</p>
      ${canAddExercises ? '<button type="button" class="own-add-exercise-btn" id="ownAddExerciseBtn">+ Add Exercise</button>' : ''}
    </div>
    ${renderSingleSlideBody(slide.pe, isSelfLogged)}
    <p class="swipe-hint"><span class="swipe-hint-arrow">‹</span> Swipe for next exercise <span class="swipe-hint-arrow">›</span></p>
    <div id="restTimerBar" class="rest-timer-bar"></div>
  `

  wireExerciseCardEvents('activeExerciseCard', dateStr, canAddExercises ? function(peId) {
    removeEmptyOwnExercise(entry, dateStr, sessionPromise, index, peId)
  } : null)

  const addExerciseBtn = document.getElementById('ownAddExerciseBtn')
  if (addExerciseBtn) {
    addExerciseBtn.addEventListener('click', function() {
      renderOwnWorkoutAddExercise(entry, dateStr, sessionPromise, index)
    })
  }

  // History (every exercise) and Swap (coach-prescribed only, gated inside
  // renderSingleSlideBody) share one delegated listener here rather than
  // folding into wireExerciseCardEvents, since both need entry/slides/
  // index/sessionPromise, which that function doesn't carry
  document.getElementById('activeExerciseCard').addEventListener('click', function(e) {
    const historyBtn = e.target.closest('.exercise-history-btn')
    if (historyBtn) {
      openExerciseHistoryModal(historyBtn.dataset.exerciseId, historyBtn.dataset.exerciseName, !!historyBtn.dataset.tracksReps, !!historyBtn.dataset.isTimed, !!historyBtn.dataset.tracksWeight, !!historyBtn.dataset.tracksDistance)
      return
    }
    const swapBtn = e.target.closest('.exercise-swap-btn')
    if (swapBtn) { openSwapModal(entry, dateStr, slides, index, sessionPromise, swapBtn.dataset.peId) }
    const altBtn = e.target.closest('.exercise-alternative-btn')
    if (altBtn) {
      const pe = entry.day.program_exercises.find(p => p.id === altBtn.dataset.peId)
      if (!pe) return
      const onAlternative = pe.alternative_exercise_id && pe.exercise_id === pe.alternative_exercise_id
      const targetId = onAlternative ? pe.original_exercise_id : pe.alternative_exercise_id
      if (targetId) swapExercise(entry, dateStr, slides, index, sessionPromise, altBtn.dataset.peId, targetId)
    }
  })

  attachSwipeHandlers(
    function onSwipeLeft() {
      if (isLast) renderEndOfWorkoutSlide(entry, dateStr, slides, sessionPromise, 1)
      else renderActiveExercise(entry, dateStr, slides, index + 1, sessionPromise, 1)
    },
    // Passing null (instead of a function that no-ops on index 0) matters:
    // attachSwipeHandlers plays the slide-out-off-screen animation whenever
    // a callback is present at all, whether or not it actually goes
    // anywhere - on the first exercise that meant the card would slide
    // fully off screen and just leave a blank gap, since there's no
    // previous exercise to replace it with.
    index > 0 ? function onSwipeRight() {
      renderActiveExercise(entry, dateStr, slides, index - 1, sessionPromise, -1)
    } : null
  )

  mountSlide(direction)
}
