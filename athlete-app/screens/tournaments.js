// ==========================================================================
// ATHLETE APP - tournaments
// Loading, listing and adding the athlete's own tournaments, plus the latest
// bodyweight shown on Home.
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import { sendPush } from '../../push.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { escapeHtml } from '../../escape.js?v=__V__'
import { toDateStr, parseDateStr, addDays } from '../../shared/dates.js?v=__V__'
import { pageContent, athlete } from '../state.js?v=__V__'
import { CHEVRON_LEFT, formatDisplayDate, formatShortDate } from '../format.js?v=__V__'
import { insertOnce, saveWithRetry } from '../outbox.js?v=__V__'

let tournamentsCache = [] // every upcoming+past tournaments row for this athlete, sorted by date
export let tournamentsByDate = {} // 'YYYY-MM-DD' -> tournaments row
export let latestBodyweightRow = null // { date, weight } for this athlete's most recent bodyweight entry, or null - refreshed by loadLatestBodyweight()
// Same "tap a number, see what it means" mechanic as RPE above, for the
// athlete's own upcoming-tournament importance rating.
const TOURNAMENT_IMPORTANCE_DESCRIPTIONS = {
  1: 'Not important at all - just for fun or experience',
  2: 'Low priority - a tune-up event',
  3: 'Moderately important - worth some focused prep',
  4: 'Important - a key event this season',
  5: 'Most important tournament of the year - tapering needed'
}

// ==========================================================================
// ---- TOURNAMENTS ----
// Athlete-added upcoming tournaments/competitions: a name, a date, and a
// 1-5 importance rating using the same "tap the number, see what it means"
// mechanic as the RPE picker above. Visible on this athlete's own week
// strip (renderWeekView) and, read-only, on the coach's month calendar
// (athlete-calendar.js) - both read from the same tournaments table.
// A coach can also add a tournament for the athlete (created_by_coach).
// Those show here like any other, but with NO importance rating - the
// coach's rating is private and is never even sent to this app (it lives in
// tournament_coach_ratings, which athletes can't read; the row's own
// importance is null) - and the athlete can't edit or delete them.
// ==========================================================================

// Fires a row into the coach's notification bell (see bell.js) - never
// awaited by callers, a failed insert shouldn't block or alert on the
// athlete's own flow, same reasoning as the "not awaited" background saves
// elsewhere in this file (e.g. saveSessionEnd).
export async function notifyCoach(type, message) {
  const { error } = await supabase
    .from('notifications')
    .insert([{ coach_id: athlete.coach_id, athlete_id: athlete.id, type, message }])
  if (error) console.log(error)

  // A new chat message opens straight into that conversation in Chat;
  // every other notification type lands on this athlete's profile. The
  // coach app reads ?screen=&id= on startup - see readDeepLink() in
  // coach-app/dashboard.js.
  const screen = type === 'chat_message' ? 'communication' : 'athlete-detail'
  const url = new URL(`../coach-app/dashboard.html?screen=${screen}&id=${athlete.id}`, window.location.href).href
  sendPush(supabase, athlete.coach_id, 'Tobe-Fit', message, url) // not awaited, same as the insert above
}

// All the calendar-day dates a tournament covers, inclusive of both ends -
// a single-day tournament (date === end_date) is just a one-element range
function eachDateStrInRange(startStr, endStr) {
  const dates = []
  let cursor = parseDateStr(startStr)
  while (toDateStr(cursor) <= endStr) {
    dates.push(toDateStr(cursor))
    cursor = addDays(cursor, 1)
  }
  return dates
}

function formatTournamentDateRange(t) {
  if (t.date === t.end_date) return formatDisplayDate(t.date)
  return `${formatShortDate(parseDateStr(t.date))} – ${formatShortDate(parseDateStr(t.end_date))}`
}

export async function loadTournaments() {
  const { data, error } = await saveWithRetry((signal) => supabase
    .from('tournaments')
    .select('*')
    .eq('athlete_id', athlete.id)
    .order('date')
    .abortSignal(signal)
  )
  if (error) { console.log(error); return }
  tournamentsCache = data || []
  tournamentsByDate = {}
  for (const t of tournamentsCache) {
    for (const dateStr of eachDateStrInRange(t.date, t.end_date)) tournamentsByDate[dateStr] = t
  }
}

// Just the single most recent entry - enough for the Log Weight tile's
// sublabel on Home. The same `bodyweight` table the coach's "Log weight"
// button on the athlete profile writes to (see athlete-detail/), so an
// entry logged from either side shows up for the other immediately.
export async function loadLatestBodyweight() {
  const { data, error } = await saveWithRetry((signal) => supabase
    .from('bodyweight')
    .select('date, weight')
    .eq('athlete_id', athlete.id)
    .order('date', { ascending: false })
    .limit(1)
    .abortSignal(signal)
  )
  if (error) { console.log(error); return }
  latestBodyweightRow = (data && data[0]) || null
}

