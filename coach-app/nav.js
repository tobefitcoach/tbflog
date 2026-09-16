// ==========================================================================
// NAVIGATION HISTORY — coach app
// Adapted from athlete-app/nav.js, which has been running in production
// since the athlete redesign. The model is identical: every screen entry
// gets a real history.pushState entry, so a genuine back gesture (browser
// back, Android hardware back, iOS edge-swipe once wired) re-enters the
// previous screen instead of doing nothing or dropping out of the app.
//
// Two deliberate differences from the athlete copy:
//
// 1. The "collapse to root" tab is configurable via init()'s opts.rootRoute
//    rather than hardcoded to 'home' - this app's root tab is 'athletes'.
//    Everything else about the hardware-back policy is unchanged.
// 2. No popTo support. The athlete app needed it for its workout-summary
//    flow (reached FROM a workout, where back must skip the whole workout).
//    Nothing in the coach app has that shape - the closest thing, the
//    training-builder iframe overlay, is a modal and is handled by
//    closeTopModal below. It can be ported across verbatim if that ever
//    changes.
//
// The URL never changes (no hash, no path) - GitHub Pages has no SPA
// fallback so a real path would 404 on reload, and capacitor.config.json
// points the native shell at a fixed URL. pushState with an identical URL
// still creates a genuine session-history entry, which is all that's
// needed here.
// ==========================================================================

const EPOCH = Date.now().toString(36) + Math.random().toString(36).slice(2)

let ROUTES = {}
let onFrameChange = null // (frame) => void - dashboard.js keeps the nav highlight in sync through this
let ROOT_ROUTE = 'athletes'

let frames = []
let cursor = -1
let replaying = false
let suppressNextPop = false
let guardBusy = false

// Bumped on every screen entry, forward or replayed. Every screen module's
// mount() captures this and re-checks isCurrent() after each await before
// touching the DOM - without it, a slow Supabase response landing after
// the coach has already navigated away would repaint over whatever screen
// is actually showing by then. Every coach screen does load-then-render,
// so unlike the athlete app (where only 5 screens were vulnerable) this
// applies to all of them.
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
  return opts.tab || (cur && cur.tab) || ROOT_ROUTE
}

function setFrame(index, name, args, opts, cur) {
  const frame = { name, args, tab: resolveTab(opts, cur), guard: opts.guard || null }
  frames[index] = frame
  return frame
}

function announce(frame) {
  if (onFrameChange) onFrameChange(frame)
}

// Called from the top of every screen module's mount(). Pure bookkeeping -
// the mount body runs exactly as it would otherwise, whether this was a
// normal forward navigation or a replay driven by popstate. Returns the
// generation token described above.
export function enter(name, args, opts = {}) {
  generation++
  const myToken = generation
  if (replaying) return myToken // popstate is already driving this render; don't re-push what it just replayed
  const cur = currentFrame()

  if (opts.root) {
    // Every tab root (Athletes/Chat/Library/Settings) collapses the whole
    // stack to one entry. Switching tabs is a lateral reset, not a "drill
    // in" you should have to back out of N times - so replaceState, not
    // pushState. It's also what lets handleHardwareBack treat the 4 roots
    // as one flat level with a single check rather than a history walk.
    frames = [{ name, args, tab: opts.tab, guard: null }]
    cursor = 0
    history.replaceState({ nav: EPOCH, i: 0 }, '', location.href)
    announce(frames[0])
    return myToken
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
    // A stale or foreign entry - a reload, or a history slot from before
    // this page's frames array existed. There's nothing coherent to
    // replay, and every screen's in-memory state would be gone too in the
    // reload case, so this is a dead end rather than something to recover.
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
      // declining is a true no-op rather than a visible flash.
      suppressNextPop = true
      history.go(cursor - state.i)
      return
    }
  }

  cursor = state.i
  const frame = frames[cursor]
  if (!frame) return
  replaying = true
  // Awaited, not fire-and-forget: every coach screen's mount() is async
  // (it dynamically imports its own module, then loads data). Clearing
  // `replaying` synchronously after the call rather than after the promise
  // settles would let anything past the first await run with replaying
  // already false, so its own nav.enter() would think it was a fresh
  // forward navigation and push a spurious second history entry on top of
  // the one being replayed.
  await ROUTES[frame.name](frame.args)
  replaying = false
  announce(frame)
}

// Closes the topmost open modal by clicking its tagged dismiss control,
// rather than tracking modals as history frames of their own - they open
// from async callbacks and can stack (customConfirm on top of another
// modal), which makes a history-entry-per-modal model fragile. If the
// active modal has no [data-modal-dismiss], it's force-closed directly.
//
// This is also what handles the training-builder iframe overlay, which is
// a .modal-overlay like any other - see openWorkoutBuilderOverlay in the
// calendar and program-builder screens.
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

// Policy for Android's hardware back button: modals (and the builder
// overlay) first, then unwind the current screen's own history, then treat
// the 4 tab roots as one flat level (any secondary tab -> Athletes) before
// finally exiting.
function handleHardwareBack() {
  if (closeTopModal()) return
  if (cursor > 0) { history.back(); return }
  const cur = currentFrame()
  if (cur && cur.tab !== ROOT_ROUTE) { ROUTES[ROOT_ROUTE]({}); return }
  exitApp()
}

// Called once from dashboard.js after the route table is built.
// routes: {name: (args) => Promise<void>}. onChange: (frame) => void, fired
// whenever a frame becomes current (forward navigation and replay alike),
// so the nav highlight only has to be implemented in one place instead of
// being re-asserted by every tab-root screen.
export function init(routes, onChange, opts = {}) {
  ROUTES = routes
  onFrameChange = onChange || null
  if (opts.rootRoute) ROOT_ROUTE = opts.rootRoute
  window.addEventListener('popstate', onPopState)
  // Safe no-op on plain web and on any native binary built before
  // @capacitor/app was added (window.Capacitor may not exist there, or may
  // exist without 'App' registered) - the optional chaining means this
  // line does nothing until the app is rebuilt, at which point hardware
  // back activates with no further change needed here.
  window.Capacitor?.addListener?.('App', 'backButton', handleHardwareBack)
}

// What every on-screen "← Back" button calls, instead of hardcoding its
// destination. cursor > 0 is guaranteed for all of them in practice - only
// the 4 tab roots sit at cursor 0 and none of them render a back button -
// but the check makes "nothing to go back to" a silent no-op rather than
// an inconsistent history.back() on an empty stack.
export function back() {
  if (cursor > 0) history.back()
}
