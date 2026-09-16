// ==========================================================================
// NOTIFICATION BELL — coach app
// Converted from the repo-root bell.js, which self-injected into
// #headerActions on every one of the 14 multi-page site's pages. Two
// structural differences from every screens/*.js conversion so far:
//
// 1. This is chrome, not a screen. It lives in the persistent header
//    outside #pageContent, so it is initialized ONCE by the bootstrap
//    (see initBell() below, called from dashboard.js's start()) rather
//    than mounted/unmounted per navigation - there is no unmount() to
//    export, the same way nav.js's own listeners are wired once via
//    nav.init() and never torn down. Its setInterval and document
//    listeners are meant to live for the app's whole session.
// 2. No session check - dashboard.js only calls initBell() after its own
//    session + role check already passed, so the `if (session) initBell()`
//    gate from the original is gone; this file assumes it's always safe
//    to run once imported.
//
// Everything else - the polling cadence, the mark-as-read behaviour, the
// visibilitychange refresh - is unchanged. The one behavioural change is
// the notification links themselves: `communication.html?id=X` and
// `athlete.html?id=X` were real page loads; here they're route calls.
// ==========================================================================
import { supabase } from '../coachClient.js'
import { go } from './router.js'

let refreshTimer = null

export function initBell() {
  const headerActions = document.getElementById('headerActions')
  if (!headerActions) return // shouldn't happen in this app - every page has the header - but match the original's defensiveness

  const bell = document.createElement('div')
  bell.className = 'notification-bell'
  bell.innerHTML = `
    <button type="button" class="notification-bell-btn" id="notificationBellBtn" aria-label="Notifications">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      <span class="notification-bell-badge" id="notificationBellBadge" style="display:none">0</span>
    </button>
    <div class="notification-bell-panel" id="notificationBellPanel"></div>
  `
  headerActions.appendChild(bell)

  document.getElementById('notificationBellBtn').addEventListener('click', async function(e) {
    e.stopPropagation()
    const panel = document.getElementById('notificationBellPanel')
    const opening = !panel.classList.contains('active')
    panel.classList.toggle('active')
    if (opening) await openPanel()
  })

  // Dismisses on outside click - this predates the app-wide kebab-dropdown
  // fix (see athletes.js) and was already correct, nothing to change here.
  document.addEventListener('click', function(e) {
    const panel = document.getElementById('notificationBellPanel')
    if (panel.classList.contains('active') && !bell.contains(e.target)) panel.classList.remove('active')
  })

  refreshBadge()
  refreshTimer = setInterval(refreshBadge, 45000)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') refreshBadge()
}

async function refreshBadge() {
  // RLS already scopes this to the logged-in coach's own notifications - no
  // explicit .eq('coach_id', ...) needed
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)
  if (error) { console.log(error); return }
  const badge = document.getElementById('notificationBellBadge')
  if (!badge) return
  badge.style.display = count > 0 ? '' : 'none'
  badge.textContent = count > 9 ? '9+' : String(count)
}

async function openPanel() {
  const panel = document.getElementById('notificationBellPanel')
  panel.innerHTML = '<p class="notification-bell-empty">Loading...</p>'

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) {
    console.log(error)
    panel.innerHTML = '<p class="notification-bell-empty">Something went wrong loading notifications</p>'
    return
  }

  // Was <a href="communication.html?id=X"> / <a href="athlete.html?id=X">
  // in the original - real page loads. There are no separate documents to
  // navigate to anymore, so these render as plain elements with a
  // data-route/data-id pair instead, wired below via event delegation
  // (the panel's innerHTML is replaced wholesale on every open, so
  // delegating from the panel itself - not from each item - means this
  // only has to be bound once per panel open, not once per item).
  panel.innerHTML = data.length === 0
    ? '<p class="notification-bell-empty">No notifications yet</p>'
    : data.map(n => `
      <a href="#" class="notification-bell-item ${n.read_at ? '' : 'unread'}" data-route="${n.type === 'chat_message' ? 'communication' : 'athlete-detail'}" data-athlete-id="${n.athlete_id}">
        <span class="notification-bell-message">${escapeHtml(n.message)}</span>
        <span class="notification-bell-time">${formatRelativeTime(n.created_at)}</span>
      </a>
    `).join('')

  panel.querySelectorAll('.notification-bell-item').forEach(item => {
    item.addEventListener('click', function(e) {
      e.preventDefault()
      panel.classList.remove('active')
      go(item.dataset.route, { id: item.dataset.athleteId })
    })
  })

  // Only marks what's actually shown here as read - if a coach somehow has
  // more than 20 unread, the badge correctly keeps showing the remainder
  const unreadIds = data.filter(n => !n.read_at).map(n => n.id)
  if (unreadIds.length > 0) {
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).in('id', unreadIds)
    const badge = document.getElementById('notificationBellBadge')
    if (badge) badge.style.display = 'none'
  }
}

// Only used for the athlete-entered-derived free text in a notification's
// message, rendered via innerHTML - same convention as escapeHtmlCal in
// athlete-calendar.js
function escapeHtml(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function formatRelativeTime(isoStr) {
  const diffMs = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
