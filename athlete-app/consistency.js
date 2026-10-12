// ==========================================================================
// ATHLETE APP - consistency streak
// Loads the athlete's scheduled/finished workout counts per day for the past
// year (athlete_consistency, db/changes/0002) and keeps the calculated
// result for Home and the workout summary. Shown only while the coach has
// the athlete's "streak" switch on (athletes.streak_enabled, default on).
//
// Everything here is best effort: any failure just means no streak line.
// Until 0002 is run, the switch column and the function are missing - the
// streak then shows (default on) from the weeks already loaded in memory.
// ==========================================================================
import { supabase } from './athleteClient.js?v=__V__'
import { athlete } from './state.js?v=__V__'
import { entriesByDate, completedSessionsByDayId } from './data.js?v=__V__'
import { saveWithRetry } from './outbox.js?v=__V__'
import { addDays, toDateStr } from '../shared/dates.js?v=__V__'
import { computeConsistency } from '../shared/consistency.js?v=__V__'

export let consistency = null // result of computeConsistency, or null = show nothing

// What the weeks already in memory say, in the same shape as the database
// function returns. A coach-scheduled day with exercises, athlete-made
// programs left out - the same rule as athlete_consistency.
function daysFromMemory() {
  const days = []
  for (const date in entriesByDate) {
    let scheduled = 0
    let done = 0
    for (const entry of entriesByDate[date]) {
      if (entry.program.created_by_athlete) continue
      if (entry.day.program_exercises.length === 0) continue
      scheduled++
      if (completedSessionsByDayId[entry.day.id]) done++
    }
    if (scheduled > 0) days.push({ date, scheduled, done })
  }
  return days
}

async function streakSwitchIsOn() {
  const { data, error } = await saveWithRetry((signal) => supabase
    .from('athletes')
    .select('streak_enabled')
    .eq('id', athlete.id)
    .maybeSingle()
    .abortSignal(signal)
  )
  if (error || !data) return true // column not there yet: default is on
  return data.streak_enabled !== false
}

// Fetches and recalculates. Safe to call again after a workout is finished.
export async function loadConsistency() {
  try {
    if (!(await streakSwitchIsOn())) { consistency = null; return consistency }

    const today = new Date()
    const from = toDateStr(addDays(today, -400))
    const to = toDateStr(addDays(today, 62))
    const { data, error } = await saveWithRetry((signal) => supabase
      .rpc('athlete_consistency', { p_athlete_id: athlete.id, p_from: from, p_to: to })
      .abortSignal(signal)
    )

    let days
    if (error) {
      if (error.code !== 'PGRST202') console.log(error)
      days = daysFromMemory()
    } else {
      days = (data || []).map(r => ({ date: r.day_date, scheduled: r.scheduled, done: r.done }))
    }
    consistency = computeConsistency(days, toDateStr(today))
  } catch (err) {
    console.log(err)
    consistency = null
  }
  return consistency
}

// The two pieces of the Home header, each '' when there is nothing to say:
//   number - the streak as a big figure to the right of the greeting
//   bar    - the last 30 days (finished out of scheduled) under it
export function consistencyHeaderParts() {
  if (!consistency) return { number: '', bar: '' }
  const weeks = consistency.streakWeeks
  const number = weeks > 0
    ? `<div class="streak-number"><b>${weeks}</b><span>week${weeks === 1 ? '' : 's'} in a row</span></div>`
    : ''

  const { done, scheduled } = consistency.recent
  let bar = ''
  if (scheduled > 0) {
    const pct = Math.min(100, Math.round((done / scheduled) * 100))
    bar = `
      <div class="month-progress" role="img" aria-label="${done} of ${scheduled} scheduled workouts done in the last 30 days">
        <div class="month-progress-track"><i style="width:${pct}%"></i></div>
        <span class="month-progress-label">${done}/${scheduled} in the last 30 days</span>
      </div>`
  }
  return { number, bar }
}

// One sentence for the end-of-workout screen, or '' for nothing
export function consistencySummaryText() {
  if (!consistency) return ''
  const { streakWeeks, thisWeek } = consistency
  if (thisWeek.met && streakWeeks > 0) {
    return `That's ${streakWeeks} week${streakWeeks === 1 ? '' : 's'} in a row`
  }
  if (thisWeek.needed > 0) {
    const n = thisWeek.needed
    return `${n} more workout${n === 1 ? '' : 's'} this week to ${streakWeeks > 0 ? 'keep your streak' : 'start a streak'}`
  }
  return ''
}
