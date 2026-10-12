// ==========================================================================
// ATHLETE APP - workout: the workout in progress
// One small object that every workout screen (exercise, superset gate and
// step, end-of-workout, add/build exercise) is handed, instead of each one
// taking entry + dateStr + slides + sessionPromise as separate arguments.
//   entry          the calendar entry being done (entry.day.program_exercises)
//   dateStr        the day being logged against
//   sessionPromise resolves to the workout_sessions row (started in the
//                  background - see proceedToStartWorkout)
//   slides         what the swipe view walks (see buildWorkoutSlides); null
//                  until the exercise list is known (own-workout builder)
// Which slide / step is showing is NOT in here - that is the `index` (and
// group `steps` / `stepIndex`) each screen is given next to it.
// ==========================================================================
export function newWorkout(entry, dateStr, sessionPromise, slides = null) {
  return { entry, dateStr, sessionPromise, slides }
}

// Same workout, rebuilt slide list (an exercise was added/removed/swapped in)
export function withSlides(workout, slides) {
  return { ...workout, slides }
}
