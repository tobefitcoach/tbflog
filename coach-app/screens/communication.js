// ==========================================================================
// COMMUNICATION — screen
// Converted from the repo-root communication.js + the .dashboard block of
// communication.html. The coach's inbox across every athlete: a two-pane
// layout with the athlete list on the left (loadCommsAthletes) and the
// selected athlete's full chat_messages history + a send box on the right
// (selectCommsAthlete/loadChatMessages/sendChatMessage). The chat itself
// (chat_messages table, chat-attachments storage bucket) is unchanged.
//
// What changed in conversion:
//
//   - the session check at the top is gone (the bootstrap does it once),
//     and session.user.id on the insert became coachId()
//   - the two module-level document.getElementById listeners (send
//     button, Enter in the input) move inside mount(), because this module
//     is now imported before its markup exists
//   - the deep link is a route param, not a query string: what used to be
//     communication.html?id=42 arrives as params.id
//   - the history.replaceState that kept that ?id= in the URL is GONE.
//     nav.js owns the history stack now and parks its own state object on
//     each entry; replacing that state out from under it would break the
//     back gesture for the rest of the session
//   - every await is followed by an isCurrent(token) / root check before
//     the DOM is touched again
//   - the push URL resolves one directory up, since this app lives at
//     coach-app/dashboard.html rather than at the repo root
//
// MOBILE REDESIGN (see the plan/discussion this was built from): the
// two-pane layout only works with both panes visible side by side, which a
// phone can't do - it used to just stack them in one column, list on top
// of an already-selected conversation, with "Select an athlete on the
// left" text nobody could act on. Desktop keeps the two-pane layout
// completely unchanged (see the (min-width:769px) rules in coach-core.css
// that hide the mobile-only back button). Below 769px, selecting a row now
// pushes the conversation over the list as its own full-bleed screen:
//
//   - selectCommsAthlete pushes a real nav.enter() frame directly (NOT
//     through router.go/renderScreen, which always forces root:true on
//     this route name - see TAB_ROOTS in router.js) so Android hardware
//     back / the back arrow genuinely closes the conversation instead of
//     leaving the Chat tab. Popping back to the list frame replays through
//     the normal router path and fully remounts, same as every other
//     back navigation in this app.
//   - the deep-link path (params.id, from the notification bell/push) does
//     NOT push a second frame - router.go already entered this route with
//     that id baked into the one root frame, so there's nothing shallower
//     to return to; back from a deep link falls through to the tab-level
//     back policy, which is correct.
//   - rows now show a last-message preview + short timestamp and sort by
//     recency instead of alphabetically, so the inbox is actually
//     scannable - see lastMessageByAthlete.
//   - a search box filters the list by name.
//   - the messages list is no longer its own nested scroll box on mobile
//     (max-height + overflow-y both existed only to fit inside a fixed
//     side-by-side pane); on a phone the whole screen scrolls as one, and
//     the input row sticks to the bottom above the floating nav pill.
//   - the coach can edit or delete their own sent messages (tap a bubble
//     to reveal Edit/Delete). Deliberately scoped to the coach side only -
//     the athlete app's chat renderer is untouched.
//
// There is no SKELETON here, and no load before the first paint: the
// markup is static and the athlete list carries its own "Loading..." line,
// same as the settings screen. See screens/_placeholder.js for the full
// contract.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import { sendPush } from '../../push.js'
import * as nav from '../nav.js'
import { coachId } from '../session.js'
import { refreshChatBadge } from '../bell.js'

// Two-pane inbox: athlete list on the left, the selected athlete's full
// chat_messages history + a send box on the right - see
// selectCommsAthlete(). params.id deep-links straight into one athlete's
// conversation (used by the notification bell and by push notifications
// for a new chat message).
const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Communication</h2>
  </div>
  <div class="comms-layout" id="commsLayout">
    <div class="comms-athlete-list" id="commsAthleteList">
      <input type="text" id="commsSearchInput" class="comms-search-input" placeholder="Search athletes..." />
      <div id="commsAthleteRows"><p class="no-metrics">Loading...</p></div>
    </div>
    <div class="comms-chat-pane">
      <p class="no-metrics" id="commsEmptyState">Select an athlete on the left to see your conversation.</p>
      <div id="commsActiveChat" style="display:none">
        <div class="comms-chat-header" id="commsChatHeader"></div>
        <div class="chat-messages" id="chatMessages"></div>
        <div class="chat-input-row">
          <input type="text" id="chatInput" placeholder="Type a message..." maxlength="2000" />
          <button type="button" class="btn-save" id="chatSendBtn">Send</button>
        </div>
      </div>
    </div>
  </div>
