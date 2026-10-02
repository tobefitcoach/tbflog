// ==========================================================================
// ATHLETE APP - workout: PR detection
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import { toDateStr, addDays } from '../../shared/dates.js?v=__V__'
import { fetchAllRows } from '../../shared/fetch-all.js?v=__V__'
import { entriesByDate, logSetsByPE } from '../data.js?v=__V__'
import { formatPRBadgeValue } from '../screens/stats.js?v=__V__'

// ==========================================================================
// ---- PR DETECTION ----
// Compares this session against every EARLIER session logged for the
// same underlying exercise (matched by exercise_id, so history carries
// across different programs/weeks a coach has assigned it in - not just
// program_exercise_id, which is a new row every time it's reprogrammed).
// ==========================================================================

// Epley formula - the standard estimated-1RM most lifting apps use, since
// it fairly compares a heavy low-rep set against a lighter high-rep set,
// which comparing raw heaviest weight alone can't do
function estimatedOneRM(weight, reps) {
  return weight * (1 + reps / 30)
}

// One session's aggregate stats for one exercise, from its completed sets
export function sessionExerciseStats(sets) {
  let volume = 0, totalReps = 0, maxWeight = 0, maxOneRM = 0
  for (const s of sets) {
    const reps = parseInt(s.actual_reps)
    const hasReps = !isNaN(reps)
    if (hasReps) totalReps += reps
    if (s.actual_weight != null) {
      if (s.actual_weight > maxWeight) maxWeight = s.actual_weight
      if (hasReps) {
        volume += reps * s.actual_weight
        const oneRM = estimatedOneRM(s.actual_weight, reps)
        if (oneRM > maxOneRM) maxOneRM = oneRM
      }
    }
  }
  return { volume, totalReps, maxWeight, maxOneRM, setCount: sets.length }
}

export async function loadAndRenderPRBadges(session, entry) {
  const exerciseIds = [...new Set(entry.day.program_exercises.map(pe => pe.exercise_id))]
  if (exerciseIds.length === 0) return

  // Every completed set this athlete has ever logged on one of today's
  // exercises, in any program/week (RLS scopes it to their own). One joined
  // query, paged - it used to fetch every matching program_exercises id
  // first and send that list in the URL, which overflowed it (and hit the
  // 1,000-row cap) for athletes with a long history.
  const { data: pastSets, error: setsError } = await fetchAllRows(fetchWithRetry, () => supabase
    .from('exercise_log_sets')
    .select('*, program_exercises!inner(exercise_id)')
    .in('program_exercises.exercise_id', exerciseIds)
    .not('completed_at', 'is', null)
  )
  if (setsError) { console.log(setsError); return }

  // One bucket per (exercise_id, date) - a proxy for "one session", the
  // same date-based grouping this app already uses elsewhere (there's no
  // workout_sessions link on exercise_log_sets to group by directly)
  const buckets = {}
  for (const s of pastSets) {
    const exerciseId = s.program_exercises.exercise_id
    const key = `${exerciseId}|${s.date}`
    if (!buckets[key]) buckets[key] = []
    buckets[key].push(s)
  }

  const todayStr = session.local_date

  for (const pe of entry.day.program_exercises) {
    const todayKey = `${pe.exercise_id}|${todayStr}`
    const todaySets = buckets[todayKey] || []
    if (todaySets.length === 0) continue
    const todayStats = sessionExerciseStats(todaySets)

    let bestVolume = 0, bestReps = 0, bestWeight = 0, bestOneRM = 0, bestSets = 0
    let hasHistory = false
    for (const key in buckets) {
      if (key === todayKey || !key.startsWith(pe.exercise_id + '|')) continue
      // Only sessions BEFORE this one count as "the best to beat" - a later
      // session (re-opening an older workout's summary) must not take this
      // one's PR away
      if (key.slice(key.indexOf('|') + 1) >= todayStr) continue
      hasHistory = true
      const stats = sessionExerciseStats(buckets[key])
      bestVolume = Math.max(bestVolume, stats.volume)
      bestReps = Math.max(bestReps, stats.totalReps)
      bestWeight = Math.max(bestWeight, stats.maxWeight)
      bestOneRM = Math.max(bestOneRM, stats.maxOneRM)
      bestSets = Math.max(bestSets, stats.setCount)
    }
    // Nothing to beat yet - a first-time exercise isn't a PR
    if (!hasHistory) continue

    // before/after/isWeight let the badge show the actual numbers, not just
    // that a PR happened - same shape + formatPRBadgeValue() the Weekly
    // Stats view's own PR list already uses (see computeWeekPREvents)
    const badges = []
    if (todayStats.volume > bestVolume) badges.push({ type: 'volume', label: 'Volume PR', before: bestVolume, after: todayStats.volume, isWeight: true })
    if (todayStats.maxWeight > bestWeight) badges.push({ type: 'weight', label: 'Weight PR', before: bestWeight, after: todayStats.maxWeight, isWeight: true })
    if (todayStats.totalReps > bestReps) badges.push({ type: 'reps', label: 'Reps PR', before: bestReps, after: todayStats.totalReps, isWeight: false })
    if (todayStats.setCount > bestSets) badges.push({ type: 'sets', label: 'Sets PR', before: bestSets, after: todayStats.setCount, isWeight: false })
    if (todayStats.maxOneRM > bestOneRM) badges.push({ type: 'onerm', label: 'Est. 1RM PR', before: bestOneRM, after: todayStats.maxOneRM, isWeight: true })
    if (badges.length === 0) continue

    const container = document.getElementById(`prBadges-${pe.id}`)
    if (container) container.innerHTML = badges.map(b => `
      <span class="pr-badge pr-badge-${b.type}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg> ${b.label}: ${formatPRBadgeValue(b.before, b.isWeight)} → ${formatPRBadgeValue(b.after, b.isWeight)}</span>
    `).join('')
  }
}

