// ==========================================================================
// ATHLETE APP - workout: last time, exercise history, swap exercise,
// and the end-of-workout slide.
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { toDateStr, parseDateStr } from '../../shared/dates.js?v=__V__'
import { fetchAllRows } from '../../shared/fetch-all.js?v=__V__'
import { pageContent, athlete } from '../state.js?v=__V__'
import { formatShortDate, formatTimedReps, formatWeight } from '../format.js?v=__V__'
import { loadExerciseLibrary, wireExercisePicker } from '../screens/own-workout.js?v=__V__'
import { renderActiveExercise } from './active.js?v=__V__'
import { sessionExerciseStats } from './prs.js?v=__V__'
import { attachSwipeHandlers, finishWorkout, mountSlide } from './swipe.js?v=__V__'
import { customAlert } from '../../confirm-modal.js?v=__V__'
import { fetchWithRetry } from '../../network-retry.js?v=__V__'

// ==========================================================================
// ---- EXERCISE HISTORY ----
// Every exercise gets this, unconditionally - shows the athlete's own past
// logged sets for this exercise (matched by exercise_id, so it carries
// across different programs/weeks, same convention loadAndRenderPRBadges
// already uses), most recent session first, set-by-set - seeing "80kg x8,
// 80kg x7, 75kg x10" is what actually answers "what should I load today,"
// not just one aggregate number.
// ==========================================================================
async function loadExerciseHistory(exerciseId, months) {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)

  // One joined query, paged - same reason as loadAndRenderPRBadges: the old
  // "fetch every program_exercises id, then send them all in the URL" grew
  // with the athlete's history until the request failed
  const { data: sets, error: setsError } = await fetchAllRows(fetchWithRetry, () => supabase
    .from('exercise_log_sets')
    .select('*, program_exercises!inner(exercise_id)')
    .eq('program_exercises.exercise_id', exerciseId)
    .not('completed_at', 'is', null)
    .gte('date', toDateStr(cutoff))
  )
  if (setsError) { console.log(setsError); return null }

  const byDate = {}
  for (const s of sets) {
    if (!byDate[s.date]) byDate[s.date] = []
    byDate[s.date].push(s)
  }

  // Most recent first - bounded by the chosen time window, not a hard cap
  return Object.keys(byDate)
    .sort((a, b) => b.localeCompare(a))
    .map(date => ({
      date,
      sets: byDate[date].sort((a, b) => a.set_number - b.set_number),
      stats: sessionExerciseStats(byDate[date])
    }))
}

let exerciseHistoryState = { exerciseId: null, tracksReps: true, isTimed: false, tracksWeight: true, tracksDistance: false, months: 3 }

export async function openExerciseHistoryModal(exerciseId, exerciseName, tracksReps, isTimed, tracksWeight, tracksDistance) {
  exerciseHistoryState = { exerciseId, tracksReps, isTimed, tracksWeight, tracksDistance, months: 3 }
  document.getElementById('exerciseHistoryTitle').textContent = exerciseName || 'History'
  document.querySelectorAll('#exerciseHistoryTimeFilters .time-filter-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.months === '3')
  })
  document.getElementById('exerciseHistoryModal').classList.add('active')
  await renderExerciseHistoryBody()
}

async function renderExerciseHistoryBody() {
  const { exerciseId, tracksReps, isTimed, tracksWeight, tracksDistance, months } = exerciseHistoryState
  const body = document.getElementById('exerciseHistoryBody')
  body.innerHTML = '<p class="no-metrics">Loading...</p>'

  const history = await loadExerciseHistory(exerciseId, months)
  if (!document.getElementById('exerciseHistoryModal').classList.contains('active')) return // closed while loading
  if (exerciseHistoryState.exerciseId !== exerciseId) return // a different exercise/filter was opened while this was loading

  if (history === null) { body.innerHTML = '<p class="no-metrics">Something went wrong loading history - check your connection and try again</p>'; return }
  if (history.length === 0) { body.innerHTML = `<p class="no-metrics">No history in the last ${months} month${months > 1 ? 's' : ''}</p>`; return }

  body.innerHTML = history.map(function(day) {
    const setsLine = day.sets.map(function(s) {
      // Reps and duration are independent now - show whichever this
      // exercise actually tracks, joined together when both are on.
      // Legacy rows (before the two were split) stored the duration in
      // actual_reps, so that's the fallback source when reps isn't tracked.
      const repsParts = []
      if (tracksReps) repsParts.push(`${s.actual_reps || '-'} reps`)
      if (isTimed) {
        const durationSource = s.actual_duration != null ? s.actual_duration : (!tracksReps ? s.actual_reps : null)
        if (durationSource != null) repsParts.push(formatTimedReps(durationSource))
      }
      const repsText = repsParts.join(' · ')
      // Uses the unit THIS set was actually logged in (falls back to kg -
      // the real stored unit - for older rows saved before weight_unit
      // existed), not the athlete's current default, so switching your
      // default unit later doesn't silently reconvert past history
      const setUnit = s.weight_unit || 'kg'
      const weightText = tracksWeight && s.actual_weight != null ? ' @ ' + formatWeight(s.actual_weight, setUnit) + setUnit : ''
      const distanceText = tracksDistance && s.actual_distance != null ? ` · ${s.actual_distance}m` : ''
      return `<li class="detail-row"><span>Set ${s.set_number}</span><span class="detail-row-value">${repsText}${weightText}${distanceText}</span></li>`
    }).join('')
    const volumeText = tracksWeight && day.stats.volume > 0 ? ` · ${Math.round(formatWeight(day.stats.volume, athlete.weight_unit))}${athlete.weight_unit || 'kg'} total` : ''
    return `
      <div class="detail-group">
        <h4 class="detail-group-title">${formatShortDate(parseDateStr(day.date))}${volumeText}</h4>
        <ul class="detail-list">${setsLine}</ul>
      </div>
    `
  }).join('')
}

