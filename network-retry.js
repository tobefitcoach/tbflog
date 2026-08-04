// ==========================================================================
// NETWORK RETRY
// Wraps a Supabase query with a timeout + automatic retry. Without this, a
// query that hangs or fails on a slow/flaky connection (mobile data,
// especially) just sits there or silently logs an error to the console -
// nothing tells the coach anything went wrong, so a page that failed to
// load looks exactly like a page with no data on it ("my athletes/workouts
// are missing"), when really the request just needs a second try.
//
// Same retry/timeout pattern as the athlete app's own saveWithRetry
// (athlete-app/dashboard.js), pulled out into a shared script here since
// every coach page needs it, not just one - exposed as window.fetchWithRetry
// (same pattern as loading-bar.js patching window.fetch and
// confirm-modal.js exposing window.customConfirm) since each page's own
// script is a separate module with no shared import.
//
// Usage:
//   const { data, error } = await fetchWithRetry((signal) => supabase
//     .from('table').select('*').abortSignal(signal))
//
// Loaded right after confirm-modal.js, before each page's own script.
// ==========================================================================
window.fetchWithRetry = async function(operationFactory, maxAttempts = 3) {
  let result = { data: null, error: null }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(function() { controller.abort() }, 15000)
    try {
      result = await operationFactory(controller.signal)
    } catch (err) {
      result = { data: null, error: err }
    } finally {
      clearTimeout(timeoutId)
    }
    if (!result.error) return result
    if (attempt < maxAttempts) {
      await new Promise(function(resolve) { setTimeout(resolve, attempt * 2000) })
    }
  }
  return result
}
