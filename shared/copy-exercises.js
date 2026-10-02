// ==========================================================================
// shared/copy-exercises.js - the one way the coach app copies exercises.
// Wraps the copy_exercises database function (sql-history.sql), which does
// the column list, the superset / section id remapping and the ordering in
// one transaction, so every copy path carries exactly the same fields.
// ==========================================================================

// Copies a Workout ('training'), Section ('section') or day ('day') onto a
// Workout ('training') or day ('day'), appended after what's already there.
//   baseOrder    - first order_index to use; null = after the last exercise
//   sectionLabel - the label a copied Section's block gets
//   select       - columns to read the new rows back with (e.g. joined
//                  exercise details); leave out to get just {id, order_index}
// Returns { data, error } like a Supabase query - data is the new rows.
export async function copyExercises(supabase, { from, fromId, to, toId, baseOrder = null, sectionLabel = null, select = null }) {
  const { data, error } = await supabase.rpc('copy_exercises', {
    p_source_kind: from, p_source_id: fromId,
    p_target_kind: to, p_target_id: toId,
    p_base_order: baseOrder, p_section_label: sectionLabel
  })
  if (error) return { data: null, error }
  if (!select || data.length === 0) return { data, error: null }
  return supabase
    .from(to === 'day' ? 'program_exercises' : 'training_exercises')
    .select(select)
    .in('id', data.map(r => r.id))
    .order('order_index')
}
