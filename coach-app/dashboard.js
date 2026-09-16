// ==========================================================================
// COACH APP BOOTSTRAP
// The only script dashboard.html loads directly, and the only module here
// with side effects on import - it runs start() at the bottom. Nothing else
// may import this file; screens that need to navigate import `go` from
// router.js instead, which is side-effect free. (An earlier version had
// screens importing `go` from here, which meant anything importing the
// bootstrap re-ran the session check.)
//
// What lives here, and deliberately nowhere else:
//   - the session + role check, done ONCE (the multi-page coach site
//     repeated it at the top of all 15 of its scripts)
//   - sidebar/nav wiring, including the submenu + collapse behaviour that
//     sidebar.js used to provide for the multi-page site
//   - the nav highlight, driven by the router's frame changes
//
// The route table and screen swapping live in router.js.
// ==========================================================================
import { supabase } from '../coachClient.js'
import { setSession } from './session.js'
import { go, initRouter, prefetchLikelyNext, currentRouteName, TAB_FOR_ROUTE } from './router.js'
import { initBell } from './bell.js'

const pageContent = document.getElementById('pageContent')
const pageTitle = document.getElementById('pageTitle')
const loggedInAs = document.getElementById('loggedInAs')

// ==========================================================================
// NAV HIGHLIGHT
// Driven entirely by the router's frame-change callback, so it updates
// identically whether a screen was reached by tapping, by a back gesture,
// or by a history replay. No tab-root screen has to assert its own state.
// ==========================================================================
function syncNavHighlight(frame) {
  const tab = TAB_FOR_ROUTE[frame?.name] || 'athletes'
  document.querySelectorAll('.sidebar-link[data-tab]').forEach(function(link) {
    link.classList.toggle('active', link.dataset.tab === tab)
  })
  // "Library" is a non-navigating <span> with no data-tab of its own, so
  // it's highlighted by finding the one submenu parent that isn't a link.
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
  // also navigate (Athletes) both route AND toggle, matching how the
  // multi-page site behaved when you tapped Athletes while already on it.
  document.querySelectorAll('.sidebar-item-hover > .sidebar-link').forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault()
      const item = link.parentElement
      const wasOpen = item.classList.contains('open')
      document.querySelectorAll('.sidebar-item-hover.open').forEach(i => i.classList.remove('open'))
      if (!wasOpen) item.classList.add('open')
      const route = link.dataset.route
      if (route && route !== currentRouteName()) go(route, {})
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
  initRouter({ content: pageContent, title: pageTitle, onFrameChange: syncNavHighlight })
  initBell() // chrome, not a screen - initialized once here, no unmount (see bell.js header comment)

  await go('athletes', {})
  prefetchLikelyNext()
}

start()
