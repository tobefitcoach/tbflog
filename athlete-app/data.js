// ==========================================================================
// ATHLETE APP - training data
// loadTrainingData() and everything it fills in (the athlete's scheduled
// days, logged sets, sessions, form assignments), plus the live-linked
// workout refresh.
// ==========================================================================
import { supabase } from './athleteClient.js?v=__V__'
import { applyFieldOverrides } from '../shared/exercise-fields.js?v=__V__'
import { fetchAllRows, fetchAllRowsForIds } from '../shared/fetch-all.js?v=__V__'
import { athlete } from './state.js?v=__V__'
import { formatTimedReps, formatWeight, resolveDate } from './format.js?v=__V__'
import { applyPendingQueueLocally, saveWithRetry } from './outbox.js?v=__V__'

export let entriesByDate = {} // 'YYYY-MM-DD' -> array of { program, week, day }
export let logSetsByPE = {} // program_exercise_id -> array of exercise_log_sets rows, sorted by set_number
export let openSessionsByDayId = {} // program_days.id -> in-progress workout_sessions row (ended_at is null)
export let completedSessionsByDayId = {} // program_days.id -> most recently-ended workout_sessions row
export let mobilitySessionsByDate = {} // 'YYYY-MM-DD' -> workout_sessions row with session_type='mobility'
export let formAssignmentsByDate = {} // 'YYYY-MM-DD' -> array of form_assignments rows (joined with forms(name, gate_workout))

// ==========================================================================
// ---- LIVE-LINKED WORKOUTS ----
// A day still tracking a Workout Library Training (source_training_id set -
// see the LIVE-LINKED WORKOUTS block in sql-history.sql) gets refreshed
// here, right after the main load below and before anything renders, so
// Home/Day Preview/Program always reflect the coach's latest edit for any
// day not yet started - a day already started has already detached itself
// (see findOrCreateSession), so this is a no-op for it either way.
// sync_live_training_days does the actual work server-side (the athlete
// client has no read access to trainings/training_exercises at all); this
// just re-fetches whichever days it touched, once.
// ==========================================================================
async function syncLiveTrainingDays(programs) {
  const linkedDayIds = []
  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        if (day.source_training_id) linkedDayIds.push(day.id)
      }
    }
  }
  if (linkedDayIds.length === 0) return

  const { error: syncError } = await saveWithRetry((signal) => supabase.rpc('sync_live_training_days', { p_day_ids: linkedDayIds }).abortSignal(signal))
  if (syncError) { console.log('Error syncing live-linked days:', syncError); return }

  // In batches - the day ids go into the request URL, and the list grows
  // with every live-linked day the athlete has ever had
  const { data: freshExercises, error: fetchError } = await fetchAllRowsForIds(saveWithRetry, linkedDayIds, (batch) => supabase
    .from('program_exercises')
    .select('*, exercises!exercise_id(name, category, type, video_url, foot_contacts, intensity_tier, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
    .in('day_id', batch)
  )
  if (fetchError) { console.log('Error refreshing synced days:', fetchError); return }

  const freshByDayId = {}
  for (const pe of freshExercises) { (freshByDayId[pe.day_id] ||= []).push(pe) }

  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        if (day.source_training_id && freshByDayId[day.id]) {
          day.program_exercises = freshByDayId[day.id]
        }
      }
    }
  }
}

