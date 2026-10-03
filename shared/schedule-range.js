// ==========================================================================
// SCHEDULE FOR A DATE RANGE
// One athlete's scheduled days (with their exercises), logged sets and
// sessions between two dates, from the athlete_schedule_range database
// function (see sql-history.sql) - instead of their whole history. Same
// shapes the old queries returned:
//   programs  [program + program_weeks[ week + program_days[ day +
//             program_exercises[ row + exercises{...} ] ] ] ] - only the
//             weeks/days inside the range
//   logSets   exercise_log_sets rows on those days
//   sessions  workout_sessions rows on those days + mobility sessions
// A day with a started-but-unfinished workout is always included.
//
// run      the retry helper, called as run(signal => query) like
//          window.fetchWithRetry / saveWithRetry
// from/to  'YYYY-MM-DD', both inclusive
//
// Returns { programs, logSets, sessions } or { error, missing }. missing is
// true when the function isn't installed yet - the caller then falls back
// to its old full download, so the app works before the SQL is run.
// ==========================================================================
export async function fetchScheduleRange(supabase, run, athleteId, from, to) {
  const { data, error } = await run((signal) => supabase
    .rpc('athlete_schedule_range', { p_athlete_id: athleteId, p_from: from, p_to: to })
    .abortSignal(signal))
  if (error) return { error, missing: error.code === 'PGRST202' }
  return { programs: data.programs, logSets: data.log_sets, sessions: data.sessions }
}