// Same bucket-by-(exercise_id, date) + beat-your-own-best comparison as
// loadAndRenderPRBadges above, generalized from "today" to any 7-day
// window and run entirely off data already in entriesByDate/logSetsByPE
// (loadTrainingData's queries are unbounded) instead of a fresh network
// query - used by the Weekly Stats view (computeWeekRecap) to report which
// PRs, if any, were set during a picked past week
export function computeWeekPREvents(weekStart) {
  const buckets = {}
  for (const dateStr in entriesByDate) {
    for (const entry of entriesByDate[dateStr]) {
      for (const pe of entry.day.program_exercises) {
        const sets = (logSetsByPE[pe.id] || []).filter(s => s.completed_at)
        if (sets.length === 0) continue
        const key = `${pe.exercise_id}|${dateStr}`
        if (!buckets[key]) buckets[key] = { exerciseId: pe.exercise_id, exerciseName: pe.exercises ? pe.exercises.name : 'Exercise', date: dateStr, sets: [] }
        buckets[key].sets.push(...sets)
      }
    }
  }

  const weekDateStrs = new Set()
  for (let i = 0; i < 7; i++) weekDateStrs.add(toDateStr(addDays(weekStart, i)))

  const events = []
  for (const key in buckets) {
    const bucket = buckets[key]
    if (!weekDateStrs.has(bucket.date)) continue
    const stats = sessionExerciseStats(bucket.sets)

    let bestVolume = 0, bestReps = 0, bestWeight = 0, bestOneRM = 0, bestSets = 0, hasHistory = false
    for (const otherKey in buckets) {
      if (otherKey === key || !otherKey.startsWith(bucket.exerciseId + '|')) continue
      // Only earlier sessions: a PR set in a past week stays a PR in that
      // week's stats even after the athlete beats it later
      if (buckets[otherKey].date >= bucket.date) continue
      hasHistory = true
      const otherStats = sessionExerciseStats(buckets[otherKey].sets)
      bestVolume = Math.max(bestVolume, otherStats.volume)
      bestReps = Math.max(bestReps, otherStats.totalReps)
      bestWeight = Math.max(bestWeight, otherStats.maxWeight)
      bestOneRM = Math.max(bestOneRM, otherStats.maxOneRM)
      bestSets = Math.max(bestSets, otherStats.setCount)
    }
    if (!hasHistory) continue

    const badges = []
    if (stats.volume > bestVolume) badges.push({ label: 'Volume PR', before: bestVolume, after: stats.volume, isWeight: true })
    if (stats.maxWeight > bestWeight) badges.push({ label: 'Weight PR', before: bestWeight, after: stats.maxWeight, isWeight: true })
    if (stats.totalReps > bestReps) badges.push({ label: 'Reps PR', before: bestReps, after: stats.totalReps, isWeight: false })
    if (stats.setCount > bestSets) badges.push({ label: 'Sets PR', before: bestSets, after: stats.setCount, isWeight: false })
    if (stats.maxOneRM > bestOneRM) badges.push({ label: 'Est. 1RM PR', before: bestOneRM, after: stats.maxOneRM, isWeight: true })
    if (badges.length === 0) continue

    events.push({ exerciseName: bucket.exerciseName, date: bucket.date, badges })
  }
  return events.sort((a, b) => a.date.localeCompare(b.date))
}
