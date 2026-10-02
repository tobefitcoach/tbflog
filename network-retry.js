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
// (athlete-app/outbox.js), pulled out into a shared script here since
// every coach page needs it, not just one - exposed as window.fetchWithRetry
// (same pattern as loading-bar.js patching window.fetch and
// confirm-modal.js exposing window.customConfirm) since each page's own
// script is a separate module with no shared import.
//
// Usage:
//   const { data, error } = await fetchWithRetry((signal) => supabase
//     .from('table').select('*').abortSignal(signal))
//
// Optional third argument: an AbortSignal (the coach app passes the
// screen's ctx.signal). Once it fires, the request in flight is cancelled
// and no further attempts are made - the screen that wanted it is gone.
//
// Loaded right after confirm-modal.js, before each page's own script.
// ==========================================================================
window.fetchWithRetry = async function(operationFactory, maxAttempts = 3, outerSignal) {
  let result = { data: null, error: null }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (outerSignal?.aborted) return { data: null, error: new DOMException('Screen left', 'AbortError') }
    const controller = new AbortController()
    const timeoutId = setTimeout(function() { controller.abort() }, 15000)
    const onOuterAbort = function() { controller.abort() }
    outerSignal?.addEventListener('abort', onOuterAbort)
    try {
      result = await operationFactory(controller.signal)
    } catch (err) {
      result = { data: null, error: err }
    } finally {
      clearTimeout(timeoutId)
      outerSignal?.removeEventListener('abort', onOuterAbort)
    }
    if (!result.error) return result
    if (attempt < maxAttempts && !outerSignal?.aborted) {
      await new Promise(function(resolve) { setTimeout(resolve, attempt * 2000) })
    }
  }
  return result
}
