// ==========================================================================
// shared/dates.js - calendar-date helpers for both apps.
//
// Dates in this app are LOCAL calendar days stored as 'YYYY-MM-DD' strings
// (workout dates, measurement dates, local_date). Always convert with these,
// never `date.toISOString().slice(0, 10)` - that's the UTC date, which is
// already tomorrow from the evening onward west of Greenwich, so "last 30
// days" style cutoffs would shift by a day.
// ==========================================================================

// Date -> 'YYYY-MM-DD' in local time
export function toDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 'YYYY-MM-DD' -> Date at local midnight
export function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// New Date n calendar days later (negative = earlier); DST-safe
export function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

// Monday 00:00 of the week containing date
export function startOfWeek(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day // shift back to Monday
  d.setDate(d.getDate() + diff)
  return d
}
