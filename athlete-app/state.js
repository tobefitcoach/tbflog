// ==========================================================================
// ATHLETE APP - shared state
// The handful of values that many files read but only a few change.
//
// Plain exports (read them as `athlete`, `pageContent`, ...) are set only
// through the setters below, from dashboard.js - an imported binding can't
// be assigned from another file. `wk` holds the in-progress workout bits
// that several workout files both read and write (wk.currentSlideContext,
// ...).
//
// Data owned by one area lives with that area instead: training data in
// data.js, tournaments in screens/tournaments.js, mobility caches in
// screens/mobility.js, and so on.
// ==========================================================================

// Static page elements from dashboard.html - every screen paints into
// pageContent; the other two are only restyled by the Home screen
export const pageContent = document.getElementById('pageContent')
export const pageWrap = document.querySelector('.athlete-app-page')
export const cardWrap = document.querySelector('.athlete-app-card')

// The signed-in Supabase session, read once at startup in dashboard.js
export let session = null
// The athletes row for the signed-in athlete, set by checkAccountState()
export let athlete = null
// fetched once in enterWeekView() - coach's global "feature is ready"
// on/off, ANDed with the per-athlete athlete.mobility_enabled toggle to
// decide whether the mobility tile actually shows
export let coachMobilityEnabled = true
// Bumped by every workout-slide render (see teardownScreen's keepRest) so a
// rest can tell whether the athlete is still on the screen it started on
export let workoutScreenSeq = 0

export function setSession(value) { session = value }
export function setAthlete(value) { athlete = value }
export function setCoachMobilityEnabled(value) { coachMobilityEnabled = value }
export function bumpWorkoutScreenSeq() { workoutScreenSeq++ }

export const wk = {
  // Set on every renderActiveExercise call (single or superset), read by
  // maybeStartRestTimer to decide whether the checked exercise is the FIRST
  // or SECOND member of a linked pair. Not reset anywhere else on purpose -
  // checkSet can only ever fire while a guided slide's DOM (and its
  // wireExerciseCardEvents listener) exists, and that DOM is only ever
  // created by renderActiveExercise / renderGroupStep, which always set this
  // first - so it's impossible for a stale value to be read.
  currentSlideContext: null,

  // Set only while inside a group's step-through (renderGroupStep), read by
  // checkSet's auto-advance branch - checkSet only ever receives peId/
  // setNumber/dateStr/rowEl (see wireExerciseCardEvents), so this is how it
  // reaches entry/slides/index/sessionPromise/steps/stepIndex without
  // threading five new parameters through every intermediate call site.
  // Same lifecycle guarantee as currentSlideContext above.
  currentGroupNav: null,

  // Coach messages to show right before the athlete's next workout -
  // loaded by loadCoachMessages(), shown and cleared by startWorkout()
  // (see screens/coach-messages.js)
  beforeWorkoutMessagesCache: [],

  // The swipe listeners on the page area (see workout/swipe.js). pageContent
  // is persistent across renders (only its innerHTML gets replaced), so
  // listeners there must be explicitly torn down before attaching a fresh
  // set on the next render, or they'd pile up and old renders' stale
  // closures would keep firing alongside it.
  swipeCleanup: null,
}
