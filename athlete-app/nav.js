// ==========================================================================
// NAVIGATION HISTORY
// Shadow-mode router: dashboard.js has no navigation model at all today -
// every screen change is a direct function call that overwrites
// pageContent.innerHTML, so there is nothing for the browser back button
// (or, eventually, Android's hardware back button) to act on. This file
// gives every screen transition a real history.pushState entry WITHOUT
// changing how any existing on-screen "<- Back" button or nav-bar tap
// works - those still call their target renderer directly, same as always.
// The only thing that changes yet is that a genuine back gesture (a real
// browser's back button today; Android hardware back and iOS edge-swipe
// once wired up in a later pass) now re-enters the correct previous
// screen instead of doing nothing or leaving the app.
//
// The stack holds live references to whatever each renderer was already
// being called with (entry objects, in-flight session promises, slide
// arrays) rather than serialising them - several of these renderers take
// a Promise or hold live references into entriesByDate that a coach's
// self-log flow mutates in place, both of which are structured-clone-
// hostile and would fork identity if copied. Losing the in-memory stack
// (a reload, or the WebView process being killed) also means every other
// piece of state this app depends on (entriesByDate, logSetsByPE,
// openSessionsByDayId) is gone too, so there is no scenario where
// serialising would let a deep screen render that this design can't
// already handle by falling back to Home.
//
// The URL never changes (no hash, no path) - GitHub Pages has no SPA
// fallback so a real path would 404 on reload, and capacitor.config.json
// points the native shell at a fixed URL. pushState with an identical URL
// still creates a genuine session-history entry, which is all that's
// needed here.
// ==========================================================================

const EPOCH = Date.now().toString(36) + Math.random().toString(36).slice(2)

let ROUTES = {}
let onFrameChange = null // (frame) => void - dashboard.js uses this to keep the bottom-nav highlight in sync

let frames = []
let cursor = -1
let replaying = false
let suppressNextPop = false
let pendingAfterPop = null // {name, args, tab} - set by popTo, consumed by the next popstate
let guardBusy = false

function currentFrame() {
  return cursor >= 0 ? frames[cursor] : null
}

function resolveTab(opts, cur) {
  return opts.tab || (cur && cur.tab) || 'home'
}

function setFrame(index, name, args, opts, cur) {
  const frame = { name, args, tab: resolveTab(opts, cur), guard: opts.guard || null }
  frames[index] = frame
  return frame
}

function announce(frame) {
  if (onFrameChange) onFrameChange(frame)
}

// Called from the top of every routable renderer. Does nothing but
// bookkeeping - the renderer's own body runs exactly as it always has,
// whether this was a normal forward call or a replay driven by popstate.
export function enter(name, args, opts = {}) {
  if (replaying) return // popstate is already driving this render; don't re-push what it just replayed
  const cur = currentFrame()

  if (opts.root) {
    // Every tab root (Home/Stats/Chat/Profile) collapses the whole stack to
    // one entry. Tab switches are a lateral reset, not a "drill in" you
    // should have to back out of N times - so this uses replaceState, not
    // pushState. See handleHardwareBack (added once hardware back is
    // wired) for why that's also what makes "back" from a secondary tab
    // land on Home with a single check rather than a history walk.
    frames = [{ name, args, tab: opts.tab, guard: null }]
    cursor = 0
    history.replaceState({ nav: EPOCH, i: 0 }, '', location.href)
    announce(frames[0])
    return
  }

  if (opts.popTo) {
    // Used by workoutSummary: it's reached FROM the workout, and back must
    // land on Day Preview, not re-enter a workout that already ended. Finds
    // the nearest lower frame with that name and physically collapses the
    // browser's session history back to it via history.go, so a later real
    // back gesture needs exactly one step from here, not one per exercise
    // swiped through.
    const targetIdx = frames.slice(0, cursor + 1).map(f => f.name).lastIndexOf(opts.popTo)
    if (targetIdx !== -1 && targetIdx < cursor) {
      pendingAfterPop = { name, args, tab: resolveTab(opts, frames[targetIdx]) }
      history.go(targetIdx - cursor)
      return
    }
    // Target not found behind us (e.g. summary reopened straight from Day
    // Preview's "View Summary", never having entered a workout this
    // session) - fall through to a normal push instead.
  }

  const shouldReplace = opts.replace || (opts.collapse && cur && cur.name === name)
  if (shouldReplace && cur) {
    setFrame(cursor, name, args, opts, cur)
    history.replaceState({ nav: EPOCH, i: cursor }, '', location.href)
  } else {
    frames = frames.slice(0, cursor + 1)
    frames.push(null)
    cursor = frames.length - 1
    setFrame(cursor, name, args, opts, cur)
    history.pushState({ nav: EPOCH, i: cursor }, '', location.href)
  }
  announce(frames[cursor])
}

async function onPopState(e) {
  if (suppressNextPop) { suppressNextPop = false; return }

  const state = e.state
  if (!state || state.nav !== EPOCH || !frames[state.i]) {
    // A stale or foreign entry - reload, or a history slot from before this
    // page's frames array existed. There's nothing coherent to replay, and
    // everything else this app depends on (entriesByDate, open sessions)
    // would be gone too in the reload case, so this is a dead end, not
    // something to guard or recover into.
    return
  }

  if (pendingAfterPop) {
    const p = pendingAfterPop
    pendingAfterPop = null
    cursor = state.i
    const frame = setFrame(cursor, p.name, p.args, { tab: p.tab }, frames[cursor])
    history.replaceState({ nav: EPOCH, i: cursor }, '', location.href)
    replaying = true
    ROUTES[frame.name](frame.args)
    replaying = false
    announce(frame)
    return
  }

  const from = currentFrame()
  if (from && from.guard && !guardBusy) {
    guardBusy = true
    const ok = await from.guard()
    guardBusy = false
    if (!ok) {
      // Undo the browser's own pop before the guard's async gap lets
      // anyone see a stale screen - the DOM was never touched, so
      // declining is a true no-op, not a flash back-and-forth.
      suppressNextPop = true
      history.go(cursor - state.i)
      return
    }
  }

  cursor = state.i
  const frame = frames[cursor]
  if (!frame) return
  replaying = true
  ROUTES[frame.name](frame.args)
  replaying = false
  announce(frame)
}

// Called once from dashboard.js after every renderer it needs to replay is
// defined. routes: {name: (args) => void}. onChange: (frame) => void, fired
// whenever a frame becomes current - forward navigation and replay alike -
// so the bottom-nav highlight (or anything else keyed off "what screen and
// tab am I on") only needs to live in one place instead of being re-asserted
// by every tab-root renderer individually.
export function init(routes, onChange) {
  ROUTES = routes
  onFrameChange = onChange || null
  window.addEventListener('popstate', onPopState)
}