`

let root = null
let mountToken = null
let allCommsAthletes = []
let unreadCountByAthlete = {} // athlete_id -> count of unread athlete-sent messages
let lastMessageByAthlete = {} // athlete_id -> most recent chat_messages row, for preview text + recency sort
let selectedAthlete = null
let searchQuery = ''
let editingMessageId = null // non-null while the coach is editing a previously-sent bubble
let viewportResizeHandler = null

function isMobileWidth() {
  return window.matchMedia('(max-width: 768px)').matches
}

export async function mount(container, params, token) {
  root = container
  mountToken = token
  container.innerHTML = TEMPLATE
  bindEvents()
  await loadCommsAthletes(params.id)
}

export function unmount() {
  if (viewportResizeHandler) {
    window.visualViewport?.removeEventListener('resize', viewportResizeHandler)
    viewportResizeHandler = null
  }
  root = null
  mountToken = null
  allCommsAthletes = []
  unreadCountByAthlete = {}
  lastMessageByAthlete = {}
  selectedAthlete = null
  searchQuery = ''
  editingMessageId = null
}

function bindEvents() {
  root.querySelector('#chatSendBtn').addEventListener('click', sendChatMessage)
  root.querySelector('#chatInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendChatMessage()
  })
  root.querySelector('#commsSearchInput').addEventListener('input', function(e) {
    searchQuery = e.target.value
    renderCommsAthleteList()
  })

  // A resize of the visual viewport (not the layout viewport) is what
  // fires when the iOS/Android on-screen keyboard opens - the page itself
  // doesn't resize, so a normal 'resize' listener never sees it. Nudging
  // the messages scroll to the bottom here is what keeps the newest
  // message (and the input row right below it) in view instead of hidden
  // under the keyboard.
  if (window.visualViewport) {
    viewportResizeHandler = function() {
      if (!selectedAthlete) return
      const container = root?.querySelector('#chatMessages')
      if (container) container.scrollTop = container.scrollHeight
    }
    window.visualViewport.addEventListener('resize', viewportResizeHandler)
  }
}

function escapeHtml(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// Short, chat-app-style relative stamp for a list row: a time today, a
// weekday within the last week, otherwise a date - same three-tier
// convention most messaging apps use so the list stays scannable at a
// glance instead of a full date on every row.
function formatShortTime(isoString) {
  const date = new Date(isoString)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return date.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })
  const daysAgo = Math.floor((now - date) / 86400000)
  if (daysAgo < 7) return date.toLocaleString('en-US', { weekday: 'short' })
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric' })
}

function formatPreview(row) {
  if (!row) return 'No messages yet'
  const prefix = row.sender === 'coach' ? 'You: ' : ''
  if (row.message) {
    const text = row.message.length > 42 ? row.message.slice(0, 42) + '…' : row.message
    return prefix + text
  }
  if (row.pdf_url) return prefix + '📄 Sent a report'
  return 'No messages yet'
}

async function loadCommsAthletes(preselectId) {
  const { data: athletes, error } = await supabase
    .from('athletes')
    .select('*')
    .eq('archived', false)
    .order('name')
  if (!nav.isCurrent(mountToken) || !root) return

  if (error) {
    console.log('Error loading athletes:', error)
    root.querySelector('#commsAthleteRows').innerHTML = '<p class="no-metrics">Something went wrong loading your athletes - check your connection and try again</p>'
    return
  }

  allCommsAthletes = athletes || []

  // Unread = athlete-sent messages this coach hasn't opened yet, same
  // read_at convention as the old per-athlete tab used - just tallied
  // across every athlete here instead of one at a time
  const { data: unreadRows } = await supabase
    .from('chat_messages')
    .select('athlete_id')
    .eq('sender', 'athlete')
    .is('read_at', null)
  if (!nav.isCurrent(mountToken) || !root) return

  unreadCountByAthlete = {}
  for (const row of (unreadRows || [])) {
    unreadCountByAthlete[row.athlete_id] = (unreadCountByAthlete[row.athlete_id] || 0) + 1
  }

  // Latest message per athlete, for the row preview text + recency sort.
  // One query across everyone rather than N queries per-athlete - capped
  // at 300 rows (recent-first) as a sane bound for a coach's whole inbox;
  // the first row seen per athlete_id is that athlete's latest since the
  // query is already ordered newest-first.
  const { data: recentRows } = await supabase
    .from('chat_messages')
    .select('athlete_id, message, pdf_url, sender, created_at')
    .order('created_at', { ascending: false })
    .limit(300)
  if (!nav.isCurrent(mountToken) || !root) return

  lastMessageByAthlete = {}
  for (const row of (recentRows || [])) {
    if (!lastMessageByAthlete[row.athlete_id]) lastMessageByAthlete[row.athlete_id] = row
  }

  renderCommsAthleteList()

  // Deep link from the notification bell / a push notification - what used
  // to be communication.html?id=42 is now a route param, so this opens
  // straight into that athlete's chat. pushHistory:false because router.go
  // already entered this route with this id on the one root frame - there
  // is no shallower "list" frame to push on top of.
  if (preselectId) {
    const match = allCommsAthletes.find(a => String(a.id) === String(preselectId))
    if (match) selectCommsAthlete(match, { pushHistory: false })
  }
}

function renderCommsAthleteList() {
  const list = root.querySelector('#commsAthleteRows')
  const query = searchQuery.trim().toLowerCase()
  const filtered = query
    ? allCommsAthletes.filter(a => a.name.toLowerCase().includes(query))
    : allCommsAthletes

  if (allCommsAthletes.length === 0) {
    list.innerHTML = '<p class="no-metrics">No athletes yet</p>'
    return
  }
  if (filtered.length === 0) {
    list.innerHTML = '<p class="no-metrics">No athletes match your search</p>'
    return
  }

  const sorted = filtered.slice().sort((a, b) => {
    const aTime = lastMessageByAthlete[a.id]?.created_at
    const bTime = lastMessageByAthlete[b.id]?.created_at
    if (aTime && bTime) return new Date(bTime) - new Date(aTime)
    if (aTime) return -1
    if (bTime) return 1
    return a.name.localeCompare(b.name)
  })

  list.innerHTML = sorted.map(a => {
    const initials = a.name.split(' ').map(word => word[0]).join('').toUpperCase()
    const avatarHtml = a.avatar_url ? `<img src="${a.avatar_url}" class="avatar-img" alt="">` : initials
    const unread = unreadCountByAthlete[a.id] || 0
    const lastRow = lastMessageByAthlete[a.id]
    return `
      <button type="button" class="comms-athlete-row ${selectedAthlete && selectedAthlete.id === a.id ? 'active' : ''}" data-athlete-id="${a.id}">
        <div class="athlete-initials">${avatarHtml}</div>
        <div class="comms-athlete-row-text">
          <div class="comms-athlete-row-main">
            <span class="comms-athlete-name">${escapeHtml(a.name)}</span>
            ${lastRow ? `<span class="comms-athlete-time">${formatShortTime(lastRow.created_at)}</span>` : ''}
          </div>
          <span class="comms-athlete-preview">${escapeHtml(formatPreview(lastRow))}</span>
        </div>
        ${unread > 0 ? `<span class="comms-unread-badge">${unread > 9 ? '9+' : unread}</span>` : ''}
      </button>
    `
  }).join('')

  list.querySelectorAll('.comms-athlete-row').forEach(btn => {
    btn.addEventListener('click', function() {
      const athlete = allCommsAthletes.find(a => String(a.id) === btn.dataset.athleteId)
      if (athlete) selectCommsAthlete(athlete)
    })
  })
}

// The multi-page version also pushed ?id= onto the URL here with
// history.replaceState, to keep the conversation deep-linkable across a
// refresh. That's deliberately gone: nav.js stores its own cursor in
// history.state, and overwriting it would desync the back gesture for the
// rest of the session.
//
// On a phone this now also pushes a REAL nav frame (opts.pushHistory,
// default true), called directly rather than through router.go - see the
// header comment for why. On desktop this is still purely an in-screen
// move (no history push), same as it always was, since both panes stay
// visible and there's nothing to "back" out of.
function selectCommsAthlete(athlete, opts = {}) {
  const pushHistory = opts.pushHistory !== false
  selectedAthlete = athlete
  editingMessageId = null
  renderCommsAthleteList() // re-render so the newly-selected row highlights

  if (isMobileWidth()) {
    if (pushHistory) nav.enter('communication', { id: athlete.id }, { tab: 'communication' })
    root.querySelector('#commsLayout').classList.add('chat-open')
  }

  root.querySelector('#commsEmptyState').style.display = 'none'
  root.querySelector('#commsActiveChat').style.display = 'block'
  root.querySelector('#commsChatHeader').innerHTML = `
    <button type="button" class="comms-chat-back-btn" id="commsChatBackBtn" aria-label="Back to conversations">←</button>
    <h3>${escapeHtml(athlete.name)}</h3>
  `
  const backBtn = root.querySelector('#commsChatBackBtn')
  if (backBtn) backBtn.addEventListener('click', function() { nav.back() })

  loadChatMessages()
}

async function loadChatMessages() {
  const container = root.querySelector('#chatMessages')
  container.innerHTML = '<p class="no-metrics">Loading...</p>'

  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('athlete_id', selectedAthlete.id)
    .order('created_at', { ascending: true })
  if (!nav.isCurrent(mountToken) || !root) return

  if (error) {
    console.log('Error loading chat:', error)
    container.innerHTML = '<p class="no-metrics">Something went wrong loading this chat - try again</p>'
    return
  }

  renderChatMessages(data)

  const unreadIds = data.filter(m => m.sender === 'athlete' && !m.read_at).map(m => m.id)
  if (unreadIds.length > 0) {
    await supabase.from('chat_messages').update({ read_at: new Date().toISOString() }).in('id', unreadIds)
    if (!nav.isCurrent(mountToken) || !root) return
    delete unreadCountByAthlete[selectedAthlete.id]
    renderCommsAthleteList()
    refreshChatBadge()
  }
}

function renderChatMessages(messages) {
  const container = root.querySelector('#chatMessages')
  if (messages.length === 0) {
    container.innerHTML = '<p class="no-metrics">No messages yet - say hi!</p>'
    return
  }
  // Own (coach) bubbles get a tap target that reveals Edit/Delete - see
  // wireBubbleActions. Only the coach's own messages are editable here;
  // the athlete's bubbles render with no affordance at all.
  container.innerHTML = messages.map(m => `
    <div class="chat-bubble chat-bubble-${m.sender === 'coach' ? 'mine' : 'theirs'}" ${m.sender === 'coach' ? `data-message-id="${m.id}"` : ''}>
      ${m.message ? `<p>${escapeHtml(m.message)}</p>` : ''}
      ${m.pdf_url ? `<a href="${m.pdf_url}" target="_blank" rel="noopener" class="chat-pdf-link">📄 View Report</a>` : ''}
      <span class="chat-bubble-time">${new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
      ${m.sender === 'coach' ? `
        <div class="chat-bubble-actions" id="chat-actions-${m.id}">
          <button type="button" class="chat-bubble-action-btn" data-edit-id="${m.id}">Edit</button>
          <button type="button" class="chat-bubble-action-btn chat-bubble-action-delete" data-delete-id="${m.id}">Delete</button>
        </div>
      ` : ''}
    </div>
  `).join('')
  container.scrollTop = container.scrollHeight
  wireBubbleActions(messages)
}

// Tapping one of the coach's own bubbles toggles a small Edit/Delete row
// beneath it - there's no hover on a phone, so this replaces what would
// otherwise be a hover-revealed control on desktop. Only text messages
// (m.message truthy) are editable; a bubble that's only a shared PDF has
// nothing to edit, but can still be deleted.
function wireBubbleActions(messages) {
  const container = root.querySelector('#chatMessages')
  container.querySelectorAll('.chat-bubble-mine').forEach(bubble => {
    bubble.addEventListener('click', function(e) {
      if (e.target.closest('.chat-bubble-actions') || e.target.closest('a')) return
      const actions = bubble.querySelector('.chat-bubble-actions')
      if (!actions) return
      const wasOpen = actions.classList.contains('open')
      container.querySelectorAll('.chat-bubble-actions.open').forEach(el => el.classList.remove('open'))
      if (!wasOpen) actions.classList.add('open')
    })
  })

  container.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      const id = btn.dataset.editId
      const msg = messages.find(m => String(m.id) === id)
      if (!msg) return
      startEditingMessage(msg)
    })
  })

  container.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', async function(e) {
      e.stopPropagation()
      const id = btn.dataset.deleteId
      const ok = await customConfirm('Delete this message? This cannot be undone.')
      if (!ok) return
      const { error } = await supabase.from('chat_messages').delete().eq('id', id)
      if (!nav.isCurrent(mountToken) || !root) return
      if (error) {
        console.log('Error deleting message:', error)
        customAlert('Something went wrong deleting that - try again')
        return
      }
      if (editingMessageId === id) cancelEditingMessage()
      loadChatMessages()
    })
  })
}

function startEditingMessage(msg) {
  editingMessageId = msg.id
  const input = root.querySelector('#chatInput')
  input.value = msg.message || ''
  input.focus()
  root.querySelector('#chatSendBtn').textContent = 'Save'
  let banner = root.querySelector('#chatEditingBanner')
  if (!banner) {
    banner = document.createElement('div')
    banner.className = 'chat-editing-banner'
    banner.id = 'chatEditingBanner'
    root.querySelector('.chat-input-row').insertAdjacentElement('beforebegin', banner)
  }
  banner.innerHTML = `Editing message <button type="button" id="chatCancelEditBtn">Cancel</button>`
  banner.querySelector('#chatCancelEditBtn').addEventListener('click', cancelEditingMessage)
}

function cancelEditingMessage() {
  editingMessageId = null
  const input = root.querySelector('#chatInput')
  input.value = ''
  root.querySelector('#chatSendBtn').textContent = 'Send'
  root.querySelector('#chatEditingBanner')?.remove()
}

async function sendChatMessage() {
  const input = root.querySelector('#chatInput')
  const message = input.value.trim()
  if (!message || !selectedAthlete) return

  if (editingMessageId) {
    const id = editingMessageId
    input.disabled = true
    const { error } = await supabase.from('chat_messages').update({ message }).eq('id', id)
    if (!nav.isCurrent(mountToken) || !root) return
    input.disabled = false
    if (error) {
      console.log('Error editing message:', error)
      customAlert('Something went wrong saving that edit - try again')
      return
    }
    cancelEditingMessage()
    loadChatMessages()
    return
  }

  // Captured up front, not read again after the await below. selectedAthlete
  // is module-level and mutable - if the coach clicks a different athlete
  // row while this insert is in flight, the module-level variable now
  // points at THAT athlete by the time execution resumes. Without this
  // capture, the push notification a few lines down would go to whoever is
  // newly selected, not whoever this message was actually sent to.
  const targetAthlete = selectedAthlete

  input.value = ''
  input.disabled = true

  const { error } = await supabase.from('chat_messages').insert([{
    coach_id: coachId(),
    athlete_id: targetAthlete.id,
    sender: 'coach',
    message
  }])
  if (!nav.isCurrent(mountToken) || !root) return

  input.disabled = false

  if (error) {
    console.log('Error sending message:', error)
    customAlert('Something went wrong sending that - try again')
    input.value = message
    return
  }

  if (targetAthlete.user_id) {
    // One directory up: this app lives at coach-app/dashboard.html, so
    // 'athlete-app/...' resolved against it would point at
    // coach-app/athlete-app/..., which doesn't exist.
    const url = new URL('../athlete-app/dashboard.html', window.location.href).href
    sendPush(supabase, targetAthlete.user_id, 'Tobe-Fit', message, url) // not awaited
  }

  // Reloads the CURRENTLY selected athlete's thread (selectCommsAthlete
  // already does this on switch), which is correct even if the coach
  // switched rows mid-send - this refresh is "make sure what's on screen
  // is current", not "show the result of the send I just did".
  loadChatMessages()
}
