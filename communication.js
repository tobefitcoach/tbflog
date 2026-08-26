// ==========================================================================
// COMMUNICATION — coach's inbox across every athlete
// Two-pane layout: an athlete list on the left (loadCommsAthletes), the
// selected athlete's full chat_messages history + a send box on the right
// (selectCommsAthlete/loadChatMessages/sendChatMessage). Replaces the old
// per-athlete "Communication" tab that used to live on athlete.html - the
// chat itself (chat_messages table, chat-attachments storage bucket) is
// unchanged, this is just a different front door onto the same data so
// the coach doesn't have to open a specific athlete's profile first.
// ==========================================================================
import { supabase } from './coachClient.js'
import { sendPush } from './push.js'

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
}

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'login.html'
})

let allCommsAthletes = []
let unreadCountByAthlete = {} // athlete_id -> count of unread athlete-sent messages
let selectedAthlete = null

function escapeHtml(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

loadCommsAthletes()

async function loadCommsAthletes() {
  const { data: athletes, error } = await supabase
    .from('athletes')
    .select('*')
    .eq('archived', false)
    .order('name')

  if (error) {
    console.log('Error loading athletes:', error)
    document.getElementById('commsAthleteList').innerHTML = '<p class="no-metrics">Something went wrong loading your athletes - check your connection and try again</p>'
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

  unreadCountByAthlete = {}
  for (const row of (unreadRows || [])) {
    unreadCountByAthlete[row.athlete_id] = (unreadCountByAthlete[row.athlete_id] || 0) + 1
  }

  renderCommsAthleteList()

  // Deep link from the notification bell / a push notification - e.g.
  // communication.html?id=42 opens straight into that athlete's chat
  const preselectId = new URLSearchParams(window.location.search).get('id')
  if (preselectId) {
    const match = allCommsAthletes.find(a => String(a.id) === preselectId)
    if (match) selectCommsAthlete(match)
  }
}

function renderCommsAthleteList() {
  const list = document.getElementById('commsAthleteList')
  if (allCommsAthletes.length === 0) {
    list.innerHTML = '<p class="no-metrics">No athletes yet</p>'
    return
  }
  list.innerHTML = allCommsAthletes.map(a => {
    const initials = a.name.split(' ').map(word => word[0]).join('').toUpperCase()
    const unread = unreadCountByAthlete[a.id] || 0
    return `
      <button type="button" class="comms-athlete-row ${selectedAthlete && selectedAthlete.id === a.id ? 'active' : ''}" data-athlete-id="${a.id}">
        <div class="athlete-initials">${initials}</div>
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

function selectCommsAthlete(athlete) {
  selectedAthlete = athlete
  renderCommsAthleteList() // re-render so the newly-selected row highlights

  document.getElementById('commsEmptyState').style.display = 'none'
  document.getElementById('commsActiveChat').style.display = 'block'
  document.getElementById('commsChatHeader').innerHTML = `<h3>${escapeHtml(athlete.name)}</h3>`

  // Keeps the URL deep-linkable (refresh, or share the link) without a
  // full page reload
  const url = new URL(window.location.href)
  url.searchParams.set('id', athlete.id)
  window.history.replaceState({}, '', url)

  loadChatMessages()
}

document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage)
document.getElementById('chatInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') sendChatMessage()
})

async function loadChatMessages() {
  const container = document.getElementById('chatMessages')
  container.innerHTML = '<p class="no-metrics">Loading...</p>'

  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('athlete_id', selectedAthlete.id)
    .order('created_at', { ascending: true })

  if (error) {
    console.log('Error loading chat:', error)
    container.innerHTML = '<p class="no-metrics">Something went wrong loading this chat - try again</p>'
    return
  }

  renderChatMessages(data)

  const unreadIds = data.filter(m => m.sender === 'athlete' && !m.read_at).map(m => m.id)
  if (unreadIds.length > 0) {
    await supabase.from('chat_messages').update({ read_at: new Date().toISOString() }).in('id', unreadIds)
    delete unreadCountByAthlete[selectedAthlete.id]
    renderCommsAthleteList()
  }
}

function renderChatMessages(messages) {
  const container = document.getElementById('chatMessages')
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
  const input = document.getElementById('chatInput')
  const message = input.value.trim()
  if (!message || !selectedAthlete) return

  input.value = ''
  input.disabled = true

  const { error } = await supabase.from('chat_messages').insert([{
    coach_id: session.user.id,
    athlete_id: selectedAthlete.id,
    sender: 'coach',
    message
  }])

  input.disabled = false

  if (error) {
    console.log('Error sending message:', error)
    customAlert('Something went wrong sending that - try again')
    input.value = message
    return
  }

  if (selectedAthlete.user_id) {
    const url = new URL('athlete-app/dashboard.html', window.location.href).href
    sendPush(supabase, selectedAthlete.user_id, 'TBFlog', message, url) // not awaited
  }

  loadChatMessages()
}
