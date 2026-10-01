// ==========================================================================
// shared/exercise-fields.js - per-workout "Adjust Fields" overrides.
//
// tracks_weight/is_timed/is_unilateral/tracks_distance normally come from
// the exercise's own row (row.exercises). An explicit *_override on a
// workout's exercise row (training_exercises, section_exercises or
// program_exercises - set via a card's "Adjust Fields") takes precedence
// for that one workout. Merging it into row.exercises once per fetch means
// every later read of row.exercises.* sees the effective value.
// ==========================================================================

export function applyFieldOverrides(row) {
  if (!row.exercises) return
  if (row.tracks_weight_override != null) row.exercises.tracks_weight = row.tracks_weight_override
  if (row.is_timed_override != null) row.exercises.is_timed = row.is_timed_override
  if (row.is_unilateral_override != null) row.exercises.is_unilateral = row.is_unilateral_override
  if (row.tracks_distance_override != null) row.exercises.tracks_distance = row.tracks_distance_override
}
