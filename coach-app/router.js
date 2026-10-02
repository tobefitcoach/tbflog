// ==========================================================================
// ROUTER
// The route table and the one function that swaps screens. Split out of
// dashboard.js deliberately: screens need `go`, and dashboard.js runs the
// session check as a side effect of being imported, so a screen importing
// it would re-trigger startup. This module has NO side effects on import -
// it defines things and waits to be driven.
//
// PERFORMANCE CONTRACT - see Part D of the plan:
// Every entry in ROUTES is a dynamic import(). Turning any of them into a
// static `import` at the top of this file would pull all ~533KB of screen
// code onto the critical path and make this app roughly 4x slower to open
// than the multi-page site it replaces. If you add a screen, add it the
// same way the others are written.
//
// CACHE-BUSTING: like every import in the app, each screen URL carries
// ?v=__V__, which the deploy workflow stamps with the commit id - see
// .github/workflows/pages.yml. WKWebView's disk cache otherwise holds an
// old module past a force-quit and a rebuild.
// ==========================================================================
import * as nav from './nav.js?v=__V__'
import { createScreenContext } from './screen-context.js?v=__V__'

// name -> () => Promise<{ mount(container, params, ctx), unmount?(), beforeLeave?() }>
// ctx is a screen context - see screen-context.js
export const ROUTES = {
  stats:            () => import(`./screens/stats.js?v=__V__`),
  athletes:         () => import(`./screens/athletes.js?v=__V__`),
  'athlete-detail': () => import(`./screens/athlete-detail.js?v=__V__`),
  communication:    () => import(`./screens/communication.js?v=__V__`),
  exercises:        () => import(`./screens/exercises.js?v=__V__`),
  sections:         () => import(`./screens/sections.js?v=__V__`),
  trainings:        () => import(`./screens/trainings.js?v=__V__`),
  programs:         () => import(`./screens/programs.js?v=__V__`),
  stretches:        () => import(`./screens/stretches.js?v=__V__`),
  forms:            () => import(`./screens/forms.js?v=__V__`),
  settings:         () => import(`./screens/settings.js?v=__V__`),
  'program-builder':() => import(`./screens/program-builder.js?v=__V__`),
  'section-builder':() => import(`./screens/section-builder.js?v=__V__`),
  'form-builder':   () => import(`./screens/form-builder.js?v=__V__`),
  // The Workout Builder. Reached from the Workout Library; the calendar and
  // program builder show the same module in an overlay (builder-overlay.js).
  'training-builder': () => import(`./screens/training-builder.js?v=__V__`),
}

// Which of the 4 tab roots each route lights up. Drill-downs inherit their
// parent tab, so opening an athlete keeps "Athletes" highlighted rather
// than leaving whatever tab was last tapped lit while showing something
// else - the exact bug the athlete app had before its redesign.
export const TAB_FOR_ROUTE = {
  stats: 'stats',
  athletes: 'athletes',
  'athlete-detail': 'athletes',
  communication: 'communication',
  exercises: 'library',
  sections: 'library',
  trainings: 'library',
  programs: 'library',
  stretches: 'library',
  forms: 'library',
  'program-builder': 'library',
  'section-builder': 'library',
  'form-builder': 'library',
  'training-builder': 'library',
  settings: 'settings',
}

// Routes that are tab roots: they collapse the history stack to a single
// entry (nav.enter's opts.root) rather than stacking, because reaching
// them is a lateral move between tabs, not a drill-in.
//
// The six Library screens count as roots even though they share one tab -
// they're reached by picking from the Library submenu, which is the same
// kind of lateral switch as tapping Chat. Without this, browsing
// Exercises -> Sections -> Programs would stack three deep and take three
// back presses to escape. Hardware back from any of them still lands on
// Athletes in one step, because nav compares the frame's TAB (library)
// against the root tab (athletes), not the route name.
//
// Deliberately absent: athlete-detail and the three builders. Those are
// genuine drill-downs and must push, so back returns where you came from.
const TAB_ROOTS = new Set([
  'stats', 'athletes', 'communication', 'settings',
  'exercises', 'sections', 'trainings', 'programs', 'stretches', 'forms',
])

const SCREEN_TITLES = {
  stats: 'Dashboard',
  athletes: 'Athletes',
  'athlete-detail': 'Athlete',
  communication: 'Chat',
  exercises: 'Exercise Library',
  sections: 'Section Library',
  trainings: 'Workout Library',
  programs: 'Program Library',
  stretches: 'Stretch Library',
  forms: 'Forms',
  settings: 'Settings',
  'program-builder': 'Program Builder',
  'section-builder': 'Section Builder',
  'form-builder': 'Form Builder',
  'training-builder': 'Workout Builder',
}

let pageContent = null
let pageTitle = null
let currentModule = null
let currentCtx = null
// Bumped by every renderScreen call - a navigation that waited on
// beforeLeave() checks it afterwards, so only the latest tap proceeds
let navSeq = 0
const LEAVE_TIMEOUT_MS = 3000
let currentRoute = null

export function currentRouteName() {
  return currentRoute
}

