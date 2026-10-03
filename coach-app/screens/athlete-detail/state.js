// ==========================================================================
// ATHLETE DETAIL - shared state
// Everything this screen remembers between function calls, in one place.
//
// Four screen-wide values are plain exports (read them as `root`,
// `athleteId`, ...). Only index.js sets them, through setScreen() and
// setCurrentAthlete(), because an imported binding can't be assigned from
// another file.
//
// Everything else is grouped by the tab that owns it - ov (Overview),
// met (Metrics), rep (PDF report), cal (Calendar), ui (screen-wide bits) -
// and read and written as ov.volumeChart, cal.currentViewYear, ...
// resetState() puts every group back to its starting values; unmount()
// calls it so nothing from one athlete leaks into the next visit.
// ==========================================================================

// The page container this screen paints into
export let root = null
// The mount's nav token. Read by every background load (loadOverviewStats,
// loadRecentActivity, the Metrics/Calendar lazy-tab loads, ...) after its
// own await, same isCurrent(token) guard every other screen uses - a slow
// response landing after the coach has navigated away (back to Athletes, or
// into a different athlete entirely) must never repaint over whatever
// screen is showing by then.
export let mountToken = null
// athleteId comes from params.id - the exact key athletes.js's
// createAthleteCard passes to go('athlete-detail', { id: athlete.id }).
export let athleteId = null
// Most recently loaded athletes row - read by the status badge, the invite
// actions, the edit-info modal's prefill, and the PDF report's header
export let currentAthlete = null

export function setScreen(next) {
  root = next.root
  mountToken = next.mountToken
  athleteId = next.athleteId
}

export function setCurrentAthlete(row) {
  currentAthlete = row
}

function initialUi() {
  return {
    toastHideTimer: null, // see showToast() in toast.js
  }
}

function initialOverview() {
  return {
    // ---- Refresh guard ----
    // This tab otherwise only loads stats once, on open - a coach watching
    // an athlete log a workout live would never see it update without a
    // manual reload. The Refresh button covers "check right now"; the
    // visibilitychange listener (wired in mount()) covers "I switched back
    // to this tab".
    //
    // Both are guarded: overviewLoadInFlight stops an overlapping call from
    // firing a second, competing round of the same 3 queries (the exact
    // mistake that caused the athlete-side statement-timeout bug).
    // lastOverviewAutoRefresh additionally throttles the visibilitychange
    // trigger - flipping back and forth to another tab shouldn't re-fire
    // the stats every single time. The Refresh button ignores that
    // cooldown - tapping it is explicit intent.
    overviewLoadInFlight: false,
    lastOverviewAutoRefresh: 0,

    // ---- Overview stats (loadOverviewStats fills these in; read by the
    // duration/volume/4 training-load detail modals) ----
    volumeChart: null,
    volumeChartData: { labels: [], values: [] },
    durationEvents: [], // { dateStr, name, minutes }
    last7DailyLoad: [], // { dateStr, load }, oldest first
    acuteLoadValue: 0,
    chronicLoadValue: 0,
    acwrValue: null,
    monotonyValue: null,
    strainValue: null,
    daysOfLoadHistoryValue: 0, // how many days back the earliest rated session goes

    // ---- Athlete Notes ----
    currentNoteEntry: null,

    // ---- Bodyweight ----
    bodyweightChart: null,
    bodyweightUnit: 'kg',
    currentBWEntry: null,
  }
}

function initialMetrics() {
  return {
    currentMetric: null,
    allMetrics: [],
    athleteMetrics: [],
    prEvents: [], // PRs broken in the last 30 days, filled in by loadStatsBar, read by the PR overview modal
    allMeasurementsCache: [], // every measurement for this athlete, filled in by loadStatsBar, read by the stats-bar detail modals
    metricsLoaded: false, // Metrics tab loads its data lazily - see bindTabs()

    // ---- Graph Modal ----
    fullChart: null,
    currentGraphMetric: null,
    currentGraphMonths: 1, // remembers the active time filter, so the bodyweight toggle can redraw without needing it passed in again
    showBodyweightOverlay: false,

    // ---- Entries Modal ----
    currentEditEntry: null,
    currentEntriesMetric: null,

    // ---- Last Updated modal pagination ----
    recentActivityPage: 0,

    // Chart.js instances for the per-metric mini graphs in renderMetrics().
    // The screen can be torn down without a full page reload, so these are
    // tracked and destroyed in unmount().
    miniChartInstances: [],
  }
}

