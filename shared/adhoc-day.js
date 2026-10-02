// ==========================================================================
// NEW WORKOUT ON A DATE
// A workout that isn't part of an assigned program - the athlete logging
// their own, or the coach's "+" / copy-to-date on the calendar - is three
// rows: a program, its week 1 and its day 1. create_adhoc_day (see
// sql-history.sql) makes all three in one database step, so a dropped
// connection can't leave a half-made workout behind.
//
//   const { dayId, error } = await createAdHocDay(supabase, {
//     coachId, athleteId, date, name, workoutType, createdByAthlete })
//
// If the function isn't installed yet (PGRST202), it falls back to the
// old three separate inserts so nothing breaks before the SQL is run.
// ==========================================================================
export async function createAdHocDay(supabase, { coachId, athleteId, date, name, workoutType = null, createdByAthlete = false }) {
  const { data: dayId, error } = await supabase.rpc('create_adhoc_day', {
    p_coach_id: coachId,
    p_athlete_id: athleteId,
    p_date: date,
    p_name: name,
    p_workout_type: workoutType,
    p_created_by_athlete: createdByAthlete
  })
  if (!error) return { dayId, error: null }
  if (error.code !== 'PGRST202') return { dayId: null, error }

  // Not installed yet - the old way, one row at a time
  const program = { coach_id: coachId, athlete_id: athleteId, is_template: false, is_adhoc: true, start_date: date, name }
  if (createdByAthlete) program.created_by_athlete = true
  const { data: newProgram, error: programError } = await supabase.from('programs').insert([program]).select()
  if (programError) return { dayId: null, error: programError }
  const { data: newWeek, error: weekError } = await supabase.from('program_weeks').insert([{ program_id: newProgram[0].id, week_number: 1 }]).select()
  if (weekError) return { dayId: null, error: weekError }
  const { data: newDay, error: dayError } = await supabase.from('program_days').insert([{ week_id: newWeek[0].id, day_number: 1, workout_type: workoutType }]).select()
  if (dayError) return { dayId: null, error: dayError }
  return { dayId: newDay[0].id, error: null }
}