// ==========================================================================
// SCREEN SWAP
// The single place a screen is ever mounted. Both forward navigation (go)
// and history replay (the callbacks handed to nav.init) come through here,
// so the unmount/mount pairing can never be skipped by one path and not the
// other - which is how the multi-page site's timers used to leak.
// ==========================================================================
async function renderScreen(name, params = {}) {
  const loader = ROUTES[name]
  if (!loader) { console.warn('[router] unknown route:', name); return }

  // A screen with unsaved work (the builders' 800ms autosave debounce) can
  // export beforeLeave() to finish it first. Capped so a dead connection
  // can't trap the coach on the screen. If another navigation started
  // while this one waited, that one owns the switch - stop here.
  const mySeq = ++navSeq
  const leaving = currentModule
  if (leaving?.beforeLeave) {
    try {
      await Promise.race([leaving.beforeLeave(), new Promise(resolve => setTimeout(resolve, LEAVE_TIMEOUT_MS))])
    } catch (err) {
      console.warn('[router] beforeLeave failed:', err)
    }
    if (mySeq !== navSeq) return
  }

  // Tear the old screen down BEFORE awaiting the next one's module, so a
  // slow import can't leave two screens' timers running at once.
  try { currentModule?.unmount?.() } catch (err) { console.warn('[router] unmount failed:', err) }
  currentCtx?.dispose()
  currentModule = null
  currentCtx = null

  let mod
  try {
    mod = await loader()
  } catch (err) {
    // A failed chunk fetch is the one genuinely new failure mode a lazy
    // SPA has that a multi-page site doesn't - offline, or a deploy that
    // landed between page load and this navigation. Say so plainly rather
    // than leaving a blank screen.
    console.error('[router] failed to load screen:', name, err)
    pageContent.innerHTML = `
      <div class="screen-message">
        <h2>Couldn't load this screen</h2>
        <p>Check your connection and try again.</p>
        <button class="btn-save" id="routerReloadBtn" style="margin-top:16px">Reload</button>
      </div>`
    pageContent.querySelector('#routerReloadBtn').addEventListener('click', () => location.reload())
    return
  }

  currentRoute = name
  currentModule = mod
  pageTitle.textContent = SCREEN_TITLES[name] || 'Coach'
  pageContent.classList.remove('screen-enter')
  void pageContent.offsetWidth // restart the CSS animation on a re-render of the same screen
  pageContent.classList.add('screen-enter')

  // The router bookkeeping is done HERE, not inside each screen. Doing it
  // centrally means no screen can forget to pass root:true (which would
  // make tab switches stack up in history instead of resetting it), and
  // the 13 screen modules don't each carry a copy of the same three lines.
  // nav.enter is a no-op during history replay, so calling it on this path
  // is correct for both a tap and a back gesture.
  const token = nav.enter(name, params, {
    root: TAB_ROOTS.has(name),
    tab: TAB_FOR_ROUTE[name] || 'athletes',
  })

  // Screens get a context carrying the token, so they can check
  // ctx.alive() after every await. Every coach screen loads data before it
  // can render, so without this a slow response landing after the coach
  // has navigated on would repaint over whatever screen is showing by
  // then. The context also owns the screen's document listeners, timers
  // and requests, and the dispose() above releases them all.
  const ctx = createScreenContext(token)
  currentCtx = ctx
  await mod.mount(pageContent, { ...params, route: name }, ctx)
}

// What every in-app navigation calls, from screens and from the sidebar
// alike. Screens import this rather than reaching for location.href -
// there are no separate documents to navigate to anymore.
export async function go(name, params = {}) {
  await renderScreen(name, params)
}

// Called once from dashboard.js, after the role check passes. Wires nav's
// history replay to the same renderScreen path a tap uses, so a back
// gesture and a tap can never diverge.
export function initRouter({ content, title, onFrameChange }) {
  pageContent = content
  pageTitle = title

  const navRoutes = {}
  for (const name of Object.keys(ROUTES)) {
    navRoutes[name] = (args) => renderScreen(name, args)
  }
  nav.init(navRoutes, onFrameChange, { rootRoute: 'athletes' })

  // Exposed for debugging from the console, and for any screen that would
  // rather not import the router. Same pattern as confirm-modal.js's
  // window.customConfirm.
  window.coachNav = { go, back: nav.back }
}

// Quietly pull the screen the coach is most likely to open next, once the
// first screen has painted and the app is idle. Opening an athlete is by
// far the most common action from the Athletes tab, and athlete-detail is
// also the single largest screen (294KB), so prefetching it is what lets
// that tap feel instant without charging its cost to startup.
//
// Nothing blocks on this and a failure is ignored - the real navigation
// would just fetch it again. Skipped entirely when the OS reports a
// metered/data-saver connection, where spending a coach's mobile data on
// something they might not open is the wrong trade.
export function prefetchLikelyNext() {
  if (navigator.connection?.saveData) return
  const idle = window.requestIdleCallback || function(fn) { return setTimeout(fn, 2000) }
  idle(function() {
    ROUTES['athlete-detail']?.().catch(function() { /* prefetch is best-effort */ })
  }, { timeout: 5000 })
}