export function renderTournaments() {
  nav.enter('tournaments', {})
  const todayStr = toDateStr(new Date())
  // A multi-day tournament that's already started but hasn't finished yet
  // still belongs in "upcoming" - filtering on end_date, not date, keeps
  // it visible for its whole run instead of dropping off after day 1
  const upcoming = tournamentsCache.filter(t => t.end_date >= todayStr)

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button class="icon-btn" id="backFromTournamentsBtn" aria-label="Back">${CHEVRON_LEFT}</button>
      <h2 class="day-view-date">Upcoming Tournaments</h2>
    </div>
    <button type="button" class="btn-save" id="addTournamentBtn" style="margin-bottom:16px">+ Add Tournament</button>
    ${upcoming.length === 0 ? '<p class="no-metrics">No upcoming tournaments yet</p>' : `
      <div class="tournament-list">
        ${upcoming.map(t => `
          <div class="tournament-list-row" data-id="${t.id}">
            <div class="tournament-list-info">
              <span class="tournament-list-name">${escapeHtml(t.name)}</span>
              <span class="tournament-list-date">${formatTournamentDateRange(t)}</span>
            </div>
            ${t.created_by_coach ? `
            <span class="tournament-list-badge tournament-list-badge-coach">Added by your coach</span>` : `
            <span class="tournament-list-badge">⭐ ${t.importance}/5</span>
            <button type="button" class="tournament-list-delete-btn" data-id="${t.id}" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`}
          </div>
        `).join('')}
      </div>
    `}
  `

  document.getElementById('backFromTournamentsBtn').addEventListener('click', nav.back)
  document.getElementById('addTournamentBtn').addEventListener('click', renderAddTournamentForm)

  document.querySelectorAll('.tournament-list-delete-btn').forEach(btn => {
    btn.addEventListener('click', async function() {
      const ok = await customConfirm('Delete this tournament?')
      if (!ok) return
      const { error } = await saveWithRetry((signal) => supabase
        .from('tournaments')
        .delete()
        .eq('id', btn.dataset.id)
        .abortSignal(signal)
      )
      if (error) { console.log(error); customAlert('Something went wrong deleting that - try again'); return }
      await loadTournaments()
      renderTournaments()
    })
  })
}

export function renderAddTournamentForm() {
  nav.enter('addTournament', {})
  let selectedImportance = null

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button class="icon-btn" id="cancelAddTournamentBtn" aria-label="Back">${CHEVRON_LEFT}</button>
      <h2 class="day-view-date">Add Tournament</h2>
    </div>
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="tournamentNameInput" placeholder="e.g. State Championships" />
    </div>
    <div class="form-group">
      <label>Start Date</label>
      <input type="date" id="tournamentStartDateInput" min="${toDateStr(new Date())}" />
    </div>
    <div class="form-group">
      <label>End Date</label>
      <input type="date" id="tournamentEndDateInput" min="${toDateStr(new Date())}" />
      <p style="color:var(--c-text-muted); font-size:12px; margin-top:4px">Same as start date for a single-day event</p>
    </div>
    <div class="importance-picker">
      <p class="importance-picker-label">How important is this tournament?</p>
      <div class="importance-picker-row">
        ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="importance-btn" data-importance="${n}">${n}</button>`).join('')}
      </div>
      <p class="importance-picker-hint" id="tournamentImportanceHint">Tap a number to see what it means</p>
    </div>
    <button type="button" class="btn-save start-workout-btn" id="saveTournamentBtn" style="margin-top:20px">Save Tournament</button>
  `

  document.getElementById('cancelAddTournamentBtn').addEventListener('click', nav.back)

  // Picking a start date auto-fills the end date to match (the common
  // single-day case needs no extra tap) - it only re-syncs when the end
  // date is missing or would now fall before the start, so dragging the
  // end date forward for a multi-day event sticks even if the start date
  // gets nudged around afterward
  const startInput = document.getElementById('tournamentStartDateInput')
  const endInput = document.getElementById('tournamentEndDateInput')
  startInput.addEventListener('change', function() {
    endInput.min = startInput.value
    if (!endInput.value || endInput.value < startInput.value) endInput.value = startInput.value
  })

  document.querySelectorAll('.importance-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.importance-btn').forEach(b => b.classList.remove('selected'))
      btn.classList.add('selected')
      selectedImportance = parseInt(btn.dataset.importance)
      document.getElementById('tournamentImportanceHint').textContent = TOURNAMENT_IMPORTANCE_DESCRIPTIONS[selectedImportance]
    })
  })

  document.getElementById('saveTournamentBtn').addEventListener('click', async function() {
    const name = document.getElementById('tournamentNameInput').value.trim()
    const date = startInput.value
    const endDate = endInput.value || date
    if (!name) { customAlert('Please enter a name for this tournament'); return }
    if (!date) { customAlert('Please pick a start date'); return }
    if (endDate < date) { customAlert("End date can't be before the start date"); return }
    if (!selectedImportance) { customAlert('Please rate how important this tournament is'); return }

    const { error } = await insertOnce('tournaments',
      { id: crypto.randomUUID(), athlete_id: athlete.id, name, date, end_date: endDate, importance: selectedImportance })
    if (error) { console.log(error); customAlert('Something went wrong saving that - try again'); return }
    notifyCoach('tournament_added', `${athlete.name} added a tournament: ${name}`)
    await loadTournaments()
    renderTournaments()
  })
}
