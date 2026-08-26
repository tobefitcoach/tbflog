// ==========================================================================
// NOTIFICATION BELL
// Self-injecting shared component, same pattern as confirm-modal.js - loaded
// on every coach page, builds its own markup and appends it into the header
// (right before #logoutBtn) on load, so no page's HTML needs anything beyond
// the <script> tag that loads this file. Shows a small unread-count badge
// and, on click, an anchored dropdown panel of recent notifications
// (athlete added/completed a workout, added a tournament - see the
// notifyCoach() call sites in athlete-app/dashboard.js).
//
// No Supabase Realtime anywhere in this codebase yet - the unread badge
// follows the existing polling + refresh-on-visibilitychange convention
// (see athlete.js's loadOverviewStatsGuarded) instead of introducing a
// first WebSocket subscription.
// ==========================================================================
import { supabase } from './coachClient.js'

const { data: { session } } = await supabase.auth.getSession()
if (session) initBell()

async function initBell() {
  const logoutBtn = document.getElementById('logoutBtn')
  if (!logoutBtn) return // page without the usual header - nothing to anchor to

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
  logoutBtn.insertAdjacentElement('beforebegin', bell)

  document.getElementById('notificationBellBtn').addEventListener('click', async function(e) {
    e.stopPropagation()
    const panel = document.getElementById('notificationBellPanel')
    const opening = !panel.classList.contains('active')
    panel.classList.toggle('active')
    if (opening) await openPanel()
  })

  // No existing kebab dropdown in this app closes on outside-click - new
  // behavior here since a notification panel is expected to dismiss itself
  document.addEventListener('click', function(e) {
    const panel = document.getElementById('notificationBellPanel')
    if (panel.classList.contains('active') && !bell.contains(e.target)) panel.classList.remove('active')
  })

  await refreshBadge()
  setInterval(refreshBadge, 45000)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') refreshBadge()
  })
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

  panel.innerHTML = data.length === 0
    ? '<p class="notification-bell-empty">No notifications yet</p>'
    : data.map(n => `
      <a class="notification-bell-item ${n.read_at ? '' : 'unread'}" href="${n.type === 'chat_message' ? 'communication.html' : 'athlete.html'}?id=${n.athlete_id}">
        <span class="notification-bell-message">${escapeHtml(n.message)}</span>
        <span class="notification-bell-time">${formatRelativeTime(n.created_at)}</span>
      </a>
    `).join('')

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
