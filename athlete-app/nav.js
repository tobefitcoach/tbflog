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

// Bumped on every single screen entry, forward or replayed - see enter()
// below. Several renderers (renderCommunication, renderProfile,
// renderMobilityAreaPicker, renderFormFill, renderOwnWorkoutAddExercise,
// renderOwnWorkoutBuilder) paint a loading shell, await a Supabase round
// trip, then paint the real content - if the athlete navigates away during
// that await (always possible; now more reachable via a back gesture),
// the stale response landing afterward would overwrite whatever screen is
// actually showing by then. A renderer captures enter()'s return value and
// checks isCurrent(token) after each await before touching the DOM again.
let generation = 0

export function token() {
  return generation
}

export function isCurrent(t) {
  return t === generation
}

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
// Returns the current generation token (see above) - async renderers
// capture it and check isCurrent(token) after each await.
export function enter(name, args, opts = {}) {
  generation++
  const myToken = generation
  if (replaying) return myToken // popstate is already driving this render; don't re-push what it just replayed
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
    return myToken
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
      return myToken
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
  return myToken
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
    await ROUTES[frame.name](frame.args)
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
  // Awaited, not fire-and-forget: several routes (renderCommunication,
  // renderProfile, renderMobilityAreaPicker, renderFormFill,
  // renderOwnWorkoutAddExercise) are async and paint a loading shell before
  // their first await. Resetting `replaying` synchronously right after the
  // call - rather than after the promise settles - would let anything a
  // route does past its own first await (renderMobilityAreaPicker's
  // "no stretch library filmed yet" branch redirects into renderMobilityPicker
  // after an await, for one) run with replaying already false, so ITS
  // nav.enter() would think it's a normal forward navigation and push a
  // second, spurious history entry on top of the one already being replayed.
  await ROUTES[frame.name](frame.args)
  replaying = false
  announce(frame)
}

// Closes the topmost open modal by clicking its tagged dismiss control,
// rather than by tracking modals as history frames of their own - they
// open from async callbacks (maybeShowWeeklyRecap chains into
// maybeShowOnOpenMessages, customConfirm can stack on top of another
// modal), which would make a history-entry-per-modal model fragile. If the
// active modal has no [data-modal-dismiss] at all, it's forced closed
// directly instead - #coachMessageContinueBtn is deliberately left
// untagged in its before_workout case (see showCoachMessagesModal) because
// its click handler also starts the workout, which back must not trigger.
function closeTopModal() {
  const overlays = document.querySelectorAll('.modal-overlay.active')
  const top = overlays[overlays.length - 1]
  if (!top) return false
  const dismissBtn = top.querySelector('[data-modal-dismiss]')
  if (dismissBtn) dismissBtn.click()
  else top.classList.remove('active')
  return true
}

function exitApp() {
  // Calling nativeCallback directly, not navigator.app.exitApp() -
  // native-bridge.js only defines the latter once cap.Plugins.App exists,
  // which needs @capacitor/core's registerPlugin - this app talks to the
  // injected bridge directly and never imports that.
  window.Capacitor?.nativeCallback?.('App', 'exitApp', {})
}

// Policy for Android's hardware back button (and, if wired the same way
// later, any other "hardware back" source): modals first, then unwind the
// current screen's own history, then treat the 4 tab roots as one flat
// level (any secondary tab -> Home) before finally exiting. Never reachable
// without @capacitor/app installed and a native rebuild - see init() below.
function handleHardwareBack() {
  if (closeTopModal()) return
  if (cursor > 0) { history.back(); return }
  const cur = currentFrame()
  if (cur && cur.tab !== 'home') { ROUTES.home({}); return }
  exitApp()
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
  // Safe no-op on plain web and on any native binary built before this
  // plugin was added (window.Capacitor may not even exist there, or may
  // exist without 'App' registered) - optional chaining throughout means
  // this line does nothing until @capacitor/app is installed AND the app
  // is rebuilt, at which point it activates with no further change needed
  // here or in dashboard.js.
  window.Capacitor?.addListener?.('App', 'backButton', handleHardwareBack)
}

// What every on-screen "<- Back" button calls now, instead of hardcoding
// its destination renderer. cursor > 0 is guaranteed for all of them in
// practice - only the 4 tab roots sit at cursor 0, and none of them render
// a back button - but the check costs nothing and makes "nothing to go
// back to" a silent no-op rather than an inconsistent history.back() on an
// empty stack.
export function back() {
  if (cursor > 0) history.back()
}