// ==========================================================================
// ---- LOAD TRAINING DATA ----
// One nested query for the whole schedule, one flat query for every set
// this athlete has logged, one for their workout sessions, one for form
// assignments - no date filtering. Each goes through fetchAllRows: a
// regular athlete passes Supabase's 1,000-rows-per-request cap on logged
// sets within a few months, and the rows past it used to just vanish.
// ==========================================================================
export async function loadTrainingData() {
  // These queries don't depend on each other's results, so they fire
  // together instead of waiting on each other one at a time - on a slow
  // connection this also means one retry sequence doesn't delay the start
  // of the other two
  const [
    { data, error },
    { data: logSets, error: logError },
    { data: sessions, error: sessionsError },
    { data: formAssignments, error: formAssignmentsError }
  ] = await Promise.all([
    fetchAllRows(saveWithRetry, () => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises!exercise_id(name, category, type, video_url, foot_contacts, intensity_tier, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance))))')
      .eq('athlete_id', athlete.id)
      .eq('is_template', false)
    ),
    fetchAllRows(saveWithRetry, () => supabase
      .from('exercise_log_sets')
      .select('*')
      .eq('athlete_id', athlete.id)
    ),
    fetchAllRows(saveWithRetry, () => supabase
      .from('workout_sessions')
      .select('*')
      .eq('athlete_id', athlete.id)
    ),
    fetchAllRows(saveWithRetry, () => supabase
      .from('form_assignments')
      .select('*, forms(name, gate_workout)')
      .eq('athlete_id', athlete.id)
    )
  ])

  if (error) { console.log('Error loading training data:', error); return }
  if (logError) { console.log('Error loading logged sets:', logError); return }
  if (sessionsError) { console.log('Error loading sessions:', sessionsError); return }
  if (formAssignmentsError) { console.log('Error loading form assignments:', formAssignmentsError) }

  await syncLiveTrainingDays(data)

  formAssignmentsByDate = {}
  for (const fa of (formAssignments || [])) {
    (formAssignmentsByDate[fa.date] ||= []).push(fa)
  }

  entriesByDate = {}
  for (const program of data) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        day.program_exercises.forEach(applyFieldOverrides)
        const dateStr = day.date_override || resolveDate(program.start_date, week.week_number, day.day_number)
        if (!entriesByDate[dateStr]) entriesByDate[dateStr] = []
        entriesByDate[dateStr].push({ program, week, day })
      }
    }
  }

  logSetsByPE = {}
  for (const row of logSets) {
    if (!logSetsByPE[row.program_exercise_id]) logSetsByPE[row.program_exercise_id] = []
    logSetsByPE[row.program_exercise_id].push(row)
  }
  for (const peId in logSetsByPE) {
    logSetsByPE[peId].sort((a, b) => a.set_number - b.set_number)
  }

  openSessionsByDayId = {}
  completedSessionsByDayId = {}
  mobilitySessionsByDate = {}
  for (const s of sessions) {
    if (s.session_type === 'mobility') {
      mobilitySessionsByDate[s.local_date] = s
      continue
    }
    if (!s.ended_at) {
      openSessionsByDayId[s.program_day_id] = s
      continue
    }
    // Keep the most recently-ended one per day, in case a workout got
    // started and finished more than once for the same day
    const existing = completedSessionsByDayId[s.program_day_id]
    if (!existing || s.ended_at > existing.ended_at) completedSessionsByDayId[s.program_day_id] = s
  }

  // Re-apply anything still waiting in the local outbox on top of the
  // server data just loaded - a set that hasn't synced yet should still
  // show as checked/unchecked after a reload, not silently reset
  applyPendingQueueLocally()
}

// A program_exercise only ever resolves to one calendar date, so scanning
// the in-memory tree by id (instead of an extra query) is enough
export function findPE(peId) {
  for (const dateStr in entriesByDate) {
    for (const entry of entriesByDate[dateStr]) {
      const pe = entry.day.program_exercises.find(p => p.id === peId)
      if (pe) return pe
    }
  }
  return null
}

// "The athlete tapped End Workout" - not a percentage-complete check, so a
// workout finished at 50% goes green on the week strip exactly the same as
// one finished at 100%. A day with more than one scheduled workout only
// counts as done once every one of them (that actually has exercises) has
// been ended, so the checkmark doesn't show early while one is still open.
export function dayIsFullyLogged(entries) {
  const withExercises = entries.filter(entry => entry.day.program_exercises.length > 0)
  if (withExercises.length === 0) return false
  return withExercises.every(entry => !!completedSessionsByDayId[entry.day.id])
}

// The first not-yet-completed gate_workout form assigned to this date, or
// null if there isn't one - a date normally has at most one, but if a
// coach ever assigns two, the workout stays locked until every gating
// form on that day is completed, not just one of them.
export function formsGatingDate(dateStr) {
  return (formAssignmentsByDate[dateStr] || []).find(fa => fa.forms && fa.forms.gate_workout && !fa.completed_at) || null
}

// "12/10/8 reps @ 50kg" when only reps vary across sets, "12@40kg, 10@45kg,
// 8@50kg" for a real pyramid (both reps and weight differ per set). Returns
// null when this exercise has no per-set targets yet, so targetLine() can
// fall back to its old single-value summary for pre-pyramid data. A
// distance-tracking exercise gets a " · 400m" (or per-set "400m/300m")
// suffix appended, independent of the reps/weight branch above it.
export function formatSetTargets(setTargets, isTimed, tracksWeight, tracksDistance) {
  if (!setTargets || setTargets.length === 0) return null
  const unit = athlete.weight_unit || 'kg'
  let text
  if (isTimed && !tracksWeight) {
    text = setTargets.map(s => formatTimedReps(s.reps)).join(' / ')
  } else if (isTimed && tracksWeight) {
    text = setTargets.map(s => `${formatTimedReps(s.reps)}${s.weight != null ? ' @ ' + formatWeight(s.weight, unit) + unit : ''}`).join(', ')
  } else {
    const sameWeight = setTargets.every(s => s.weight === setTargets[0].weight)
    if (sameWeight) {
      const reps = setTargets.map(s => s.reps || '-').join('/')
      text = `${reps} reps${setTargets[0].weight != null ? ' @ ' + formatWeight(setTargets[0].weight, unit) + unit : ''}`
    } else {
      text = setTargets.map(s => `${s.reps || '-'}${s.weight != null ? '@' + formatWeight(s.weight, unit) + unit : ''}`).join(', ')
    }
  }
  if (tracksDistance && setTargets.some(s => s.distance != null)) {
    const sameDistance = setTargets.every(s => s.distance === setTargets[0].distance)
    text += ' · ' + (sameDistance ? `${setTargets[0].distance}m` : setTargets.map(s => s.distance != null ? `${s.distance}m` : '-').join('/'))
  }
  return text
}
