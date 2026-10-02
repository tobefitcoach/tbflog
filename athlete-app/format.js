// ==========================================================================
// ATHLETE APP - formatting helpers
// Date display, week-day names, weight units (kg/lbs), time parsing, and the
// shared icon/description constants.
// ==========================================================================
import { toDateStr, parseDateStr } from '../shared/dates.js?v=__V__'

// Chevron icons for the round .icon-btn buttons (back + week navigation) -
// same stroke style as the other inline icons in this file
export const CHEVRON_LEFT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>'
export const CHEVRON_RIGHT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>'
// Session RPE (1-10, modified Borg CR-10 scale) - this exact scale is what
// Training Load's session_rpe x duration_minutes formula (loadOverviewStats,
// athlete.js) and ACWR/monotony/strain are built on, so these anchors are
// meant to match how those numbers are already interpreted, not just be
// friendly-sounding text. Shown live under the RPE buttons (both here and
// in renderWorkoutSummary) so tapping a number confirms what it means
// instead of the athlete guessing.
export const RPE_DESCRIPTIONS = {
  1: 'Very light - minimal effort',
  2: 'Light - easy, comfortable',
  3: 'Light-moderate - noticeable but sustainable',
  4: 'Moderate - working, steady effort',
  5: 'Moderate-hard - pushing, needs focus',
  6: 'Hard - challenging, effort building',
  7: 'Very hard - strong effort, fatigue setting in',
  8: 'Very hard - close to your limit',
  9: 'Extremely hard - almost everything you had',
  10: 'Maximal - absolute max, nothing left'
}

// ==========================================================================
// ---- DATE HELPERS ----
// Same timezone-safe parsing convention used throughout the app
// (new Date(dateStr + 'T00:00:00')) - building YYYY-MM-DD strings by hand
// rather than via .toISOString(), which re-introduces an off-by-one bug.
// ==========================================================================

export function formatDisplayDate(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatShortDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function resolveDate(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStr(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStr(result)
}

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const WORKOUT_TYPE_LABELS_ATH = { gym: 'Gym', field: 'Field', run: 'Run' }
// Shapes for the week-strip's per-workout icon (see renderWeekView) -
// stroke style matches every other small icon already in this file
export const WORKOUT_TYPE_ICON_SVG = {
  gym: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="9" width="3" height="6" rx="1"></rect><rect x="20" y="9" width="3" height="6" rx="1"></rect><line x1="4" y1="12" x2="20" y2="12"></line><rect x="6" y="7" width="2" height="10" rx="1"></rect><rect x="16" y="7" width="2" height="10" rx="1"></rect></svg>',
  field: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l3 2"></path><path d="M9 2h6"></path><path d="M12 2v3"></path></svg>',
  run: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="17" cy="4" r="2"></circle><path d="M10 22l2-6 3 2 2-6"></path><path d="M6 13l3-3 4 1 3-4"></path><path d="M4 22l3-5"></path></svg>'
}

export function trainingDisplayName(entry) {
  if (entry.program.is_adhoc) return entry.program.name || 'Training'
  return entry.day.label || ('Day ' + entry.day.day_number)
}

// ==========================================================================
// ---- WEIGHT UNITS ----
// Weight is always STORED in kg (the app-wide metric-units rule) - these
// only convert for display/typing. kgToLbs/lbsToKg are the raw conversion,
// formatWeight is what render code should call: converts kg into whichever
// unit it's given and rounds to 1 decimal so the input doesn't fill up with
// long floating-point tails (e.g. 100kg -> 220.5 lbs, not 220.46226218).
// ==========================================================================
function kgToLbs(kg) { return kg * 2.2046226218 }
function lbsToKg(lbs) { return lbs / 2.2046226218 }

export function formatWeight(kg, unit) {
  if (kg == null) return null
  const val = unit === 'lbs' ? kgToLbs(kg) : kg
  return Math.round(val * 10) / 10
}

// The inverse of formatWeight - what a set row uses to turn a typed number
// (in whatever unit that row is currently set to) back into kg before it's
// ever saved, so the database never has to know a set was entered in lbs
export function weightToKg(value, unit) {
  return unit === 'lbs' ? lbsToKg(value) : value
}

// A timed set's reps field is free text (the athlete could type "45", "45s",
// "1 min", etc) - only append "sec" when it's a plain number, so we don't
// double up on a unit the athlete already typed themselves
export function formatTimedReps(val) {
  if (!val && val !== 0) return '-'
  return /^\d+(\.\d+)?$/.test(String(val).trim()) ? `${val} sec` : val
}

// Splits any previously-stored timed value into {mm, ss} so the mm:ss input
// boxes can be prefilled - handles the new "M:SS" format this app now
// saves, old plain-seconds strings ("45") from before this change, and a
// best-effort digit grab for anything else free-typed in the past ("45s")
export function parseTimeToParts(val) {
  if (val == null || val === '') return { mm: 0, ss: 0 }
  const str = String(val).trim()
  const mmss = str.match(/^(\d+):(\d{1,2})$/)
  if (mmss) return { mm: parseInt(mmss[1]), ss: Math.min(parseInt(mmss[2]), 59) }
  if (/^\d+$/.test(str)) {
    const total = parseInt(str)
    return { mm: Math.floor(total / 60), ss: total % 60 }
  }
  const digits = str.match(/\d+/)
  return digits ? { mm: 0, ss: Math.min(parseInt(digits[0]), 59) } : { mm: 0, ss: 0 }
}
