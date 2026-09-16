// ==========================================================================
// COACH APP BOOTSTRAP
// The only script dashboard.html loads directly. Everything else about a
// given screen - its markup, its logic, its screen-specific CSS - arrives
// via a dynamic import() the first time that screen is actually visited.
//
// What lives here, and deliberately nowhere else:
//   - the session + role check, done ONCE (the multi-page coach site
//     repeated it at the top of all 15 of its scripts)
//   - the route table, and the one function that swaps screens
//   - sidebar/nav wiring, including the submenu + collapse behaviour that
//     sidebar.js used to provide for the multi-page site
//   - idle prefetch of the likely-next screen
//
// PERFORMANCE CONTRACT - see Part D of the plan:
// Every entry in ROUTES is a dynamic import(). Turning any of them into a
// static `import` at the top of this file would pull all ~533KB of screen
// code onto the critical path and make this app roughly 4x slower to open
// than the multi-page site it replaces. If you add a screen, add it the
// same way the others are written.
// ==========================================================================
import { supabase } from '../coachClient.js'
import * as nav from './nav.js'
import { setSession } from './session.js'

const pageContent = document.getElementById('pageContent')
const pageTitle = document.getElementById('pageTitle')
const loggedInAs = document.getElementById('loggedInAs')

// ==========================================================================
// ROUTE TABLE
// name -> () => Promise<{ mount(container, params), unmount?() }>
//
// PHASE 1: every route resolves to the shared placeholder screen. The
// machinery around them (dynamic import, mount/unmount lifecycle, history,
// nav highlighting, prefetch) is real and fully exercised - only the screen
// bodies are stubs. Phase 2 onward replaces these one line at a time, so
// each screen can be landed and verified independently without touching
// anything else in this file.
// ==========================================================================
const ROUTES = {
  athletes:         () => import('./screens/_placeholder.js'),
  'athlete-detail': () => import('./screens/_placeholder.js'),
  communication:    () => import('./screens/_placeholder.js'),
  exercises:        () => import('./screens/_placeholder.js'),
  sections:         () => import('./screens/_placeholder.js'),
  trainings:        () => import('./screens/_placeholder.js'),
  programs:         () => import('./screens/_placeholder.js'),
  stretches:        () => import('./screens/_placeholder.js'),
  forms:            () => import('./screens/_placeholder.js'),
  settings:         () => import('./screens/_placeholder.js'),
  'program-builder':() => import('./screens/_placeholder.js'),
  'section-builder':() => import('./screens/_placeholder.js'),
  'form-builder':   () => import('./screens/_placeholder.js'),
}

// Which of the 4 tab roots each route lights up. Drill-downs inherit their
// parent tab, so opening an athlete keeps "Athletes" highlighted rather
// than leaving whatever tab was last tapped lit while showing something
// else - the exact bug the athlete app had before its redesign.
const TAB_FOR_ROUTE = {
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
  'athletes', 'communication', 'settings',
  'exercises', 'sections', 'trainings', 'programs', 'stretches', 'forms',
])

const SCREEN_TITLES = {
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
}

let currentModule = null
let currentRoute = null