function initialReport() {
  // Filled in fresh every time the Report Builder modal opens (no saved template)
  return {
    reportDataCache: null,
    reportSelectedSections: new Set(),
    reportSelectedMonths: 3,
  }
}

function initialCalendar() {
  return {
    calendarEntriesByDate: {}, // 'YYYY-MM-DD' -> array of { program, week, day }
    sessionByDayId: {}, // program_days.id -> the workout_sessions row to show (in-progress wins over done, done wins over older done), absent = not started yet
    logSetsByPECal: {}, // program_exercise_id -> array of exercise_log_sets rows, sorted by set_number
    mobilityEntriesByDateCal: {}, // 'YYYY-MM-DD' -> workout_sessions row with session_type='mobility'
    tournamentsByDateCal: {}, // 'YYYY-MM-DD' -> tournaments row (athlete-added, read-only here)
    formAssignmentsByDateCal: {}, // 'YYYY-MM-DD' -> array of form_assignments rows (joined with forms(name, gate_workout))
    monthCache: {}, // 'YYYY-M' -> { at, promise } - recently loaded months, see loadCalendarMonth
    calendarLoaded: false,
    currentDayDateForModal: null, // date currently shown in the day-detail modal

    // Seeded fresh in mount() (not from a module-level "today") so every
    // visit to this screen opens on the real current month - this module is
    // imported once per app session, so a value set at import time would
    // freeze the calendar on whatever date the session started.
    currentViewYear: null,
    currentViewMonth: null,

    currentDayDateForAddTraining: null, // remembered so "+ New Training" can come back to the same day's popup afterward

    // Which ad-hoc day findOrCreateAdHocDay should reuse, scoped to THIS
    // popup session only - see findOrCreateAdHocDay's own comment
    adHocDayIdForThisSession: null,
    adHocDayDateForThisSession: null,

    // Cached lists for the add popup
    cachedTrainings: null,
    cachedTemplates: null,
    selectedTrainingId: null,
    selectedTrainingName: null,
    cachedTrainingExercises: {}, // training_id -> exercises array
    selectedTemplateId: null,
    totalProgramDays: 1,
    programStartDay: 1,
    programEndDay: 1,
    cachedTemplateDays: {}, // template_id -> { days, totalWeeks }
    dayPickerTarget: null, // 'start' | 'end'
    dayPickerPage: 0,

    // ---- Arm-and-drop copying (and, via copyArmedIsMove, moving) ----
    copyArmedMode: null, // 'week' | 'workout' | null
    copyArmedIsMove: false, // true = relocate the source day instead of cloning it; only ever paired with copyArmedMode 'workout'
    copyArmedSourceDayId: null,
    copyArmedSourceName: null,
    copyArmedSourceMonday: null,
    copyArmedSourceWeek: null, // week-copy: [[{ dayId, name }], ...] for Mon..Sun, taken when armed - see armCopyWeek
    copyArmedHoverKey: null,

    // ---- Section tab ----
    cachedSectionsCal: null,
    selectedSectionIdCal: null,
    selectedSectionNameCal: null,
    cachedSectionExercisesCal: {},

    // ---- Form tab ----
    cachedFormsCal: null,
    selectedFormIdCal: null,
    cachedFormQuestionsCal: {},

    // 'new-training': building a fresh Workout Library entry from the
    // day-add popup's "+ New" - Done goes back to that popup so the new one
    // can be selected. 'edit-day': adjusting an already-scheduled day's
    // exercises straight from its own calendar badge - Done just closes and
    // refreshes the month, there's no popup to return to.
    trainingBuilderOverlayMode: 'new-training',
  }
}

export const ui = initialUi()
export const ov = initialOverview()
export const met = initialMetrics()
export const rep = initialReport()
export const cal = initialCalendar()

export function resetState() {
  root = null
  mountToken = null
  athleteId = null
  currentAthlete = null
  Object.assign(ui, initialUi())
  Object.assign(ov, initialOverview())
  Object.assign(met, initialMetrics())
  Object.assign(rep, initialReport())
  Object.assign(cal, initialCalendar())
}
