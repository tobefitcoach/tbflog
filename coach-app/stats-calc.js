// ==========================================================================
// COACH DASHBOARD — calculations
// Pure functions only (no DOM, no Supabase) so the numbers can be tested
// on their own and screens/stats.js is left to fetch + render.
//
// The definitions deliberately mirror the per-athlete Overview tab in
// screens/athlete-detail.js (loadOverviewStats), so a number here can't
// disagree with the same number on that athlete's own page:
//   - dates are LOCAL YYYY-MM-DD strings (workout_sessions.local_date is
//     written by the athlete's own device, so it's already local)
//   - ACWR = last 7 days' load / (last 28 days' load / 4), load = session
//     RPE x minutes, held back until 28 days of rated-session history exist
//   - completion rate: a scheduled workout is done when at least half its
//     prescribed sets were logged, and today's workout only counts once it's
//     done. That rule needs every logged set, so it runs in the database
//     (coach_completion_stats in sql-history.sql) - this file only sums the
//     per-athlete rows it returns.
// ==========================================================================

export const PRESET_DAYS = { week: 7, month: 30, quarter: 90, half: 180, year: 365 }

export function toDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

export function daysBetween(a, b) {
  return Math.round((parseDateStr(b) - parseDateStr(a)) / 86400000)
}

// range: 'week' | 'month' | 'quarter' | 'half' | 'year' | 'all' | 'custom'
// Rolling windows ending today. The previous period is the same number of
// days immediately before it; 'all' has nothing to compare against.
export function resolveWindow(range, today, custom) {
  const todayStr = toDateStr(today)

  if (range === 'all') {
    return { start: null, end: todayStr, prevStart: null, prevEnd: null, days: null }
  }

  let start, end
  if (range === 'custom') {
    start = custom.start
    end = custom.end > todayStr ? todayStr : custom.end
  } else {
    end = todayStr
    start = toDateStr(addDays(today, -(PRESET_DAYS[range] - 1)))
  }

  const days = daysBetween(start, end) + 1
  const prevEnd = toDateStr(addDays(parseDateStr(start), -1))
  const prevStart = toDateStr(addDays(parseDateStr(prevEnd), -(days - 1)))
  return { start, end, prevStart, prevEnd, days }
}

function sessionMinutes(s) {
  const m = (new Date(s.ended_at) - new Date(s.started_at)) / 60000
  return m > 0 ? m : 0
}

// sessions: finished sessions of either type ({ athlete_id, session_type,
//   local_date, started_at, ended_at }) - fetched over the current window
//   plus the previous one, so this is called twice on the same array.
// Training and mobility are counted separately. Only TRAINING sessions make
// an athlete "active" - a stretching session alone doesn't.
// trackedIds: Set of athlete ids that count (active, not archived)
export function computeWindowStats({ trackedIds, sessions, start, end }) {
  const inRange = d => (start === null || d >= start) && d <= end

  let sessionCount = 0
  let minutes = 0
  let mobilitySessions = 0
  let mobilityMinutes = 0
  const activeAthletes = new Set()
  for (const s of sessions) {
    if (!trackedIds.has(s.athlete_id) || !inRange(s.local_date)) continue
    if (s.session_type === 'mobility') {
      mobilitySessions++
      mobilityMinutes += sessionMinutes(s)
    } else {
      sessionCount++
      minutes += sessionMinutes(s)
      activeAthletes.add(s.athlete_id)
    }
  }

  const tracked = trackedIds.size
  return {
    sessions: sessionCount,
    minutes,
    mobilitySessions,
    mobilityMinutes,
    activeAthletes: activeAthletes.size,
    trackedAthletes: tracked,
    activePct: tracked > 0 ? (activeAthletes.size / tracked) * 100 : null,
  }
}

// rows: what coach_completion_stats returns - one { athlete_id, scheduled,
// completed } per athlete (the counts arrive as strings/bigints, hence Number)
export function sumCompletion(rows, trackedIds) {
  let scheduled = 0
  let completed = 0
  for (const row of rows) {
    if (!trackedIds.has(row.athlete_id)) continue
    scheduled += Number(row.scheduled)
    completed += Number(row.completed)
  }
  return { scheduled, completed, pct: scheduled > 0 ? (completed / scheduled) * 100 : null }
}

// kind 'percent': relative change of a count/total. kind 'points': plain
// difference between two percentages. null when there's nothing to compare.
export function computeDelta(cur, prev, kind) {
  if (cur === null || prev === null || cur === undefined || prev === undefined) return null

  if (kind === 'points') {
    const diff = Math.round(cur - prev)
    if (diff === 0) return { dir: 'flat', text: 'no change' }
    return { dir: diff > 0 ? 'up' : 'down', text: `${Math.abs(diff)} pts` }
  }

  if (prev === 0) return cur === 0 ? { dir: 'flat', text: 'no change' } : { dir: 'up', text: 'from 0' }
  const pct = Math.round(((cur - prev) / prev) * 100)
  if (pct === 0) return { dir: 'flat', text: 'no change' }
  return { dir: pct > 0 ? 'up' : 'down', text: `${Math.abs(pct)}%` }
}

export function formatDuration(totalMinutes) {
  const total = Math.round(totalMinutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, '0')}m`
}

// One row per athlete whose ACWR is outside 0.8-1.5 (the same cut-offs the
// athlete page's ACWR explainer uses). sessions: ANY finished session with a
// session_rpe over roughly the last 90 days, same as loadOverviewStats -
// sessions without a rating are excluded, not treated as 0.
// Worst first: spikes (highest ACWR) before undertrained (lowest ACWR).
export function computeRiskRows({ athletes, sessions, todayStr }) {
  const byAthlete = new Map()
  for (const s of sessions) {
    if (!s.ended_at || s.session_rpe == null) continue
    if (!byAthlete.has(s.athlete_id)) byAthlete.set(s.athlete_id, [])
    byAthlete.get(s.athlete_id).push(s)
  }

  const today = parseDateStr(todayStr)
  const cutoff7 = toDateStr(addDays(today, -6))
  const cutoff28 = toDateStr(addDays(today, -27))
  const rows = []

  for (const athlete of athletes) {
    const list = byAthlete.get(athlete.id)
    if (!list) continue

    const dailyLoad = {}
    for (const s of list) {
      dailyLoad[s.local_date] = (dailyLoad[s.local_date] || 0) + s.session_rpe * sessionMinutes(s)
    }

    // ACWR only means something once there's a real 4-week baseline
    const firstDate = Object.keys(dailyLoad).sort()[0]
    if (daysBetween(firstDate, todayStr) + 1 < 28) continue

    const sum = cutoff => Object.entries(dailyLoad)
      .filter(([d]) => d >= cutoff && d <= todayStr)
      .reduce((total, [, v]) => total + v, 0)

    const acute = sum(cutoff7)
    const chronic = sum(cutoff28) / 4
    if (!(chronic > 0)) continue

    const acwr = acute / chronic
    if (acwr > 1.5) rows.push({ athlete, acwr, acute, chronic, kind: 'spike' })
    else if (acwr < 0.8) rows.push({ athlete, acwr, acute, chronic, kind: 'under' })
  }

  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'spike' ? -1 : 1
    return a.kind === 'spike' ? b.acwr - a.acwr : a.acwr - b.acwr
  })
  return rows
}