// ==========================================================================
// SCREEN SWAP
// The single place a screen is ever mounted. Both forward navigation
// (go()) and history replay (nav's ROUTES callbacks) come through here, so
// the unmount/mount pairing can never be skipped by one path and not the
// other - which is how the multi-page site's timers used to leak.
// ==========================================================================
async function renderScreen(name, params = {}) {
  const loader = ROUTES[name]
  if (!loader) { console.warn('[nav] unknown route:', name); return }

  // Tear the old screen down BEFORE awaiting the next one's module, so a
  // slow import can't leave two screens' timers running at once.
  try { currentModule?.unmount?.() } catch (err) { console.warn('[nav] unmount failed:', err) }
  currentModule = null

  let mod
  try {
    mod = await loader()
  } catch (err) {
    // A failed chunk fetch is the one genuinely new failure mode a lazy
    // SPA has that a multi-page site doesn't - offline, or a deploy that
    // landed between page load and this navigation. Say so plainly rather
    // than leaving a blank screen.
    console.error('[nav] failed to load screen:', name, err)
    pageContent.innerHTML = `
      <div class="screen-message">
        <h2>Couldn't load this screen</h2>
        <p>Check your connection and try again.</p>
        <button class="btn-save" onclick="location.reload()" style="margin-top:16px">Reload</button>
      </div>`
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

  // Screens get the token so they can check nav.isCurrent(token) after
  // every await. Every coach screen loads data before it can render, so
  // without this a slow response landing after the coach has navigated on
  // would repaint over whatever screen is actually showing by then.
  await mod.mount(pageContent, { ...params, route: name }, token)
}

// What every in-app navigation calls. Screens import this from here rather
// than reaching for location.href - there are no separate documents to
// navigate to anymore.
export async function go(name, params = {}) {
  await renderScreen(name, params)
}

// Exposed for screens that need to navigate without importing this module
// (and for debugging from the console). Same pattern as confirm-modal.js's
// window.customConfirm.
window.coachNav = { go, back: nav.back }

// ==========================================================================
// NAV HIGHLIGHT
// Driven entirely by nav's onChange callback, so it updates identically
// whether a screen was reached by tapping, by a back gesture, or by a
// history replay. No tab-root screen has to assert its own highlight.
// ==========================================================================
function syncNavHighlight(frame) {
  const tab = TAB_FOR_ROUTE[frame?.name] || 'athletes'
  document.querySelectorAll('.sidebar-link[data-tab]').forEach(function(link) {
    link.classList.toggle('active', link.dataset.tab === tab)
  })
  // "Library" is a non-navigating <span> with no data-tab of its own, so
  // it's highlighted by finding the submenu that contains the active route.
  const libraryLink = document.querySelector('.sidebar-item-hover .sidebar-link:not([data-route])')
  if (libraryLink) libraryLink.classList.toggle('active', tab === 'library')
}

// ==========================================================================
// SIDEBAR
// Replaces sidebar.js for this app. Same classes, same localStorage key
// (so a collapsed/expanded preference carries over from the old site), and
// the same "opening one submenu closes any other" rule. The difference is
// that items now carry data-route instead of href, so a tap routes in
// place instead of loading a document.
// ==========================================================================
function initSidebar() {
  // Expand/collapse a submenu. Any item that has one gets this; items that
  // navigate directly (Athletes) both route AND toggle, matching how the
  // multi-page site behaved when you tapped Athletes while already on it.
  document.querySelectorAll('.sidebar-item-hover > .sidebar-link').forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault()
      const item = link.parentElement
      const wasOpen = item.classList.contains('open')
      document.querySelectorAll('.sidebar-item-hover.open').forEach(i => i.classList.remove('open'))
      if (!wasOpen) item.classList.add('open')
      const route = link.dataset.route
      if (route && route !== currentRoute) go(route, {})
    })
  })

  // Everything with a data-route that ISN'T a submenu parent: plain tab
  // links, submenu children, and the header logo.
  document.querySelectorAll('[data-route]').forEach(function(el) {
    if (el.parentElement.classList.contains('sidebar-item-hover') && el.classList.contains('sidebar-link')) return
    el.addEventListener('click', function(e) {
      e.preventDefault()
      document.querySelectorAll('.sidebar-item-hover.open').forEach(i => i.classList.remove('open'))
      const params = el.dataset.status ? { status: el.dataset.status } : {}
      go(el.dataset.route, params)
    })
  })

  // Collapse the whole sidebar (desktop only - style.css hides the toggle
  // on phones, where there's no side column to reclaim). Remembered in
  // localStorage under the same key the multi-page site used.
  const sidebar = document.querySelector('.sidebar')
  const toggleBtn = document.getElementById('sidebarToggleBtn')
  if (sidebar && toggleBtn) {
    if (localStorage.getItem('tbflog-sidebar-collapsed') === '1') {
      sidebar.classList.add('collapsed')
      toggleBtn.textContent = '›'
    }
    toggleBtn.addEventListener('click', function() {
      const collapsed = sidebar.classList.toggle('collapsed')
      toggleBtn.textContent = collapsed ? '›' : '‹'
      localStorage.setItem('tbflog-sidebar-collapsed', collapsed ? '1' : '0')
    })
  }
}

// ==========================================================================
// IDLE PREFETCH
// Once the first screen has painted and the app is sitting idle, quietly
// pull the screen the coach is most likely to open next. Opening an
// athlete is by far the most common action from the Athletes tab, and
// athlete-detail is also the single largest screen (294KB), so prefetching
// it is what lets that tap feel instant without charging its cost to
// startup.
//
// Nothing blocks on this and a failure is ignored - the real navigation
// would just fetch it again. Skipped entirely when the OS reports a
// metered/data-saver connection, where spending a coach's mobile data on
// something they might not open is the wrong trade.
// ==========================================================================
function prefetchLikelyNext() {
  if (navigator.connection?.saveData) return
  const idle = window.requestIdleCallback || function(fn) { return setTimeout(fn, 2000) }
  idle(function() {
    ROUTES['athlete-detail']?.().catch(function() { /* prefetch is best-effort */ })
  }, { timeout: 5000 })
}

// ==========================================================================
// STARTUP
// One session check and one role check for the whole app, replacing the
// copy that sat at the top of all 15 scripts on the multi-page site.
// ==========================================================================
async function start() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    window.location.href = '../login.html'
    return
  }

  // Parked for every screen to read, so none of them re-fetches it.
  setSession(session)
  loggedInAs.textContent = session.user.email || ''

  const { data: profile, error } = await window.fetchWithRetry((signal) => supabase
    .from('profiles')
    .select('role, name')
    .eq('id', session.user.id)
    .single()
    .abortSignal(signal)
  )

  if (error || !profile || profile.role !== 'coach') {
    // Signed in, but not as a coach. Most likely an athlete who opened the
    // coach URL. Don't sign them out from under themselves - offer the
    // door instead.
    pageContent.innerHTML = `
      <div class="screen-message">
        <h2>This is the coach app</h2>
        <p>You're signed in as ${profile?.role || 'an unknown role'}, so there's nothing here for you.</p>
        <button class="btn-save" id="wrongRoleLogoutBtn" style="margin-top:16px">Log out</button>
      </div>`
    document.getElementById('wrongRoleLogoutBtn').addEventListener('click', async function() {
      await supabase.auth.signOut()
      window.location.href = '../login.html'
    })
    return
  }

  initSidebar()

  // Build nav's route map from ours, so history replay goes through the
  // exact same mount path as a tap.
  const navRoutes = {}
  for (const name of Object.keys(ROUTES)) {
    navRoutes[name] = (args) => renderScreen(name, args)
  }
  nav.init(navRoutes, syncNavHighlight, { rootRoute: 'athletes' })

  await go('athletes', {})
  prefetchLikelyNext()
}

start()
