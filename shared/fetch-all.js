// ==========================================================================
// FETCH ALL ROWS
// Supabase (PostgREST) returns at most 1,000 rows per request and quietly
// drops the rest - no error, the list just stops. Any query whose result
// can grow past that (an athlete's logged sets, a roster's month of
// training) goes through here: it asks for one page at a time until a page
// comes back short.
//
// PAGE_SIZE must match the project's API row cap (Supabase dashboard >
// Settings > API > Max rows, default 1,000). If that's ever LOWERED, lower
// this too - a full page under the cap would look like the last page.
//
//   const { data, error } = await fetchAllRows(fetchWithRetry,
//     () => supabase.from('exercise_log_sets').select('*').eq('athlete_id', id))
//
// run          the retry helper to send each page through - called as
//              run(signal => query) like fetchWithRetry / saveWithRetry
// buildQuery   returns a fresh, unsent query each time (filters + select,
//              no range); any .order() it sets is kept and id is added as
//              the final tie-break, so a page boundary can't skip or repeat
//              a row
//
// Returns { data, error } like a single query. On an error the rows
// fetched so far are discarded: a partial list is exactly the silent
// failure this exists to prevent.
// ==========================================================================
const PAGE_SIZE = 1000

// For a query that was sent once, without retries: fetchAllRows(runOnce, ...)
export const runOnce = (factory) => factory(undefined)

export async function fetchAllRows(run, buildQuery) {
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await run((signal) => buildQuery()
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
      .abortSignal(signal))
    if (error) return { data: null, error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) return { data: rows, error: null }
    from += PAGE_SIZE
  }
}

// For a filter on a list of ids (.in('day_id', ids)): every id goes into
// the request URL, so a long list makes the URL too long for the server.
// Splits the ids into batches, fetches every row for each batch (paged as
// above), and joins the results.
const ID_BATCH_SIZE = 100

export async function fetchAllRowsForIds(run, ids, buildQuery) {
  const rows = []
  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    const batch = ids.slice(i, i + ID_BATCH_SIZE)
    const { data, error } = await fetchAllRows(run, () => buildQuery(batch))
    if (error) return { data: null, error }
    rows.push(...data)
  }
  return { data: rows, error: null }
}
