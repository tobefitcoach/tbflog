// ==========================================================================
// TRAINING LOAD — Foster's session-RPE method, in one place
// Used by the athlete page's Overview tab (screens/athlete-detail/overview.js)
// and the Stats screen's load-risk list (stats-calc.js), so the same athlete
// can't get two different ACWRs. The Athletes list gets its ACWR from the
// coach_athlete_card_stats SQL function (sql-history.sql), which follows the
// same rules - change them there too.
//
//   - load = session_rpe x minutes, summed per LOCAL date (local_date is
//     written by the athlete's own device). Sessions with no rating are
//     left out, not counted as 0.
//   - acute = last 7 days' load, chronic = last 28 days' load / 4
//   - ACWR is held back (null) until 28 days of rated history exist: with
//     less, the 28-day sum divided by 4 understates the baseline and
//     inflates the ratio.
// Pure functions - no DOM, no Supabase.
// ==========================================================================

import { toDateStr, parseDateStr, addDays } from '../shared/dates.js?v=__V__'

export function sessionMinutes(s) {
  const m = (new Date(s.ended_at) - new Date(s.started_at)) / 60000
  return m > 0 ? m : 0
}

// sessions: finished sessions ({ local_date, started_at, ended_at, session_rpe })
// -> { 'YYYY-MM-DD': summed load that day }
export function dailyLoadByDate(sessions) {
  const dailyLoad = {}
  for (const s of sessions) {
    if (!s.ended_at || s.session_rpe == null) continue
    dailyLoad[s.local_date] = (dailyLoad[s.local_date] || 0) + s.session_rpe * sessionMinutes(s)
  }
  return dailyLoad
}

// Sum of the last `days` days' load, today included
export function loadSum(dailyLoad, days, todayStr) {
  const cutoff = toDateStr(addDays(parseDateStr(todayStr), -(days - 1)))
  return Object.entries(dailyLoad)
    .filter(([d]) => d >= cutoff && d <= todayStr)
    .reduce((sum, [, v]) => sum + v, 0)
}

// -> { acute, chronic, acwr, daysOfHistory, enoughHistory }
// chronic is 0 and acwr null until enoughHistory (28 days since the first
// rated session); acwr is also null when chronic is 0.
export function computeAcwr(dailyLoad, todayStr) {
  const firstDate = Object.keys(dailyLoad).sort()[0]
  const daysOfHistory = firstDate
    ? Math.round((parseDateStr(todayStr) - parseDateStr(firstDate)) / 86400000) + 1
    : 0
  const enoughHistory = daysOfHistory >= 28
  const acute = loadSum(dailyLoad, 7, todayStr)
  const chronic = enoughHistory ? loadSum(dailyLoad, 28, todayStr) / 4 : 0
  const acwr = enoughHistory && chronic > 0 ? acute / chronic : null
  return { acute, chronic, acwr, daysOfHistory, enoughHistory }
}
