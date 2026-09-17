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
// There is no SKELETON here, and no load before the first paint: the
// markup is static and the athlete list carries its own "Loading..." line,
// same as the settings screen. See screens/_placeholder.js for the full
// contract.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import { sendPush } from '../../push.js'
import * as nav from '../nav.js'
import { coachId } from '../session.js'

// Two-pane inbox: athlete list on the left, the selected athlete's full
// chat_messages history + a send box on the right - see
// selectCommsAthlete(). params.id deep-links straight into one athlete's
// conversation (used by the notification bell and by push notifications
// for a new chat message).
const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Communication</h2>
  </div>
  <div class="comms-layout">
    <div class="comms-athlete-list" id="commsAthleteList">
      <p class="no-metrics">Loading...</p>
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
let selectedAthlete = null

export async function mount(container, params, token) {
  root = container
  mountToken = token
  container.innerHTML = TEMPLATE
  bindEvents()
  await loadCommsAthletes(params.id)
}

export function unmount() {
  // Nothing to detach: every listener this screen registers is on an
  // element inside its own markup, which the router throws away wholesale
  // on the next mount. Kept as an explicit note rather than an empty
  // function body, so the next person doesn't have to re-derive it.
  root = null
  mountToken = null
  allCommsAthletes = []
  unreadCountByAthlete = {}
  selectedAthlete = null
}

function bindEvents() {
  root.querySelector('#chatSendBtn').addEventListener('click', sendChatMessage)
  root.querySelector('#chatInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendChatMessage()
  })
}

function escapeHtml(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
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
    root.querySelector('#commsAthleteList').innerHTML = '<p class="no-metrics">Something went wrong loading your athletes - check your connection and try again</p>'
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

  renderCommsAthleteList()

  // Deep link from the notification bell / a push notification - what used
  // to be communication.html?id=42 is now a route param, so this opens
  // straight into that athlete's chat
  if (preselectId) {
    const match = allCommsAthletes.find(a => String(a.id) === String(preselectId))
    if (match) selectCommsAthlete(match)
  }
}

function renderCommsAthleteList() {
  const list = root.querySelector('#commsAthleteList')
  if (allCommsAthletes.length === 0) {
    list.innerHTML = '<p class="no-metrics">No athletes yet</p>'
    return
  }
  list.innerHTML = allCommsAthletes.map(a => {
    const initials = a.name.split(' ').map(word => word[0]).join('').toUpperCase()
    const avatarHtml = a.avatar_url ? `<img src="${a.avatar_url}" class="avatar-img" alt="">` : initials
    const unread = unreadCountByAthlete[a.id] || 0
    return `
      <button type="button" class="comms-athlete-row ${selectedAthlete && selectedAthlete.id === a.id ? 'active' : ''}" data-athlete-id="${a.id}">
        <div class="athlete-initials">${avatarHtml}</div>
        <span class="comms-athlete-name">${escapeHtml(a.name)}</span>
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
// rest of the session. Selecting an athlete is an in-screen move, not a
// navigation.
function selectCommsAthlete(athlete) {
  selectedAthlete = athlete
  renderCommsAthleteList() // re-render so the newly-selected row highlights

  root.querySelector('#commsEmptyState').style.display = 'none'
  root.querySelector('#commsActiveChat').style.display = 'block'
  root.querySelector('#commsChatHeader').innerHTML = `<h3>${escapeHtml(athlete.name)}</h3>`

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
  }
}

function renderChatMessages(messages) {
  const container = root.querySelector('#chatMessages')
  if (messages.length === 0) {
    container.innerHTML = '<p class="no-metrics">No messages yet - say hi!</p>'
    return
  }
  container.innerHTML = messages.map(m => `
    <div class="chat-bubble chat-bubble-${m.sender === 'coach' ? 'mine' : 'theirs'}">
      ${m.message ? `<p>${escapeHtml(m.message)}</p>` : ''}
      ${m.pdf_url ? `<a href="${m.pdf_url}" target="_blank" rel="noopener" class="chat-pdf-link">📄 View Report</a>` : ''}
      <span class="chat-bubble-time">${new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
    </div>
  `).join('')
  container.scrollTop = container.scrollHeight
}

async function sendChatMessage() {
  const input = root.querySelector('#chatInput')
  const message = input.value.trim()
  if (!message || !selectedAthlete) return

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
