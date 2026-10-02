// ==========================================================================
// ATHLETE APP - Chat tab
// Unread badge on the Chat tab, the chat screen, and image resizing for
// attachments.
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { escapeHtml, safeUrl } from '../../escape.js?v=__V__'
import { signReportLinks } from '../../report-links.js?v=__V__'
import { pageContent, athlete } from '../state.js?v=__V__'
import { saveWithRetry } from '../outbox.js?v=__V__'
import { notifyCoach } from './tournaments.js?v=__V__'

// Small red dot on the Chat tab, mirroring the coach app's own (see
// coach-app/bell.js's refreshChatBadge) - same chat_messages/read_at
// convention, just sender='coach' since this is the other side of the
// same conversation. No existing polling engine on this side (the athlete
// app has no bell.js equivalent), so this owns its own interval/
// visibilitychange pair, started once from enterWeekView().
export async function refreshChatNavBadge() {
  const { count, error } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender', 'coach')
    .is('read_at', null)
  if (error) { console.log(error); return }
  const dot = document.getElementById('chatNavBadge')
  if (dot) dot.style.display = count > 0 ? '' : 'none'
}

// Chat with this athlete's own coach - real persistent history
// (chat_messages), separate from the one-shot coach_messages popup queue
// (loadCoachMessages() above) which deletes itself from view the moment
// it's seen and can't hold a log. Loaded fresh every time this tab opens,
// same poll-on-open convention as the rest of this file (no live
// subscription). Renders any message with pdf_url set as an attachment link.
export async function renderCommunication() {
  nav.enter('chat', {}, { root: true, tab: 'communication' })
  pageContent.innerHTML = `
    <div class="day-view-header">
      <h2 class="day-view-date">Chat with your coach</h2>
    </div>
    <div class="chat-messages" id="chatMessages"><p class="no-metrics">Loading...</p></div>
    <div class="chat-input-row">
      <input type="text" id="chatInput" placeholder="Type a message..." maxlength="2000" />
      <button type="button" class="btn-save" id="chatSendBtn">Send</button>
    </div>
  `

  document.getElementById('chatSendBtn').addEventListener('click', sendChatMessageToCoach)
  document.getElementById('chatInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendChatMessageToCoach()
  })

  await loadChatMessagesFromCoach()
}

async function loadChatMessagesFromCoach() {
  const container = document.getElementById('chatMessages')
  if (!container) return // athlete navigated away before this resolved

  const { data, error } = await saveWithRetry((signal) => supabase
    .from('chat_messages')
    .select('*')
    .eq('athlete_id', athlete.id)
    .order('created_at', { ascending: true })
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading chat:', error)
    container.innerHTML = '<p class="no-metrics">Something went wrong loading this chat - try again</p>'
    return
  }

  await signReportLinks(supabase, data)
  renderChatBubbles(data)

  const unreadIds = data.filter(m => m.sender === 'coach' && !m.read_at).map(m => m.id)
  if (unreadIds.length > 0) {
    await supabase.from('chat_messages').update({ read_at: new Date().toISOString() }).in('id', unreadIds)
    refreshChatNavBadge()
  }
}

function renderChatBubbles(messages) {
  const container = document.getElementById('chatMessages')
  if (!container) return
  if (messages.length === 0) {
    container.innerHTML = '<p class="no-metrics">No messages yet - say hi!</p>'
    return
  }
  container.innerHTML = messages.map(m => `
    <div class="chat-bubble chat-bubble-${m.sender === 'athlete' ? 'mine' : 'theirs'}">
      ${m.message ? `<p>${escapeHtml(m.message)}</p>` : ''}
      ${m.pdf_url ? (safeUrl(m.report_url) ? `<a href="${safeUrl(m.report_url)}" target="_blank" rel="noopener" class="chat-pdf-link">📄 View Report</a>` : '<span class="chat-pdf-link">📄 Report link unavailable - reopen the chat to try again</span>') : ''}
      <span class="chat-bubble-time">${new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
    </div>
  `).join('')
  container.scrollTop = container.scrollHeight
}

async function sendChatMessageToCoach() {
  const input = document.getElementById('chatInput')
  const message = input.value.trim()
  if (!message) return

  input.value = ''
  input.disabled = true

  const { error } = await supabase.from('chat_messages').insert([{
    coach_id: athlete.coach_id,
    athlete_id: athlete.id,
    sender: 'athlete',
    message
  }])

  input.disabled = false

  if (error) {
    console.log('Error sending message:', error)
    customAlert('Something went wrong sending that - try again')
    input.value = message
    return
  }

  notifyCoach('chat_message', `${athlete.name}: ${message}`) // not awaited - also pushes + bells the coach
  loadChatMessagesFromCoach()
}

// Downscales + re-encodes as JPEG client-side before upload, regardless of
// how big the original photo was (a phone camera photo can be several MB) -
// a profile picture is only ever shown at avatar size, so there's no reason
// to store or transfer more than maxSize px on the longest side. Avoids
// needing any upload-size-limit handling entirely, the same problem the PDF
// report's chart images ran into.
export function resizeImageFile(file, maxSize) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(img.src)
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/jpeg', 0.85)
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}
