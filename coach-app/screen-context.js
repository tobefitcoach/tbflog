// ==========================================================================
// SCREEN CONTEXT
// The router builds one of these for every mount and hands it to the
// screen as mount()'s third argument. Everything a screen sets up through
// it is torn down by the router when the screen goes away, so a screen
// can't forget to:
//   - remove a document/window listener (each visit would add another live
//     copy - kebab menus closing twice, Escape firing twice, ...)
//   - clear a timer
//   - stop a request still downloading for a screen nobody is looking at
//
//   ctx.token          nav token for this mount (nav.isCurrent(ctx.token))
//   ctx.alive()        true while this mount is still the screen showing
//   ctx.signal         aborted when the screen goes away
//   ctx.on(t, ev, fn)  addEventListener, removed automatically on leave
//   ctx.timeout(fn,ms) setTimeout, cleared automatically on leave
//   ctx.fetch(factory) fetchWithRetry, cancelled on leave
//
// Listeners on elements INSIDE the screen don't need ctx.on - they're
// thrown away with the screen's HTML. Only document, window,
// visualViewport and the page container itself (which outlives every
// screen) need it.
// ==========================================================================
import * as nav from './nav.js?v=__V__'
import { fetchWithRetry } from '../network-retry.js?v=__V__'

export function createScreenContext(token) {
  const controller = new AbortController()
  const cleanups = []

  return {
    token,
    signal: controller.signal,
    // Checks the signal too: the router disposes the old screen BEFORE the
    // next one's nav.enter, so for a moment the old token is still current
    // while its cancelled requests are already returning errors.
    alive() {
      return !controller.signal.aborted && nav.isCurrent(token)
    },
    on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts)
      cleanups.push(() => target.removeEventListener(type, fn, opts))
    },
    timeout(fn, ms) {
      const id = setTimeout(fn, ms)
      cleanups.push(() => clearTimeout(id))
      return id
    },
    fetch(operationFactory, maxAttempts) {
      return fetchWithRetry(operationFactory, maxAttempts, controller.signal)
    },
    // Router-only: called once, right after the screen's own unmount()
    dispose() {
      controller.abort()
      for (const fn of cleanups.splice(0)) {
        try { fn() } catch (err) { console.warn('[screen] cleanup failed:', err) }
      }
    },
  }
}

// The one "couldn't load" message every screen shows when its first load
// fails. `what` finishes the sentence: "Couldn't load your <what>".
// Pass onRetry to add a Retry button.
export function showLoadError(container, what, onRetry) {
  if (!container) return
  container.innerHTML = `
    <div class="screen-message">
      <h2>Couldn't load your ${what}</h2>
      <p>Check your connection and try again.</p>
      ${onRetry ? '<button class="btn-save" id="screenRetryBtn" style="margin-top:16px">Retry</button>' : ''}
    </div>`
  if (onRetry) container.querySelector('#screenRetryBtn').addEventListener('click', onRetry)
}