// Exercise History modal: time filters + close. Called once from
// dashboard.js at startup.
export function wireExerciseHistoryModal() {
  document.getElementById('exerciseHistoryTimeFilters').addEventListener('click', function(e) {
    const btn = e.target.closest('.time-filter-btn')
    if (!btn) return
    document.querySelectorAll('#exerciseHistoryTimeFilters .time-filter-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    exerciseHistoryState.months = parseInt(btn.dataset.months)
    renderExerciseHistoryBody()
  })

  document.getElementById('closeExerciseHistoryBtn').addEventListener('click', function() {
    document.getElementById('exerciseHistoryModal').classList.remove('active')
  })
}

// ==========================================================================
// ---- SWAP EXERCISE ----
// Substitutes a different exercise from the library into an existing
// program_exercises row - keeps the same prescribed sets/reps/weight/rest,
// just changes which exercise fills the slot. Only reachable when
// canSwapExercise allowed the button to render in the first place (coach-
// prescribed, athlete.can_change_exercises on, nothing logged yet).
// ==========================================================================
export function openSwapModal(w, index, peId) {
  document.getElementById('exerciseSwapModal').classList.add('active')
  document.getElementById('exerciseSwapSearchInput').value = ''

  loadExerciseLibrary().then(function(library) {
    if (library === null) return
    if (!document.getElementById('exerciseSwapModal').classList.contains('active')) return // closed before this resolved

    wireExercisePicker(
      document.getElementById('exerciseSwapSearchInput'),
      document.getElementById('exerciseSwapList'),
      library,
      function(newExerciseId) {
        swapExercise(w, index, peId, newExerciseId)
      }
    )
  })
}

// Swap Exercise modal close. Called once from dashboard.js at startup.
export function wireExerciseSwapModal() {
  document.getElementById('closeExerciseSwapBtn').addEventListener('click', function() {
    document.getElementById('exerciseSwapModal').classList.remove('active')
  })
}

export async function swapExercise(w, index, peId, newExerciseId) {
  const pe = w.entry.day.program_exercises.find(p => p.id === peId)
  if (!pe) return

  const { data, error } = await supabase
    .from('program_exercises')
    .update({
      exercise_id: newExerciseId,
      swapped_by_athlete: true,
      original_exercise_id: pe.original_exercise_id || pe.exercise_id,
      // Any field override was pinned for the OLD exercise - carrying it
      // over to whatever the athlete just swapped in wouldn't make sense
      tracks_weight_override: null,
      is_timed_override: null,
      is_unilateral_override: null,
      tracks_distance_override: null
    })
    .eq('id', peId)
    .select('*, exercises!exercise_id(name, category, type, video_url, foot_contacts, intensity_tier, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
    .single()

  if (error) { console.log(error); customAlert('Something went wrong swapping that exercise - please try again'); return }

  Object.assign(pe, data)
  document.getElementById('exerciseSwapModal').classList.remove('active')
  // Slide objects hold references to the same pe object mutated above, so
  // re-rendering the current slide is enough - no need to rebuild slides
  renderActiveExercise(w, index)
}

// Reached by pressing Next (or swiping left) on the last exercise - the
// only place "End Workout" lives now, instead of a persistent link on
// every slide
export function renderEndOfWorkoutSlide(w, direction) {
  nav.enter('workout', { variant: 'endOfWorkout', workout: w, direction }, { collapse: true, keepRest: true })

  pageContent.innerHTML = `
    <div class="workout-active" style="display:none"></div>
    <p class="active-exercise-progress">Workout Complete</p>
    <div class="workout-summary workout-slide">
      <h2>Nice work 💪</h2>
      <p style="color:var(--c-text-muted)">That's every exercise. Ready to finish up?</p>
      <button class="btn-save start-workout-btn" id="endWorkoutBtn">End Workout</button>
    </div>
    <p class="swipe-hint"><span class="swipe-hint-arrow">‹</span> Swipe to go back</p>
    <div id="restTimerBar" class="rest-timer-bar"></div>
  `

  document.getElementById('endWorkoutBtn').addEventListener('click', function() {
    finishWorkout(w.entry, w.sessionPromise)
  })

  attachSwipeHandlers(
    null, // already the last slide, nothing to swipe forward to
    function onSwipeRight() {
      renderActiveExercise(w, w.slides.length - 1, -1)
    }
  )

  mountSlide(direction)
}
