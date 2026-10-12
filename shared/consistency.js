// ==========================================================================
// CONSISTENCY - the numbers behind "4 weeks in a row" and "26/28 in the
// last 30 days". Pure calculation, no network.
//
// days: one row per calendar day that has coach-scheduled workouts:
//   { date: 'YYYY-MM-DD', scheduled: n, done: n }
//
// Rules
//  - A week (Monday to Sunday) counts when MORE than half of its scheduled
//    workouts are finished (1 of 2 does not, 2 of 3 does).
//  - A week with nothing scheduled is skipped: it neither adds to the
//    streak nor breaks it (a planned rest week is not a failure).
//  - The current week can only add to the streak, never break it - it is
//    not over yet.
//  - The last-30-days figure is workouts finished out of everything that
//    was scheduled in the 30 days up to today. Only days that have already
//    happened count, and today's workout counts only once it is finished,
//    so a day that is not over can never count against the athlete.
// ==========================================================================
import { addDays, parseDateStr, startOfWeek, toDateStr } from './dates.js?v=__V__'

const MAX_WEEKS = 104 // far enough back; a streak this long is shown as-is

function weekKey(dateStr) {
  return toDateStr(startOfWeek(parseDateStr(dateStr)))
}

function weekIsMet(week) {
  return week.scheduled > 0 && week.done * 2 > week.scheduled
}

export function computeConsistency(days, todayStr) {
  const weeks = {}
  let earliest = null
  for (const day of days) {
    const key = weekKey(day.date)
    const week = weeks[key] || (weeks[key] = { scheduled: 0, done: 0 })
    week.scheduled += day.scheduled
    week.done += day.done
    if (earliest === null || key < earliest) earliest = key
  }

  const thisWeekKey = weekKey(todayStr)
  const thisWeek = weeks[thisWeekKey] || { scheduled: 0, done: 0 }
  const thisWeekMet = weekIsMet(thisWeek)

  // Walk back from the current week
  let streakWeeks = 0
  if (earliest !== null) {
    for (let i = 0; i < MAX_WEEKS; i++) {
      const key = toDateStr(addDays(parseDateStr(thisWeekKey), -7 * i))
      if (key < earliest) break
      const week = weeks[key]
      if (!week || week.scheduled === 0) continue
      if (weekIsMet(week)) { streakWeeks++; continue }
      if (i === 0) continue // this week, not finished yet
      break
    }
  }

  const windowStart = toDateStr(addDays(parseDateStr(todayStr), -29))
  let recentScheduled = 0
  let recentDone = 0
  for (const day of days) {
    if (day.date < windowStart || day.date > todayStr) continue
    if (day.date === todayStr) {
      recentScheduled += day.done // today: only what is already finished
    } else {
      recentScheduled += day.scheduled
    }
    recentDone += day.done
  }

  return {
    streakWeeks,
    thisWeek: {
      scheduled: thisWeek.scheduled,
      done: thisWeek.done,
      met: thisWeekMet,
      // Workouts still needed this week for it to count (0 once it does)
      needed: thisWeek.scheduled > 0 && !thisWeekMet ? Math.floor(thisWeek.scheduled / 2) + 1 - thisWeek.done : 0
    },
    recent: { scheduled: recentScheduled, done: recentDone } // last 30 days
  }
}
