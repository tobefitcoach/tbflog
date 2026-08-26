// ==========================================================================
// ATHLETE DASHBOARD
// Works out which of 4 states a logged-in athlete is in (same as before -
// see checkAccountState), then for a real linked athlete lands on a Week
// view: a welcome header + a 7-day strip for the current week (next week
// unlocks only if the coach turned on can_preview_next_week for this
// athlete). Tapping a day opens a read-only preview of that day's
// exercises; tapping "Start Workout" (today only) begins a guided,
// one-exercise-at-a-time flow that records a real start/end time
// (workout_sessions). Checking a set is one-way (never un-checks) and
// retries on save failure instead of losing what was logged.
//
// Mirrors the shape of the coach's athlete-calendar.js (same nested query,
// same date-math helpers) but duplicated rather than imported - this is a
// separate mini-app with its own Supabase client (see athleteClient.js).
// ==========================================================================
import { supabase } from './athleteClient.js'
import { pushStatus, enablePush, disablePush, sendPush } from '../push.js'

const pageContent = document.getElementById('pageContent')
const pageWrap = document.querySelector('.athlete-app-page')
const cardWrap = document.querySelector('.athlete-app-card')

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'index.html'
}

// ==========================================================================
// ---- BOTTOM NAV ----
// Lives outside #pageContent (declared once in dashboard.html), so
// re-rendering pageContent for every screen never wipes it out - this is
// what makes it a persistent tab bar instead of per-screen chrome. Hidden
// entirely (see enterWeekView) until there's a real athlete to navigate
// for; every click here is guarded the same way the old header buttons
// were, as a safety net for the brief pre-load window.
// ==========================================================================
document.getElementById('navHomeBtn').addEventListener('click', function() {
  if (athlete) renderWeekView(currentWeekStart || startOfWeek(new Date()))
})

// Also hidden entirely (see enterWeekView) unless the coach has
// can_view_weekly_stats on for this athlete
document.getElementById('navStatsBtn').addEventListener('click', function() {
  if (athlete) renderWeeklyStats()
})

document.getElementById('navCommsBtn').addEventListener('click', function() {
  if (athlete) renderCommunication()
})

document.getElementById('navSettingsBtn').addEventListener('click', function() {
  if (athlete) renderSettings()
})

document.getElementById('navProfileBtn').addEventListener('click', function() {
  if (athlete) renderProfile()
})

// Tabs are sticky, not re-asserted by every screen: only the 3 tab-root
// renderers below (renderWeekView/renderSettings/renderProfile) call this.
// Every other screen (Day Preview, Add Own Workout, Mobility, Tournaments,
// the guided workout itself, ...) is only ever reached by drilling down
// from Home, so leaving the highlight untouched while on one of those
// naturally keeps "Home" selected the whole time - correct without having
// to touch every render function in the file.
function setActiveBottomTab(tab) {
  document.querySelectorAll('.bottom-nav-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  })
}

document.getElementById('weeklyRecapCloseBtn').addEventListener('click', function() {
  document.getElementById('weeklyRecapModal').classList.remove('active')
  // Chained rather than both firing at app-entry independently - two
  // modal-overlays active at once would just overlap. Coach messages wait
  // for the recap to be dismissed first when both would otherwise show.
  maybeShowOnOpenMessages()
})

let athlete = null
let entriesByDate = {} // 'YYYY-MM-DD' -> array of { program, week, day }
let logSetsByPE = {} // program_exercise_id -> array of exercise_log_sets rows, sorted by set_number
// Whatever the athlete has typed into a not-yet-checked set's inputs, keyed
// by "peId-setNumber" - { reps, weight, distance }. renderSetRow reads from
// here first, falling back to the coach's target/previously-logged value
// only when nothing's been typed yet. Every exercise slide fully replaces
// pageContent's innerHTML on render (swiping, or a group step-through
// advancing), so without this, typing weights into a couple of sets and
// then swiping away - or just checking a DIFFERENT set, which re-renders
// the whole card - silently lost anything not yet checked off. Cleared for
// a set the instant it's actually checked (see checkSet), since the real
// saved value takes over as the source of truth at that point.
let draftSetValues = {}
let openSessionsByDayId = {} // program_days.id -> in-progress workout_sessions row (ended_at is null)
let completedSessionsByDayId = {} // program_days.id -> most recently-ended workout_sessions row
let mobilitySessionsByDate = {} // 'YYYY-MM-DD' -> workout_sessions row with session_type='mobility'
let tournamentsCache = [] // every upcoming+past tournaments row for this athlete, sorted by date
let tournamentsByDate = {} // 'YYYY-MM-DD' -> tournaments row
let restTimerInterval = null
let mobilityTimerInterval = null
let stretchLibraryCache = null              // stretches visible to this athlete (RLS-scoped to their coach)
let athleteStretchPreferencesCache = null   // Map<stretch_id, 'liked'|'disliked'>
let mobilityFlowInterval = null             // countdown for the guided flow screen, parallel to mobilityTimerInterval
let currentWeekStart = null // Date (Monday) of the currently-shown week, for "back to week"
let coachName = null // fetched once, lazily, the first time the Profile tab is opened

// Session RPE (1-10, modified Borg CR-10 scale) - this exact scale is what
// Training Load's session_rpe x duration_minutes formula (loadOverviewStats,
// athlete.js) and ACWR/monotony/strain are built on, so these anchors are
// meant to match how those numbers are already interpreted, not just be
// friendly-sounding text. Shown live under the RPE buttons (both here and
// in renderWorkoutSummary) so tapping a number confirms what it means
// instead of the athlete guessing.
const RPE_DESCRIPTIONS = {
  1: 'Very light - minimal effort',
  2: 'Light - easy, comfortable',
  3: 'Light-moderate - noticeable but sustainable',
  4: 'Moderate - working, steady effort',
  5: 'Moderate-hard - pushing, needs focus',
  6: 'Hard - challenging, effort building',
  7: 'Very hard - strong effort, fatigue setting in',
  8: 'Very hard - close to your limit',
  9: 'Extremely hard - almost everything you had',
  10: 'Maximal - absolute max, nothing left'
}

// Same "tap a number, see what it means" mechanic as RPE above, for the
// athlete's own upcoming-tournament importance rating.
const TOURNAMENT_IMPORTANCE_DESCRIPTIONS = {
  1: 'Not important at all - just for fun or experience',
  2: 'Low priority - a tune-up event',
  3: 'Moderately important - worth some focused prep',
  4: 'Important - a key event this season',
  5: 'Most important tournament of the year - tapering needed'
}

checkAccountState()

async function checkAccountState() {
  const { data: profile, error: profileError } = await saveWithRetry((signal) => supabase
    .from('profiles')
    .select('role, name')
    .eq('id', session.user.id)
    .single()
    .abortSignal(signal)
  )

  if (profileError || !profile || profile.role !== 'athlete') {
    renderWrongRole()
    return
  }

  const { data: foundAthlete } = await saveWithRetry((signal) => supabase
    .from('athletes')
    .select('id, name, can_preview_next_week, weight_unit, weekly_recap_enabled, can_self_log_workouts, can_add_exercises, can_change_exercises, can_reschedule_workouts, can_view_weekly_stats, coach_id')
    .eq('user_id', session.user.id)
    .maybeSingle()
    .abortSignal(signal)
  )

  if (foundAthlete) {
    athlete = foundAthlete
    // needs_password is stamped into signup metadata by sendInviteEmail()
    // (coach's script.js/athlete.js) the moment the invite creates this
    // account, and cleared once they actually set one below - this is more
    // reliable than trying to sniff the invite-link redirect itself
    // (Supabase's exact redirect shape depends on internal auth flow
    // settings, which turned out not to match a hash-based `type=magiclink`
    // assumption in practice).
    if (session.user.user_metadata?.needs_password) { renderSetPasswordPrompt(); return }
    await enterWeekView()
    return
  }

  // Not linked yet - try to auto-link by matching the signup email against
  // an unclaimed athlete row (see claim_athlete_by_email() in the database)
  const { error: claimError } = await supabase.rpc('claim_athlete_by_email')

  if (!claimError) {
    window.location.reload()
    return
  }

  renderWaitingToBeLinked()
}

function renderWrongRole() {
  pageContent.innerHTML = `
    <h2>Wrong login</h2>
    <p>This is the athlete login, and this account isn't set up as an athlete. If you're a coach, use the main TBFlog login instead.</p>
    <button class="btn-save" id="signOutBtn">Sign Out</button>
  `
  document.getElementById('signOutBtn').addEventListener('click', async function() {
    await supabase.auth.signOut()
    window.location.href = 'index.html'
  })
}

function renderWaitingToBeLinked() {
  pageContent.innerHTML = `
    <h2>Almost there</h2>
    <p>Your coach hasn't linked your account yet. Once they've added your email to your athlete profile, click below to try again.</p>
    <button class="btn-save" id="retryBtn">Try Again</button>
  `
  document.getElementById('retryBtn').addEventListener('click', checkAccountState)
}

// Shown exactly once, right after an athlete arrives via their coach's
// invite email - that link signs them in passwordlessly (a magic link),
// which is fine for this first tap but annoying for daily use (leaving the
// app to check email every time). Setting a password here means every
// login after this one is the normal email+password flow.
function renderSetPasswordPrompt() {
  pageContent.innerHTML = `
    <h2>Welcome, ${athlete.name}!</h2>
    <p>You're signed in. Set a password now so you can log back in directly next time, without needing another email link.</p>
    <div class="form-group">
      <label>New Password</label>
      <input type="password" id="newPasswordInput" placeholder="At least 6 characters" />
    </div>
    <button class="btn-save" id="savePasswordBtn">Save Password</button>
    <p style="margin-top:12px"><a href="#" id="skipPasswordBtn" style="color:#aaaacc">Skip for now</a></p>
  `

  document.getElementById('savePasswordBtn').addEventListener('click', async function() {
    const password = document.getElementById('newPasswordInput').value
    if (!password || password.length < 6) {
      customAlert('Please enter at least 6 characters')
      return
    }
    const { error } = await supabase.auth.updateUser({
      password,
      data: { ...session.user.user_metadata, needs_password: false }
    })
    if (error) {
      console.log(error)
      customAlert('Something went wrong saving your password - you can try again from Settings later.')
      return
    }
    enterWeekView()
  })

  document.getElementById('skipPasswordBtn').addEventListener('click', function(e) {
    e.preventDefault()
    enterWeekView()
  })
}

async function enterWeekView() {
  document.getElementById('bottomNav').style.display = 'flex'
  document.getElementById('navStatsBtn').style.display = athlete.can_view_weekly_stats ? '' : 'none'
  await loadTrainingData()
  await loadTournaments()
  await loadCoachMessages()
  renderWeekView(startOfWeek(new Date()))
  // Only one modal-overlay should ever be active at once - if the recap
  // actually shows, its own close button chains into
  // maybeShowOnOpenMessages() afterward instead of this firing right away
  const recapShown = maybeShowWeeklyRecap()
  if (!recapShown) maybeShowOnOpenMessages()
  flushPendingQueue() // not awaited - picks up anything left over from a previous session
  flushPendingSessionEnds()
}

// A place for per-athlete settings that live outside the coach-editable
// Settings tab (which is on the coach's own athlete page) - this one is
// self-service, for things the athlete should be able to change themselves.
function pushStatusDesc(status) {
  if (status === 'on') return 'On - your coach can message you even when the app is closed'
  if (status === 'denied') return 'Blocked in your browser settings - re-enable notifications for this site to turn this on'
  if (status === 'unsupported') return "This browser doesn't support push notifications"
  return 'Get notified even when the app is closed'
}

// Chat with this athlete's own coach - real persistent history
// (chat_messages), separate from the one-shot coach_messages popup queue
// (loadCoachMessages() above) which deletes itself from view the moment
// it's seen and can't hold a log. Loaded fresh every time this tab opens,
// same poll-on-open convention as the rest of this file (no live
// subscription). A shared PDF report (see shareReportWithAthlete() in
// athlete.js) shows up here as a message with pdf_url set.
async function renderCommunication() {
  setActiveBottomTab('communication')
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

  renderChatBubbles(data)

  const unreadIds = data.filter(m => m.sender === 'coach' && !m.read_at).map(m => m.id)
  if (unreadIds.length > 0) {
    await supabase.from('chat_messages').update({ read_at: new Date().toISOString() }).in('id', unreadIds)
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
      ${m.pdf_url ? `<a href="${m.pdf_url}" target="_blank" rel="noopener" class="chat-pdf-link">📄 View Report</a>` : ''}
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

async function renderSettings() {
  setActiveBottomTab('settings')
  const status = await pushStatus() // local browser check only, no network - fast enough to await before the first render
  pageContent.innerHTML = `
    <div class="settings-row">
      <div class="settings-row-info">
        <div class="settings-row-title">Weight units</div>
      </div>
      <div class="unit-toggle-switch">
        <span class="${athlete.weight_unit !== 'lbs' ? 'active' : ''}">kg</span>
        <label class="toggle-switch">
          <input type="checkbox" id="weightUnitToggle" ${athlete.weight_unit === 'lbs' ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span class="${athlete.weight_unit === 'lbs' ? 'active' : ''}">lbs</span>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-row-info">
        <div class="settings-row-title">Weekly recap</div>
        <div class="settings-row-desc">Get a summary of what you completed each week</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="weeklyRecapToggle" ${athlete.weekly_recap_enabled ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div class="settings-row">
      <div class="settings-row-info">
        <div class="settings-row-title">🔔 Push Notifications</div>
        <div class="settings-row-desc" id="pushStatusDesc">${pushStatusDesc(status)}</div>
      </div>
      <button type="button" class="btn-profile-action" id="pushToggleBtn">${status === 'on' ? 'Disable' : 'Enable'}</button>
    </div>
    <button class="btn-cancel" id="backFromSettingsBtn" style="margin-top:20px">Go Back</button>
  `

  document.getElementById('backFromSettingsBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

  // Turning ON needs a real user tap (browsers require a user gesture to
  // show the permission prompt, so this can't be a silent toggle like the
  // two above) - re-renders the whole screen after either action so the
  // button label/description reflect what actually happened
  document.getElementById('pushToggleBtn').addEventListener('click', async function(e) {
    e.target.disabled = true
    if (status === 'on') await disablePush(supabase)
    else await enablePush(supabase, session.user.id)
    renderSettings()
  })

  document.getElementById('weightUnitToggle').addEventListener('change', async function(e) {
    const newUnit = e.target.checked ? 'lbs' : 'kg'
    const previousUnit = athlete.weight_unit
    athlete.weight_unit = newUnit // optimistic, same pattern used everywhere else in this file

    const labels = e.target.closest('.unit-toggle-switch').querySelectorAll('span')
    labels[0].classList.toggle('active', newUnit === 'kg')
    labels[1].classList.toggle('active', newUnit === 'lbs')

    const { error } = await saveWithRetry((signal) => supabase
      .from('athletes')
      .update({ weight_unit: newUnit })
      .eq('id', athlete.id)
      .abortSignal(signal)
    )

    if (error) {
      console.log(error)
      athlete.weight_unit = previousUnit
      e.target.checked = previousUnit === 'lbs'
      labels[0].classList.toggle('active', previousUnit === 'kg')
      labels[1].classList.toggle('active', previousUnit === 'lbs')
      customAlert('Something went wrong saving that - try again')
    }
  })

  document.getElementById('weeklyRecapToggle').addEventListener('change', async function(e) {
    const newValue = e.target.checked
    const previousValue = athlete.weekly_recap_enabled
    athlete.weekly_recap_enabled = newValue

    const { error } = await saveWithRetry((signal) => supabase
      .from('athletes')
      .update({ weekly_recap_enabled: newValue })
      .eq('id', athlete.id)
      .abortSignal(signal)
    )

    if (error) {
      console.log(error)
      athlete.weekly_recap_enabled = previousValue
      e.target.checked = previousValue
      customAlert('Something went wrong saving that - try again')
    }
  })
}

// Athlete's own name + their coach's name, plus Log Out (moved out of the
// old header now that it's just the logo). Coach's name isn't already
// loaded anywhere in this app (the athletes row only carries coach_id), so
// it's fetched lazily here, once, the first time this tab is opened.
async function renderProfile() {
  setActiveBottomTab('profile')
  pageContent.innerHTML = `
    <div class="day-view-header">
      <h2 class="day-view-date">Profile</h2>
    </div>
    <p class="no-metrics">Loading...</p>
  `

  if (coachName === null) {
    const { data } = await saveWithRetry((signal) => supabase
      .from('profiles')
      .select('name')
      .eq('id', athlete.coach_id)
      .maybeSingle()
      .abortSignal(signal)
    )
    coachName = (data && data.name) || ''
  }

  pageContent.innerHTML = `
    <div class="day-view-header">
      <h2 class="day-view-date">Profile</h2>
    </div>
    <div class="settings-row">
      <div class="settings-row-info"><div class="settings-row-title">Name</div></div>
      <span>${escapeHtml(athlete.name)}</span>
    </div>
    ${coachName ? `
    <div class="settings-row">
      <div class="settings-row-info"><div class="settings-row-title">Coach</div></div>
      <span>${escapeHtml(coachName)}</span>
    </div>` : ''}
    <button type="button" class="btn-cancel" id="profileLogoutBtn" style="margin-top:24px">Log Out</button>
  `

  document.getElementById('profileLogoutBtn').addEventListener('click', async function() {
    await supabase.auth.signOut()
    window.location.href = 'index.html'
  })
}

// ==========================================================================
// ---- TOURNAMENTS ----
// Athlete-added upcoming tournaments/competitions: a name, a date, and a
// 1-5 importance rating using the same "tap the number, see what it means"
// mechanic as the RPE picker above. Visible on this athlete's own week
// strip (renderWeekView) and, read-only, on the coach's month calendar
// (athlete-calendar.js) - both read from the same tournaments table.
// ==========================================================================

// Only used for user-entered free text rendered via innerHTML (a
// tournament's name) - every other string in this file is either
// hard-coded or already-known-safe data, so this is deliberately not
// applied everywhere (same convention as escapeHtmlCal in athlete-calendar.js).
function escapeHtml(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// Fires a row into the coach's notification bell (see bell.js) - never
// awaited by callers, a failed insert shouldn't block or alert on the
// athlete's own flow, same reasoning as the "not awaited" background saves
// elsewhere in this file (e.g. saveSessionEnd).
async function notifyCoach(type, message) {
  const { error } = await supabase
    .from('notifications')
    .insert([{ coach_id: athlete.coach_id, athlete_id: athlete.id, type, message }])
  if (error) console.log(error)

  // A new chat message opens straight into that conversation in the
  // Communication inbox; every other notification type still lands on
  // this athlete's profile page, same as before
  const targetPage = type === 'chat_message' ? 'communication.html' : 'athlete.html'
  const url = new URL(`../${targetPage}?id=${athlete.id}`, window.location.href).href
  sendPush(supabase, athlete.coach_id, 'TBFlog', message, url) // not awaited, same as the insert above
}

// tracks_weight/is_timed/is_unilateral/tracks_distance normally come
// straight from the exercise's own row (pe.exercises) - an explicit
// *_override on THIS program_exercises row (set by the coach in Workout
// Builder's "Adjust Fields", scoped to just this one workout) takes
// precedence instead. Merging the override into pe.exercises here, once
// per fetch, means every existing read of pe.exercises.* downstream (set
// rows, badges, volume calc, etc.) sees the right effective value with no
// other changes needed.
function applyFieldOverrides(pe) {
  if (!pe.exercises) return
  if (pe.tracks_weight_override != null) pe.exercises.tracks_weight = pe.tracks_weight_override
  if (pe.is_timed_override != null) pe.exercises.is_timed = pe.is_timed_override
  if (pe.is_unilateral_override != null) pe.exercises.is_unilateral = pe.is_unilateral_override
  if (pe.tracks_distance_override != null) pe.exercises.tracks_distance = pe.tracks_distance_override
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

async function loadTournaments() {
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

function renderTournaments() {
  const todayStr = toDateStr(new Date())
  // A multi-day tournament that's already started but hasn't finished yet
  // still belongs in "upcoming" - filtering on end_date, not date, keeps
  // it visible for its whole run instead of dropping off after day 1
  const upcoming = tournamentsCache.filter(t => t.end_date >= todayStr)

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button class="btn-cancel" id="backFromTournamentsBtn">← Back</button>
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
            <span class="tournament-list-badge">⭐ ${t.importance}/5</span>
            <button type="button" class="tournament-list-delete-btn" data-id="${t.id}" title="Delete">🗑</button>
          </div>
        `).join('')}
      </div>
    `}
  `

  document.getElementById('backFromTournamentsBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })
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

function renderAddTournamentForm() {
  let selectedImportance = null

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button class="btn-cancel" id="cancelAddTournamentBtn">← Back</button>
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
      <p style="color:#aaaacc; font-size:12px; margin-top:4px">Same as start date for a single-day event</p>
    </div>
    <div class="importance-picker">
      <p class="importance-picker-label">How important is this tournament?</p>
      <div class="importance-picker-row">
        ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="importance-btn" data-importance="${n}">${n}</button>`).join('')}
      </div>
      <p class="importance-picker-hint" id="tournamentImportanceHint">Tap a number to see what it means</p>
    </div>
    <button type="button" class="btn-save start-workout-btn" id="saveTournamentBtn" style="margin-top:20px">💾 Save Tournament</button>
  `

  document.getElementById('cancelAddTournamentBtn').addEventListener('click', renderTournaments)

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

    const { error } = await saveWithRetry((signal) => supabase
      .from('tournaments')
      .insert({ athlete_id: athlete.id, name, date, end_date: endDate, importance: selectedImportance })
      .abortSignal(signal)
    )
    if (error) { console.log(error); customAlert('Something went wrong saving that - try again'); return }
    notifyCoach('tournament_added', `${athlete.name} added a tournament: ${name}`)
    await loadTournaments()
    renderTournaments()
  })
}

// ==========================================================================
// ---- DATE HELPERS ----
// Same timezone-safe parsing convention used throughout the app
// (new Date(dateStr + 'T00:00:00')) - building YYYY-MM-DD strings by hand
// rather than via .toISOString(), which re-introduces an off-by-one bug.
// ==========================================================================
function toDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseDateStr(dateStr) {
  return new Date(dateStr + 'T00:00:00')
}

function formatDisplayDate(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
}

function formatShortDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function resolveDate(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStr(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStr(result)
}

function startOfWeek(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day // shift back to Monday
  d.setDate(d.getDate() + diff)
  return d
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function trainingDisplayName(entry) {
  if (entry.program.is_adhoc) return entry.program.name || 'Training'
  return entry.day.label || ('Day ' + entry.day.day_number)
}

// ==========================================================================
// ---- WEIGHT UNITS ----
// Weight is always STORED in kg (the app-wide metric-units rule) - these
// only convert for display/typing. kgToLbs/lbsToKg are the raw conversion,
// formatWeight is what render code should call: converts kg into whichever
// unit it's given and rounds to 1 decimal so the input doesn't fill up with
// long floating-point tails (e.g. 100kg -> 220.5 lbs, not 220.46226218).
// ==========================================================================
function kgToLbs(kg) { return kg * 2.2046226218 }
function lbsToKg(lbs) { return lbs / 2.2046226218 }

function formatWeight(kg, unit) {
  if (kg == null) return null
  const val = unit === 'lbs' ? kgToLbs(kg) : kg
  return Math.round(val * 10) / 10
}

// The inverse of formatWeight - what a set row uses to turn a typed number
// (in whatever unit that row is currently set to) back into kg before it's
// ever saved, so the database never has to know a set was entered in lbs
function weightToKg(value, unit) {
  return unit === 'lbs' ? lbsToKg(value) : value
}

// A timed set's reps field is free text (the athlete could type "45", "45s",
// "1 min", etc) - only append "sec" when it's a plain number, so we don't
// double up on a unit the athlete already typed themselves
function formatTimedReps(val) {
  if (!val && val !== 0) return '-'
  return /^\d+(\.\d+)?$/.test(String(val).trim()) ? `${val} sec` : val
}

// Splits any previously-stored timed value into {mm, ss} so the mm:ss input
// boxes can be prefilled - handles the new "M:SS" format this app now
// saves, old plain-seconds strings ("45") from before this change, and a
// best-effort digit grab for anything else free-typed in the past ("45s")
function parseTimeToParts(val) {
  if (val == null || val === '') return { mm: 0, ss: 0 }
  const str = String(val).trim()
  const mmss = str.match(/^(\d+):(\d{1,2})$/)
  if (mmss) return { mm: parseInt(mmss[1]), ss: Math.min(parseInt(mmss[2]), 59) }
  if (/^\d+$/.test(str)) {
    const total = parseInt(str)
    return { mm: Math.floor(total / 60), ss: total % 60 }
  }
  const digits = str.match(/\d+/)
  return digits ? { mm: 0, ss: Math.min(parseInt(digits[0]), 59) } : { mm: 0, ss: 0 }
}

// ==========================================================================
// ---- LOAD TRAINING DATA ----
// One nested query for the whole schedule, one flat query for every set
// this athlete has logged, one flat query for any in-progress workout
// session - small datasets for a solo coach's athlete, no date filtering.
// ==========================================================================
async function loadTrainingData() {
  // These 3 queries don't depend on each other's results, so they fire
  // together instead of waiting on each other one at a time - on a slow
  // connection this also means one retry sequence doesn't delay the start
  // of the other two
  const [
    { data, error },
    { data: logSets, error: logError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    saveWithRetry((signal) => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises!exercise_id(name, category, type, video_url, foot_contacts, intensity_tier, tracks_weight, is_timed, is_unilateral, tracks_distance))))')
      .eq('athlete_id', athlete.id)
      .eq('is_template', false)
      .abortSignal(signal)
    ),
    saveWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .select('*')
      .eq('athlete_id', athlete.id)
      .abortSignal(signal)
    ),
    saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('*')
      .eq('athlete_id', athlete.id)
      .abortSignal(signal)
    )
  ])

  if (error) { console.log('Error loading training data:', error); return }
  if (logError) { console.log('Error loading logged sets:', logError); return }
  if (sessionsError) { console.log('Error loading sessions:', sessionsError); return }

  entriesByDate = {}
  for (const program of data) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        day.program_exercises.forEach(applyFieldOverrides)
        const dateStr = day.date_override || resolveDate(program.start_date, week.week_number, day.day_number)
        if (!entriesByDate[dateStr]) entriesByDate[dateStr] = []
        entriesByDate[dateStr].push({ program, week, day })
      }
    }
  }

  logSetsByPE = {}
  for (const row of logSets) {
    if (!logSetsByPE[row.program_exercise_id]) logSetsByPE[row.program_exercise_id] = []
    logSetsByPE[row.program_exercise_id].push(row)
  }
  for (const peId in logSetsByPE) {
    logSetsByPE[peId].sort((a, b) => a.set_number - b.set_number)
  }

  openSessionsByDayId = {}
  completedSessionsByDayId = {}
  mobilitySessionsByDate = {}
  for (const s of sessions) {
    if (s.session_type === 'mobility') {
      mobilitySessionsByDate[s.local_date] = s
      continue
    }
    if (!s.ended_at) {
      openSessionsByDayId[s.program_day_id] = s
      continue
    }
    // Keep the most recently-ended one per day, in case a workout got
    // started and finished more than once for the same day
    const existing = completedSessionsByDayId[s.program_day_id]
    if (!existing || s.ended_at > existing.ended_at) completedSessionsByDayId[s.program_day_id] = s
  }

  // Re-apply anything still waiting in the local outbox on top of the
  // server data just loaded - a set that hasn't synced yet should still
  // show as checked/unchecked after a reload, not silently reset
  applyPendingQueueLocally()
}

// A program_exercise only ever resolves to one calendar date, so scanning
// the in-memory tree by id (instead of an extra query) is enough
function findPE(peId) {
  for (const dateStr in entriesByDate) {
    for (const entry of entriesByDate[dateStr]) {
      const pe = entry.day.program_exercises.find(p => p.id === peId)
      if (pe) return pe
    }
  }
  return null
}

// "The athlete tapped End Workout" - not a percentage-complete check, so a
// workout finished at 50% goes green on the week strip exactly the same as
// one finished at 100%. A day with more than one scheduled workout only
// counts as done once every one of them (that actually has exercises) has
// been ended, so the checkmark doesn't show early while one is still open.
function dayIsFullyLogged(entries) {
  const withExercises = entries.filter(entry => entry.day.program_exercises.length > 0)
  if (withExercises.length === 0) return false
  return withExercises.every(entry => !!completedSessionsByDayId[entry.day.id])
}

// "12/10/8 reps @ 50kg" when only reps vary across sets, "12@40kg, 10@45kg,
// 8@50kg" for a real pyramid (both reps and weight differ per set). Returns
// null when this exercise has no per-set targets yet, so targetLine() can
// fall back to its old single-value summary for pre-pyramid data. A
// distance-tracking exercise gets a " · 400m" (or per-set "400m/300m")
// suffix appended, independent of the reps/weight branch above it.
function formatSetTargets(setTargets, isTimed, tracksWeight, tracksDistance) {
  if (!setTargets || setTargets.length === 0) return null
  const unit = athlete.weight_unit || 'kg'
  let text
  if (isTimed && !tracksWeight) {
    text = setTargets.map(s => formatTimedReps(s.reps)).join(' / ')
  } else if (isTimed && tracksWeight) {
    text = setTargets.map(s => `${formatTimedReps(s.reps)}${s.weight != null ? ' @ ' + formatWeight(s.weight, unit) + unit : ''}`).join(', ')
  } else {
    const sameWeight = setTargets.every(s => s.weight === setTargets[0].weight)
    if (sameWeight) {
      const reps = setTargets.map(s => s.reps || '-').join('/')
      text = `${reps} reps${setTargets[0].weight != null ? ' @ ' + formatWeight(setTargets[0].weight, unit) + unit : ''}`
    } else {
      text = setTargets.map(s => `${s.reps || '-'}${s.weight != null ? '@' + formatWeight(s.weight, unit) + unit : ''}`).join(', ')
    }
  }
  if (tracksDistance && setTargets.some(s => s.distance != null)) {
    const sameDistance = setTargets.every(s => s.distance === setTargets[0].distance)
    text += ' · ' + (sameDistance ? `${setTargets[0].distance}m` : setTargets.map(s => s.distance != null ? `${s.distance}m` : '-').join('/'))
  }
  return text
}

function targetLine(pe) {
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const tracksDistance = pe.exercises && pe.exercises.tracks_distance
  const setTargetsText = formatSetTargets(pe.set_targets, isTimed, tracksWeight, tracksDistance)
  const parts = []
  if (setTargetsText) {
    parts.push(setTargetsText)
  } else {
    if (pe.prescribed_sets) parts.push(`${pe.prescribed_sets} sets`)
    if (pe.prescribed_reps) parts.push(isTimed ? formatTimedReps(pe.prescribed_reps) : `${pe.prescribed_reps} reps`)
    if (pe.prescribed_weight && tracksWeight) parts.push(`${formatWeight(pe.prescribed_weight, athlete.weight_unit)}${athlete.weight_unit || 'kg'}`)
  }
  if (pe.extra_fields) {
    for (const [k, v] of Object.entries(pe.extra_fields)) parts.push(`${k}: ${v}`)
  }
  return parts.join(' × ')
}

// ==========================================================================
// ---- INLINE VIDEO ----
// YouTube thumbnails/embeds are available at predictable URLs from just the
// video id, no API key needed. Other hosts fall back to opening a new tab.
// Tapping a thumbnail swaps it for a playing embed right in place - no
// overlay/modal covering the screen.
// ==========================================================================
function getYouTubeThumbnail(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg` : null
}

function getYouTubeEmbedUrl(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://www.youtube.com/embed/${match[1]}?autoplay=1` : null
}

function playInlineVideo(containerEl, url) {
  if (!url) return
  const embedUrl = getYouTubeEmbedUrl(url)
  if (!embedUrl) { window.open(url, '_blank'); return }
  containerEl.innerHTML = `<iframe src="${embedUrl}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`
}

// ==========================================================================
// ---- WEEK VIEW (default landing) ----
// ==========================================================================
function renderWeekView(weekStart) {
  setActiveBottomTab('home')
  clearRestTimer()
  currentWeekStart = weekStart
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  // Next should stay enabled all the way back up from any past week, not
  // just when weekStart happens to be exactly today's week - it only locks
  // once you'd step past the furthest week this athlete is allowed to see
  const realCurrentWeekStart = startOfWeek(new Date())
  const maxAllowedWeekStart = athlete.can_preview_next_week ? addDays(realCurrentWeekStart, 7) : realCurrentWeekStart
  const nextEnabled = toDateStr(weekStart) < toDateStr(maxAllowedWeekStart)

  const todayStr = toDateStr(new Date())
  const days = []
  for (let i = 0; i < 7; i++) days.push(addDays(weekStart, i))

  const cardsHtml = days.map(date => {
    const dateStr = toDateStr(date)
    const entries = entriesByDate[dateStr] || []
    // One badge per entry, keyed by day.id (always unique) - not by display
    // name. Two separate entries that happen to share a name (e.g. two
    // default-named "Field Training" self-logged workouts the same day)
    // used to incorrectly collapse into a single badge here - same fix
    // already applied to the coach's own calendar (athlete-calendar.js).
    // 🙋 prefixes a workout the athlete added themselves (see Add Own
    // Workout) so it's visually distinct from what the coach assigned.
    const badgeEntries = [...new Map(entries.map(entry => [entry.day.id, entry])).values()]
    const done = dayIsFullyLogged(entries)
    // A day with an open (started, never ended) session but not yet fully
    // logged - most often a past day the athlete forgot to tap "End
    // Workout" on - gets its own indicator so it's easy to spot in the
    // week strip instead of looking identical to a day nothing happened on
    const inProgress = !done && entries.some(entry => !!openSessionsByDayId[entry.day.id])
    const mobility = mobilitySessionsByDate[dateStr]
    const tournament = tournamentsByDate[dateStr]

    const classes = ['week-day-card']
    if (dateStr === todayStr) classes.push('today')
    if (done) classes.push('done')
    if (inProgress) classes.push('in-progress')

    // A busy day (several workouts + mobility + a tournament) used to show
    // one full-name badge per item, which either stacked tall (wrapped
    // text) or blew a grid column wide (unwrapped text - a 1fr grid track
    // won't shrink below an unwrapped child's content width). Small
    // fixed-size status dots avoid both - every cell stays a uniform size
    // no matter what's scheduled. Tapping the card still opens the full
    // day preview with real names.
    const dayStatus = done ? 'done' : (inProgress ? 'in-progress' : 'planned')
    const dots = badgeEntries.map(() => `<span class="week-day-dot week-day-dot-${dayStatus}">${done ? '✓' : (inProgress ? '▶' : '')}</span>`)
    if (mobility) dots.push('<span class="week-day-dot week-day-dot-mobility">🧘</span>')
    if (tournament) dots.push('<span class="week-day-dot week-day-dot-tournament">🏆</span>')
    const visibleDots = dots.slice(0, 4)
    const extraCount = dots.length - visibleDots.length

    return `
      <div class="${classes.join(' ')}" data-date="${dateStr}">
        <span class="week-day-name">${DAY_NAMES[date.getDay() === 0 ? 6 : date.getDay() - 1]}</span>
        <span class="week-day-number">${date.getDate()}</span>
        <div class="week-day-dots">
          ${visibleDots.join('')}
          ${extraCount > 0 ? `<span class="week-day-dot week-day-dot-more">+${extraCount}</span>` : ''}
        </div>
      </div>
    `
  }).join('')

  const pendingCount = loadPendingQueue().length

  pageContent.innerHTML = `
    <div class="welcome-header">
      <h2>Welcome back, ${athlete.name}</h2>
      <p>Here's your training for the week</p>
    </div>
    ${renderSyncBannerHtml(pendingCount)}
    <div class="week-nav-row">
      <button class="btn-cancel" id="weekPrevBtn">← Prev</button>
      <h3>${formatShortDate(days[0])} – ${formatShortDate(days[6])}</h3>
      <button class="btn-cancel" id="weekNextBtn" ${nextEnabled ? '' : 'disabled'}>Next →</button>
    </div>
    <div class="week-strip">${cardsHtml}</div>
    <div class="home-tile-row">
      <button type="button" class="home-tile ${athlete.can_self_log_workouts ? '' : 'disabled'}" id="addOwnWorkoutTile">
        <span class="home-tile-icon">🏋</span>
        <span class="home-tile-label">Add Own Workout</span>
        ${athlete.can_self_log_workouts ? '' : '<span class="home-tile-sublabel">Ask your coach to enable this</span>'}
      </button>
      <button type="button" class="home-tile" id="mobilityTile">
        <span class="home-tile-icon">🧘</span>
        <span class="home-tile-label">Daily Mobility/Stretching</span>
      </button>
    </div>
    <div class="home-tile-row home-tile-row-single">
      <button type="button" class="home-tile" id="tournamentsTile">
        <span class="home-tile-icon">🏆</span>
        <span class="home-tile-label">Tournaments</span>
      </button>
    </div>
  `

  document.querySelectorAll('.week-day-card').forEach(cardEl => {
    cardEl.addEventListener('click', function() { renderDayPreview(cardEl.dataset.date) })
  })

  document.getElementById('weekPrevBtn').addEventListener('click', function() {
    renderWeekView(addDays(weekStart, -7))
  })
  document.getElementById('weekNextBtn').addEventListener('click', function() {
    if (nextEnabled) renderWeekView(addDays(weekStart, 7))
  })

  document.getElementById('addOwnWorkoutTile').addEventListener('click', function() {
    if (!athlete.can_self_log_workouts) {
      customAlert('Ask your coach to turn this on for your account.')
      return
    }
    renderAddWorkoutChoice()
  })
  document.getElementById('mobilityTile').addEventListener('click', function() {
    renderMobilityAreaPicker()
  })
  document.getElementById('tournamentsTile').addEventListener('click', function() {
    renderTournaments()
  })

  wireSyncBanner(function() { renderWeekView(weekStart) })
}

// ==========================================================================
// ---- SYNC STATUS BANNER ----
// Makes the pending-save queue visible instead of silent - a set that
// hasn't reached the server yet shows up here with the ACTUAL error from
// the last failed attempt (not just an invisible tooltip, which doesn't
// work on touch anyway) and a manual "Retry now" button. Shown on the week
// view since that's what's on screen right after finishing a workout.
// ==========================================================================
function renderSyncBannerHtml(pendingCount) {
  if (pendingCount === 0) return ''

  const withError = loadPendingQueue().find(e => e.lastError)
  const errorLine = withError ? `Last error: ${withError.lastError}` : 'Still trying automatically in the background.'

  return `
    <div class="sync-banner" id="syncBanner">
      <div>
        <strong>${pendingCount} set${pendingCount === 1 ? '' : 's'} not synced yet</strong>
        <div class="sync-banner-detail">${errorLine}</div>
      </div>
      <div style="display:flex; gap:8px">
        <button type="button" class="btn-cancel" id="syncRetryBtn">Retry Now</button>
        <button type="button" class="btn-cancel" id="syncDismissBtn">Dismiss</button>
      </div>
    </div>
  `
}

function wireSyncBanner(onDone) {
  const retryBtn = document.getElementById('syncRetryBtn')
  const dismissBtn = document.getElementById('syncDismissBtn')
  if (!retryBtn) return

  retryBtn.addEventListener('click', async function() {
    retryBtn.disabled = true
    retryBtn.textContent = 'Retrying...'
    await flushPendingQueue()
    onDone()
  })

  // Only offered as a last resort once retrying keeps failing - this
  // permanently throws away whatever wasn't saved, since there's no other
  // way to clear a stuck queue from a phone (no browser console access
  // there the way there is on desktop)
  dismissBtn.addEventListener('click', async function() {
    const count = loadPendingQueue().length
    const ok = await customConfirm(`Discard ${count} unsynced set${count === 1 ? '' : 's'}? They never saved to the server, so this can't be undone - only do this if you don't need this data.`)
    if (!ok) return
    savePendingQueueToStorage([])
    onDone()
  })
}

// ==========================================================================
// ---- DAILY MOBILITY / STRETCHING ----
// Nothing is written until the session actually finishes or is ended early
// - cancelling is a pure client-side abort, unlike the guided workout flow
// which creates a workout_sessions row up front. A mobility row never gets
// a program_day_id (see the mobility RLS policy), so it can't collide with
// or affect anything the coach assigned.
//
// Two paths, chosen automatically based on whether the coach has filmed
// any stretches yet:
//   - Stretch Library has content: area picker -> duration picker ->
//     renderMobilityFlow (continuous auto-advancing video flow)
//   - Empty library: duration picker -> renderMobilityTimer (V1 blank
//     countdown, kept as-is - both paths end at the same
//     finishMobilitySession)
// ==========================================================================
async function renderMobilityAreaPicker() {
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')
  pageContent.innerHTML = '<p>Loading...</p>'

  const [stretches] = await Promise.all([loadStretchLibrary(), loadAthleteStretchPreferences()])

  if (stretches.length === 0) {
    renderMobilityPicker([]) // nothing filmed yet - straight to the plain duration picker + blank timer
    return
  }

  const distinctAreas = [...new Set(stretches.flatMap(s => s.body_areas || []))].sort()
  const selectedAreas = new Set()

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="btn-cancel" id="mobilityAreaBackBtn">← Back</button>
      <h2 class="day-view-date">Daily Mobility/Stretching</h2>
    </div>
    <p style="color:#aaaacc; font-size:13px; margin-bottom:16px">What do you want to focus on today? Pick up to 2 - the rest of the session still flows across your whole body, these just show up more.</p>
    <div class="chip-row" id="mobilityAreaChips">
      ${distinctAreas.map(a => `<button type="button" class="chip-btn" data-area="${a}">${a}</button>`).join('')}
    </div>
    <button type="button" class="chip-btn chip-btn-clear" id="mobilityAreaNoPreference" style="margin-top:8px">Full Body / No preference</button>
    <button type="button" class="btn-save start-workout-btn" id="mobilityAreaNextBtn" style="margin-top:16px">Next →</button>
  `

  document.getElementById('mobilityAreaBackBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

  function refreshChipStates() {
    document.querySelectorAll('#mobilityAreaChips .chip-btn').forEach(btn => {
      btn.classList.toggle('selected', selectedAreas.has(btn.dataset.area))
      btn.disabled = selectedAreas.size >= 2 && !selectedAreas.has(btn.dataset.area)
    })
  }

  document.querySelectorAll('#mobilityAreaChips .chip-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      if (selectedAreas.has(btn.dataset.area)) selectedAreas.delete(btn.dataset.area)
      else if (selectedAreas.size < 2) selectedAreas.add(btn.dataset.area)
      refreshChipStates()
    })
  })

  document.getElementById('mobilityAreaNoPreference').addEventListener('click', function() {
    selectedAreas.clear()
    refreshChipStates()
  })

  document.getElementById('mobilityAreaNextBtn').addEventListener('click', function() {
    renderMobilityPicker([...selectedAreas])
  })
}

function renderMobilityPicker(selectedAreas) {
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const presets = [10, 15, 20]
  const hasLibrary = stretchLibraryCache && stretchLibraryCache.length > 0

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="btn-cancel" id="mobilityBackBtn">← Back</button>
      <h2 class="day-view-date">Daily Mobility/Stretching</h2>
    </div>
    <p style="color:#aaaacc; font-size:13px; margin-bottom:16px">Pick how long you want to stretch or work on mobility.</p>
    <div class="duration-preset-row">
      ${presets.map(m => `<button type="button" class="duration-preset-btn" data-minutes="${m}">${m} min</button>`).join('')}
    </div>
    <div class="form-group" style="margin-top:16px">
      <label>Or a custom length (minutes)</label>
      <input type="number" id="mobilityCustomMinutes" min="1" placeholder="e.g. 12">
    </div>
    <button type="button" class="btn-save start-workout-btn" id="mobilityStartBtn" style="margin-top:16px">▶ Start</button>
  `

  document.getElementById('mobilityBackBtn').addEventListener('click', function() {
    if (hasLibrary) renderMobilityAreaPicker()
    else renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

  document.querySelectorAll('.duration-preset-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      document.getElementById('mobilityCustomMinutes').value = btn.dataset.minutes
    })
  })

  document.getElementById('mobilityStartBtn').addEventListener('click', function() {
    const minutes = parseInt(document.getElementById('mobilityCustomMinutes').value)
    if (!minutes || minutes < 1) { customAlert('Pick a duration first'); return }
    if (hasLibrary) startMobilityFlow(selectedAreas, minutes * 60)
    else renderMobilityTimer(minutes * 60)
  })
}

function renderMobilityTimer(totalSeconds) {
  const startedAt = new Date()
  let remaining = totalSeconds

  pageContent.innerHTML = `
    <div class="mobility-timer-screen">
      <p class="mobility-timer-label">🧘 Mobility / Stretching</p>
      <p class="mobility-timer-time" id="mobilityTimerTime">${formatTimer(remaining)}</p>
      <div style="display:flex; gap:12px; margin-top:24px">
        <button type="button" class="btn-cancel" id="mobilityCancelBtn">Cancel</button>
        <button type="button" class="btn-save" id="mobilityFinishBtn">Finish Early</button>
      </div>
    </div>
  `

  mobilityTimerInterval = setInterval(function() {
    remaining--
    const timeEl = document.getElementById('mobilityTimerTime')
    if (timeEl) timeEl.textContent = formatTimer(remaining)
    if (remaining <= 0) {
      clearMobilityTimer()
      playRestDoneSound()
      finishMobilitySession(startedAt)
    }
  }, 1000)

  document.getElementById('mobilityCancelBtn').addEventListener('click', function() {
    clearMobilityTimer()
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })
  document.getElementById('mobilityFinishBtn').addEventListener('click', function() {
    clearMobilityTimer()
    finishMobilitySession(startedAt)
  })
}

function clearMobilityTimer() {
  if (mobilityTimerInterval) clearInterval(mobilityTimerInterval)
  mobilityTimerInterval = null
}

async function finishMobilitySession(startedAt) {
  const { error } = await saveWithRetry((signal) => supabase
    .from('workout_sessions')
    .insert([{
      athlete_id: athlete.id,
      program_day_id: null,
      session_type: 'mobility',
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      local_date: toDateStr(startedAt)
    }])
    .abortSignal(signal)
  )

  if (error) {
    console.log(error)
    customAlert('Something went wrong saving that mobility session - check your connection and try again')
  } else {
    customAlert('Mobility session logged!')
  }

  await loadTrainingData()
  renderWeekView(currentWeekStart || startOfWeek(new Date()))
}

// ---- Stretch Library + preferences (cached once per page load, same
// pattern as loadExerciseLibrary) ----
async function loadStretchLibrary() {
  if (stretchLibraryCache) return stretchLibraryCache
  const { data, error } = await saveWithRetry((signal) => supabase
    .from('stretches')
    .select('*')
    .order('name')
    .abortSignal(signal)
  )
  if (error) { console.log(error); customAlert('Something went wrong loading stretches - check your connection and try again'); return [] }
  stretchLibraryCache = data
  return stretchLibraryCache
}

async function loadAthleteStretchPreferences() {
  if (athleteStretchPreferencesCache) return athleteStretchPreferencesCache
  const { data, error } = await saveWithRetry((signal) => supabase
    .from('athlete_stretch_preferences')
    .select('stretch_id, preference')
    .eq('athlete_id', athlete.id)
    .abortSignal(signal)
  )
  if (error) { console.log(error); athleteStretchPreferencesCache = new Map(); return athleteStretchPreferencesCache }
  athleteStretchPreferencesCache = new Map(data.map(r => [r.stretch_id, r.preference]))
  return athleteStretchPreferencesCache
}

// ---- Queue building ----
// Picking a focus area is a WEIGHT BOOST, not a filter - every non-disliked
// stretch stays eligible so the session still flows across the whole body,
// but an area-matched stretch shows up noticeably more often. Combines
// multiplicatively with the like weighting (a liked, area-matched stretch
// is AREA_WEIGHT * LIKED_WEIGHT times as likely to be drawn as an unrelated
// neutral one).
const AREA_WEIGHT = 3
const LIKED_WEIGHT = 3

function buildMobilityQueue(stretches, prefsMap, selectedAreas, totalSeconds) {
  const candidates = stretches.filter(s => prefsMap.get(s.id) !== 'disliked')
  if (candidates.length === 0) return []

  function weightOf(s) {
    let w = 1
    if (selectedAreas.length > 0 && (s.body_areas || []).some(a => selectedAreas.includes(a))) w *= AREA_WEIGHT
    if (prefsMap.get(s.id) === 'liked') w *= LIKED_WEIGHT
    return w
  }

  // Weighted-random draw-without-replacement, one full lap = every
  // candidate exactly once (higher-weighted ones tend to land earlier in
  // the lap, not guaranteed first).
  function weightedShuffle() {
    const remaining = [...candidates]
    const order = []
    while (remaining.length > 0) {
      const weights = remaining.map(weightOf)
      const total = weights.reduce((a, b) => a + b, 0)
      let r = Math.random() * total
      let idx = 0
      for (; idx < remaining.length - 1; idx++) { r -= weights[idx]; if (r <= 0) break }
      order.push(remaining.splice(idx, 1)[0])
    }
    return order
  }

  const queue = []
  let elapsed = 0
  let pool = weightedShuffle()

  while (elapsed < totalSeconds) {
    if (pool.length === 0) {
      // Start a new lap - reshuffle until it doesn't open with whatever
      // just closed the previous lap, so a lap boundary never repeats a
      // stretch back-to-back
      do {
        pool = weightedShuffle()
      } while (candidates.length > 1 && queue.length > 0 && pool[0].id === queue[queue.length - 1].id)
    }
    const next = pool.shift()
    queue.push(next)
    elapsed += (next.default_hold_seconds || 30)
  }
  return queue
}

async function startMobilityFlow(selectedAreas, totalSeconds) {
  const queue = buildMobilityQueue(stretchLibraryCache, athleteStretchPreferencesCache, selectedAreas, totalSeconds)
  if (queue.length === 0) {
    customAlert("No stretches available yet - ask your coach to add some to the library.")
    return
  }
  renderMobilityFlow(queue, totalSeconds)
}

// ---- Continuous-flow guided screen ----
// Deliberately NOT the paginated guided-workout screen - one full-bleed
// screen, auto-advancing on its own, minimal overlaid chrome. Two stacked
// <video> elements crossfade via CSS opacity: while one plays, the OTHER is
// silently preloaded with the next stretch's clip, so by the time the
// countdown hits zero the swap is instant instead of waiting on a fresh
// load. The countdown timer is the sole authority on when to advance -
// never the video's own length or its 'ended' event - which is what lets a
// short clip (loop="true") cover a longer hold.
function renderMobilityFlow(queue, totalSeconds) {
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const startedAt = new Date()
  let index = 0
  let remaining = queue[0].default_hold_seconds || 30
  let paused = false

  pageContent.innerHTML = `
    <div class="mobility-flow-screen">
      <div class="mobility-flow-progress"><div class="mobility-flow-progress-fill" id="mobilityFlowProgressFill"></div></div>
      <video class="mobility-flow-video active" id="mobilityVideoA" muted playsinline loop></video>
      <video class="mobility-flow-video" id="mobilityVideoB" muted playsinline loop></video>
      <div class="mobility-flow-overlay">
        <div class="mobility-flow-top">
          <button type="button" class="mobility-flow-icon-btn" id="mobilityFlowEndBtn">✕</button>
          <span class="mobility-flow-name" id="mobilityFlowName"></span>
          <button type="button" class="mobility-flow-icon-btn" id="mobilityFlowPauseBtn">⏸</button>
        </div>
        <div class="mobility-flow-bottom">
          <button type="button" class="mobility-flow-pref-btn" id="mobilityFlowDislikeBtn">👎</button>
          <span class="mobility-flow-time" id="mobilityFlowTime"></span>
          <button type="button" class="mobility-flow-pref-btn" id="mobilityFlowLikeBtn">👍</button>
          <button type="button" class="mobility-flow-skip-btn" id="mobilityFlowSkipBtn">Skip ⏭</button>
        </div>
      </div>
    </div>
  `

  const videos = [document.getElementById('mobilityVideoA'), document.getElementById('mobilityVideoB')]
  let frontIndex = 0

  function loadStretchIntoVideo(videoEl, stretch) {
    if (stretch && stretch.video_url) {
      videoEl.src = stretch.video_url
      videoEl.load()
      videoEl.play().catch(function() {}) // muted+playsinline autoplay should never reject, but never let a rejected promise surface as an error
    } else {
      videoEl.removeAttribute('src') // no clip filmed for this one yet - screen just shows name+timer, graceful degradation
    }
  }

  function preloadNext() {
    const nextStretch = queue[index + 1]
    const backEl = videos[1 - frontIndex]
    if (nextStretch) loadStretchIntoVideo(backEl, nextStretch)
    else backEl.removeAttribute('src')
  }

  function updateChrome() {
    document.getElementById('mobilityFlowName').textContent = queue[index].name
    document.getElementById('mobilityFlowTime').textContent = formatTimer(remaining)
    updatePrefButtons(queue[index].id)
    const doneSoFar = queue.slice(0, index).reduce((sum, s) => sum + (s.default_hold_seconds || 30), 0)
    const pct = Math.min(100, Math.round((doneSoFar / totalSeconds) * 100))
    const fill = document.getElementById('mobilityFlowProgressFill')
    if (fill) fill.style.width = pct + '%'
  }

  function advance() {
    index++
    if (index >= queue.length) { finishFlow(); return }
    frontIndex = 1 - frontIndex
    videos[frontIndex].classList.add('active')
    videos[1 - frontIndex].classList.remove('active')
    remaining = queue[index].default_hold_seconds || 30
    updateChrome()
    preloadNext()
  }

  function finishFlow() {
    clearMobilityFlowTimer()
    finishMobilitySession(startedAt) // unchanged - started_at is the real flow-start time, ended_at is now, however the flow actually stopped
  }

  loadStretchIntoVideo(videos[0], queue[0])
  updateChrome()
  preloadNext()

  mobilityFlowInterval = setInterval(function() {
    if (paused) return
    remaining--
    const timeEl = document.getElementById('mobilityFlowTime')
    if (timeEl) timeEl.textContent = formatTimer(remaining)
    if (remaining <= 0) advance()
  }, 1000)

  document.getElementById('mobilityFlowPauseBtn').addEventListener('click', function() {
    paused = !paused
    this.textContent = paused ? '▶' : '⏸'
    videos.forEach(function(v) { if (paused) v.pause(); else v.play().catch(function() {}) })
  })

  document.getElementById('mobilityFlowSkipBtn').addEventListener('click', advance)

  document.getElementById('mobilityFlowEndBtn').addEventListener('click', async function() {
    if (await customConfirm('End this mobility session now?')) finishFlow()
  })

  document.getElementById('mobilityFlowLikeBtn').addEventListener('click', function() {
    toggleStretchPreference(queue[index].id, 'liked')
  })
  document.getElementById('mobilityFlowDislikeBtn').addEventListener('click', function() {
    toggleStretchPreference(queue[index].id, 'disliked')
  })
}

function clearMobilityFlowTimer() {
  if (mobilityFlowInterval) clearInterval(mobilityFlowInterval)
  mobilityFlowInterval = null
}

// ---- Like/dislike ----
// The one write in this whole flow that saves immediately rather than
// being deferred to session-end - it's a standing preference, not part of
// the session record. Tapping an already-active choice again clears it
// back to neutral (deletes the row) instead of storing a third value.
function updatePrefButtons(stretchId) {
  const likeBtn = document.getElementById('mobilityFlowLikeBtn')
  const dislikeBtn = document.getElementById('mobilityFlowDislikeBtn')
  if (!likeBtn) return
  const pref = athleteStretchPreferencesCache.get(stretchId)
  likeBtn.classList.toggle('active', pref === 'liked')
  dislikeBtn.classList.toggle('active', pref === 'disliked')
}

async function toggleStretchPreference(stretchId, preference) {
  const current = athleteStretchPreferencesCache.get(stretchId)
  const next = current === preference ? null : preference

  if (next) athleteStretchPreferencesCache.set(stretchId, next)
  else athleteStretchPreferencesCache.delete(stretchId)
  updatePrefButtons(stretchId)

  let error
  if (next) {
    ({ error } = await saveWithRetry((signal) => supabase
      .from('athlete_stretch_preferences')
      .upsert([{ athlete_id: athlete.id, stretch_id: stretchId, preference: next }], { onConflict: 'athlete_id,stretch_id' })
      .abortSignal(signal)
    ))
  } else {
    ({ error } = await saveWithRetry((signal) => supabase
      .from('athlete_stretch_preferences')
      .delete()
      .eq('athlete_id', athlete.id)
      .eq('stretch_id', stretchId)
      .abortSignal(signal)
    ))
  }

  if (error) {
    console.log(error)
    if (next) athleteStretchPreferencesCache.delete(stretchId)
    else athleteStretchPreferencesCache.set(stretchId, current)
    updatePrefButtons(stretchId)
    customAlert('Something went wrong saving that - try again')
  }
}

// ==========================================================================
// ---- ADD OWN WORKOUT (Strength + Field/Training) ----
// Gated by athlete.can_self_log_workouts (see the tile in renderWeekView).
// Always logs against today. Strength becomes a completely normal
// programs/program_weeks/program_days/program_exercises tree
// (created_by_athlete=true is the only difference from a coach-assigned
// one), so it flows through the exact same startWorkout -> checkSet/
// uncheckSet -> finishWorkout pipeline a coach-assigned workout uses -
// Total Volume, PR detection, and Training Load all pick it up with zero
// extra code. Field/Training skips exercises entirely and writes straight
// to workout_sessions (duration + RPE), which Training Load already
// consumes via session_rpe x duration_minutes.
// ==========================================================================
let exerciseLibraryCache = null

async function loadExerciseLibrary() {
  if (exerciseLibraryCache) return exerciseLibraryCache
  const { data, error } = await saveWithRetry((signal) => supabase
    .from('exercises')
    .select('*')
    .order('name')
    .abortSignal(signal)
  )
  if (error) { console.log(error); customAlert('Something went wrong loading the exercise library - check your connection and try again'); return null }
  exerciseLibraryCache = data
  return exerciseLibraryCache
}

function renderAddWorkoutChoice() {
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="btn-cancel" id="addWorkoutBackBtn">← Back</button>
      <h2 class="day-view-date">Add Own Workout</h2>
    </div>
    <p style="color:#aaaacc; font-size:13px; margin-bottom:16px">What kind of workout did you do today?</p>
    <div class="home-tile-row">
      <button type="button" class="home-tile" id="addWorkoutStrengthChoice">
        <span class="home-tile-icon">🏋</span>
        <span class="home-tile-label">Strength (Gym)</span>
      </button>
      <button type="button" class="home-tile" id="addWorkoutFieldChoice">
        <span class="home-tile-icon">🏃</span>
        <span class="home-tile-label">Field / Training</span>
      </button>
    </div>
  `

  document.getElementById('addWorkoutBackBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })
  document.getElementById('addWorkoutStrengthChoice').addEventListener('click', function() {
    startOwnStrengthWorkout()
  })
  document.getElementById('addWorkoutFieldChoice').addEventListener('click', function() {
    renderAddWorkoutFieldForm()
  })
}

// ---- Strength: same live guided screen as a coach-assigned workout ----
// Pressing "Strength" drops straight into the exact renderActiveExercise
// flow used to follow a coach-built training - video thumb, + Add Set,
// checkable rows - just starting with zero exercises and an "+ Add
// Exercise" button (see startWorkout/renderActiveExercise/
// renderOwnWorkoutAddExercise) instead of a coach-built list. No separate
// "plan your targets first" step: the athlete just adds an exercise and
// logs actual sets as they go, same as always.
async function startOwnStrengthWorkout() {
  const dateStr = toDateStr(new Date())
  let dayId, created
  try {
    ({ dayId, created } = await findOrCreateSelfLoggedDay(dateStr, 'My Workout'))
  } catch (err) {
    return
  }
  if (created) notifyCoach('workout_added', `${athlete.name} added a workout`)
  await loadTrainingData()
  // Matched by day id, not just "any self-logged entry today" - today can
  // now genuinely hold more than one (see findOrCreateSelfLoggedDay), so
  // grabbing the first one found could open an already-finished workout
  // instead of the fresh one just created/resumed here
  const entry = (entriesByDate[dateStr] || []).find(e => e.day.id === dayId)
  if (!entry) { customAlert('Something went wrong starting your workout'); return }
  startWorkout(entry, dateStr)
}

// Shared search+tap-to-pick card list - filters `library` as the athlete
// types and renders one exercise-lib-card per match, calling onPick(id,
// cardEl) when tapped (cardEl gets marked .adding so a slow connection
// can't double-fire the same pick). Used by the full-page Add Exercise
// screen below and the Swap modal, so both stay visually/behaviorally
// identical instead of drifting apart as two copies.
function wireExercisePicker(searchInputEl, listEl, library, onPick) {
  function render() {
    const filter = searchInputEl.value.trim().toLowerCase()
    const filtered = filter ? library.filter(ex => ex.name.toLowerCase().includes(filter)) : library

    listEl.innerHTML = filtered.length === 0
      ? '<p class="no-metrics">No exercises found</p>'
      : filtered.map(ex => {
          const thumb = getYouTubeThumbnail(ex.video_url)
          return `
            <div class="exercise-lib-card own-add-exercise-card" data-id="${ex.id}">
              <div class="exercise-lib-thumb">
                ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="exercise-lib-thumb-placeholder">🏋</span>'}
              </div>
              <span class="exercise-lib-name">${ex.name}</span>
            </div>
          `
        }).join('')

    listEl.querySelectorAll('.own-add-exercise-card').forEach(card => {
      card.addEventListener('click', function() {
        if (card.classList.contains('adding')) return
        card.classList.add('adding')
        onPick(card.dataset.id, card)
      })
    })
  }

  searchInputEl.addEventListener('input', render)
  render()
}

// Search + tap-to-add - how a self-logged workout grows its exercise list
// live, one at a time. Reached both for the very first exercise (empty
// day, from startWorkout) and via the "+ Add Exercise" button on any later
// slide (renderSingleSlideBody), passing the slide index to return to.
async function renderOwnWorkoutAddExercise(entry, dateStr, sessionPromise, returnIndex) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="btn-cancel" id="ownAddExerciseBackBtn">← Back</button>
      <h2 class="day-view-date">Add Exercise</h2>
    </div>
    <input type="text" id="ownAddExerciseSearchInput" class="exercise-search-input" placeholder="Search exercises..." />
    <div id="ownAddExerciseList"></div>
  `

  document.getElementById('ownAddExerciseBackBtn').addEventListener('click', function() {
    const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
    if (exercises.length === 0) { renderWeekView(currentWeekStart || startOfWeek(new Date())); return }
    const slides = buildWorkoutSlides(exercises)
    const idx = returnIndex != null ? Math.min(returnIndex, slides.length - 1) : slides.length - 1
    renderActiveExercise(entry, dateStr, slides, idx, sessionPromise)
  })

  const library = await loadExerciseLibrary()
  if (library === null) return

  wireExercisePicker(
    document.getElementById('ownAddExerciseSearchInput'),
    document.getElementById('ownAddExerciseList'),
    library,
    function(exerciseId) {
      addExerciseToOwnWorkout(entry, dateStr, sessionPromise, exerciseId)
    }
  )
}

async function addExerciseToOwnWorkout(entry, dateStr, sessionPromise, exerciseId) {
  const existing = entry.day.program_exercises
  const orderIndex = existing.length ? Math.max(...existing.map(pe => pe.order_index)) + 1 : 0

  // added_by_athlete=true both flags this for the coach's calendar (see
  // athlete-calendar.js) and is what the "athlete deletes own added
  // exercises" RLS policy checks - true here regardless of self-logged vs
  // coach-assigned, since it's accurate either way
  const { data, error } = await supabase
    .from('program_exercises')
    .insert([{ day_id: entry.day.id, exercise_id: exerciseId, order_index: orderIndex, added_by_athlete: true }])
    .select('*, exercises!exercise_id(name, category, type, video_url, foot_contacts, intensity_tier, tracks_weight, is_timed, is_unilateral, tracks_distance)')
    .single()

  if (error) { console.log(error); customAlert('Something went wrong adding that exercise - please try again'); return }

  existing.push(data)
  const slides = buildWorkoutSlides([...existing].sort((a, b) => a.order_index - b.order_index))
  const newIndex = slides.findIndex(s => s.type === 'single' && s.pe.id === data.id)
  renderActiveExercise(entry, dateStr, slides, newIndex === -1 ? slides.length - 1 : newIndex, sessionPromise, 1)
}

// Removing a self-logged exercise's last set row removes the exercise
// itself too - a self-added exercise with nothing logged on it isn't worth
// keeping around, and there's no other way to remove one mid-workout.
// Updates in-memory state and moves on immediately (nothing was ever saved
// for an unchecked row - see wireExerciseCardEvents), then deletes the row
// in the background rather than making the athlete wait on it.
function removeEmptyOwnExercise(entry, dateStr, sessionPromise, index, peId) {
  entry.day.program_exercises = entry.day.program_exercises.filter(pe => pe.id !== peId)
  delete logSetsByPE[peId]

  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  if (exercises.length === 0) {
    renderOwnWorkoutAddExercise(entry, dateStr, sessionPromise)
  } else {
    const slides = buildWorkoutSlides(exercises)
    renderActiveExercise(entry, dateStr, slides, Math.min(index, slides.length - 1), sessionPromise, -1)
  }

  supabase.from('program_exercises').delete().eq('id', peId).then(function(res) {
    if (res.error) console.log(res.error)
  })
}

// name is only used the first time a self-logged workout is created for
// this date - repeated adds on the same day reuse the same container ONLY
// while it's still unfinished (a still-empty or in-progress draft) - same
// convention as the coach's own findOrCreateAdHocDay for that case. Once a
// self-logged workout on this date has actually been completed, reusing it
// again would silently merge a second, separate workout into the first
// one's program_days row - and since the Calendar day-detail only shows
// the most-recently-ended session's summary per row, the first workout's
// data would effectively vanish behind the second. So a finished day
// always gets a fresh one instead.
// Returns { dayId, created } - `created` lets callers tell a brand-new
// self-logged day apart from resuming today's already-existing one (used
// by startOwnStrengthWorkout to fire a "workout added" notification only
// once, not every time the athlete reopens an in-progress day)
async function findOrCreateSelfLoggedDay(dateStr, name) {
  // Not .maybeSingle() - this date can now genuinely hold more than one
  // self-logged program (see the finished-session check below), so every
  // match needs checking, not just the first/only one
  const { data: existingPrograms, error: findError } = await supabase
    .from('programs')
    .select('*, program_weeks(*, program_days(*))')
    .eq('athlete_id', athlete.id)
    .eq('is_adhoc', true)
    .eq('created_by_athlete', true)
    .eq('start_date', dateStr)

  if (findError) { console.log(findError) }

  // completedSessionsByDayId is already loaded/refreshed by loadTrainingData()
  // (every write path here calls it right after saving) - reused directly
  // instead of firing a fresh per-program query, since a previous version of
  // this check (a separate query per program) never correctly detected an
  // already-finished day and kept reusing it indefinitely
  for (const program of existingPrograms || []) {
    const dayId = program.program_weeks[0].program_days[0].id
    if (!completedSessionsByDayId[dayId]) return { dayId, created: false }
  }

  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{ coach_id: athlete.coach_id, athlete_id: athlete.id, is_template: false, is_adhoc: true, created_by_athlete: true, start_date: dateStr, name: name || 'My Workout' }])
    .select()
  if (programError) { console.log(programError); customAlert('Something went wrong saving your workout'); throw programError }

  const { data: newWeek, error: weekError } = await supabase
    .from('program_weeks')
    .insert([{ program_id: newProgram[0].id, week_number: 1 }])
    .select()
  if (weekError) { console.log(weekError); customAlert('Something went wrong saving your workout'); throw weekError }

  const { data: newDay, error: dayError } = await supabase
    .from('program_days')
    .insert([{ week_id: newWeek[0].id, day_number: 1 }])
    .select()
  if (dayError) { console.log(dayError); customAlert('Something went wrong saving your workout'); throw dayError }

  return { dayId: newDay[0].id, created: true }
}

// ---- Field/Training: duration + RPE, no exercises at all ----
function renderAddWorkoutFieldForm() {
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const presets = [20, 30, 45, 60, 90]
  let selectedRpe = null

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="btn-cancel" id="addWorkoutBackBtn">← Back</button>
      <h2 class="day-view-date">Field / Training</h2>
    </div>
    <div class="form-group">
      <label>Date</label>
      <input type="date" id="fieldDateInput" value="${toDateStr(new Date())}" max="${toDateStr(new Date())}">
    </div>
    <div class="form-group">
      <label>Activity (optional)</label>
      <input type="text" id="fieldActivityInput" placeholder="e.g. Soccer practice, 5k run">
    </div>
    <div class="form-group">
      <label>Duration</label>
      <div class="duration-preset-row">
        ${presets.map(m => `<button type="button" class="duration-preset-btn" data-minutes="${m}">${m} min</button>`).join('')}
      </div>
      <div class="set-time-input" style="width:fit-content; margin-top:8px">
        <input type="text" inputmode="numeric" class="field-duration-hh" id="fieldDurationHH" value="00" maxlength="2">
        <span class="set-time-sep">h</span>
        <input type="text" inputmode="numeric" class="field-duration-mm" id="fieldDurationMM" value="00" maxlength="2">
        <span class="set-time-sep">m</span>
      </div>
      <p style="color:#aaaacc; font-size:11px; margin-top:4px">Hours and minutes - not mm:ss</p>
    </div>
    <div class="rpe-picker">
      <p class="rpe-picker-label">Effort (RPE)</p>
      <div class="rpe-picker-row" id="fieldRpeRow">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button type="button" class="rpe-btn" data-rpe="${n}">${n}</button>`).join('')}
      </div>
      <p class="rpe-picker-hint" id="fieldRpeHint">Tap a number to rate how hard it felt</p>
    </div>
    <div class="form-group">
      <label>Avg Heart Rate (optional)</label>
      <input type="number" id="fieldAvgHr" min="30" max="250" placeholder="e.g. 145 bpm">
    </div>
    <button type="button" class="btn-save start-workout-btn" id="fieldSaveBtn" style="margin-top:16px">💾 Save</button>
  `

  document.getElementById('addWorkoutBackBtn').addEventListener('click', function() {
    renderAddWorkoutChoice()
  })

  document.querySelectorAll('.duration-preset-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const totalMinutes = parseInt(btn.dataset.minutes)
      document.getElementById('fieldDurationHH').value = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
      document.getElementById('fieldDurationMM').value = String(totalMinutes % 60).padStart(2, '0')
    })
  })

  // Same sanitize-as-typed / clamp-on-blur pattern as the mm:ss set-time
  // boxes elsewhere in this file (see wireExerciseCardEvents) - kept as two
  // small text inputs rather than type="number" so "00" padding stays
  // visible instead of the browser stripping the leading zero
  const durationBoxes = document.querySelectorAll('#fieldDurationHH, #fieldDurationMM')
  durationBoxes.forEach(input => {
    // Selects the "00" the moment it's tapped, so typing a digit replaces
    // it immediately instead of needing a manual delete first
    input.addEventListener('focus', function() {
      input.select()
    })
    input.addEventListener('input', function() {
      input.value = input.value.replace(/\D/g, '').slice(0, 2)
    })
    input.addEventListener('focusout', function() {
      const max = input.id === 'fieldDurationHH' ? 23 : 59
      const val = Math.min(parseInt(input.value) || 0, max)
      input.value = String(val).padStart(2, '0')
    })
  })

  document.getElementById('fieldRpeRow').addEventListener('click', function(e) {
    const btn = e.target.closest('.rpe-btn')
    if (!btn) return
    document.querySelectorAll('#fieldRpeRow .rpe-btn').forEach(b => b.classList.remove('selected'))
    btn.classList.add('selected')
    selectedRpe = parseInt(btn.dataset.rpe)
    document.getElementById('fieldRpeHint').textContent = RPE_DESCRIPTIONS[selectedRpe]
  })

  document.getElementById('fieldSaveBtn').addEventListener('click', async function() {
    // Clamped here too, not just on focusout - on some devices/keyboards,
    // tapping Save doesn't reliably fire a blur on whichever box still has
    // focus first, so an un-clamped raw value (e.g. "34" left in the hours
    // box) could otherwise sail straight through as 34 HOURS instead of 23
    const hh = Math.min(parseInt(document.getElementById('fieldDurationHH').value) || 0, 23)
    const mm = Math.min(parseInt(document.getElementById('fieldDurationMM').value) || 0, 59)
    const minutes = hh * 60 + mm
    if (!minutes || minutes < 1) { customAlert('Pick a duration first'); return }
    if (!selectedRpe) { customAlert('Pick an RPE first'); return }

    const dateStr = document.getElementById('fieldDateInput').value || toDateStr(new Date())

    const btn = document.getElementById('fieldSaveBtn')
    btn.disabled = true
    btn.textContent = 'Saving...'

    const activity = document.getElementById('fieldActivityInput').value.trim() || 'Field Training'
    const avgHr = parseInt(document.getElementById('fieldAvgHr').value) || null
    await saveFieldTraining(dateStr, activity, minutes, selectedRpe, avgHr)
  })
}

async function saveFieldTraining(dateStr, activityName, durationMinutes, rpe, avgHeartRate) {
  let dayId
  try {
    ({ dayId } = await findOrCreateSelfLoggedDay(dateStr, activityName))
  } catch (err) {
    const btn = document.getElementById('fieldSaveBtn')
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save' }
    return
  }

  // Today: use the real current time, so logging right after finishing
  // reflects an accurate clock time. A past day: the exact time isn't
  // known, so anchor near midday - just keeps the derived clock time
  // looking plausible; local_date below (not started_at) is what actually
  // decides which day this counts toward everywhere in the app now
  const isToday = dateStr === toDateStr(new Date())
  const endedAt = isToday ? new Date() : new Date(parseDateStr(dateStr).getTime() + 12 * 60 * 60000)
  const startedAt = new Date(endedAt.getTime() - durationMinutes * 60000)

  const { data, error } = await supabase
    .from('workout_sessions')
    .insert([{
      program_day_id: dayId,
      athlete_id: athlete.id,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      local_date: dateStr,
      session_rpe: rpe,
      avg_heart_rate: avgHeartRate
    }])
    .select()

  if (error) {
    console.log(error)
    customAlert('Something went wrong saving your workout - please try again')
    const btn = document.getElementById('fieldSaveBtn')
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save' }
    return
  }

  notifyCoach('workout_completed', `${athlete.name} completed ${activityName}`)
  await loadTrainingData()
  const entries = entriesByDate[dateStr] || []
  const entry = entries.find(e => e.day.id === dayId)
  renderWorkoutSummary(data[0], entry)
}

// ==========================================================================
// ---- WEEKLY RECAP POPUP ----
// Shows a "here's what you did last week" popup at most once per week, the
// first time the athlete opens the app that week (not an actual push
// notification - see the weekly_recap_enabled setting's comment for why).
// Tracked in localStorage rather than the database since it's purely a
// "have I already shown this on this device" flag, not something the coach
// or any other device needs to know about.
// ==========================================================================
// Returns whether it actually showed - enterWeekView() uses this to decide
// whether to show queued coach messages right away or wait for this
// modal's own close button to chain into them instead
function maybeShowWeeklyRecap() {
  if (!athlete.weekly_recap_enabled) return false

  const thisWeekKey = toDateStr(startOfWeek(new Date()))
  if (localStorage.getItem('tbflog-recap-shown-week') === thisWeekKey) return false

  const lastWeekStart = addDays(startOfWeek(new Date()), -7)
  const stats = computeWeekRecap(lastWeekStart)
  localStorage.setItem('tbflog-recap-shown-week', thisWeekKey)

  // Nothing happened last week (e.g. a brand new athlete) - showing an
  // empty recap isn't useful, so skip the popup but still mark it seen
  if (stats.totalWorkouts === 0 && stats.totalSets === 0) return false

  showWeeklyRecapModal(stats)
  return true
}

// ==========================================================================
// ---- COACH MESSAGES ----
// A coach can send a message that shows either the next time this athlete
// opens the app ('on_open'), right before they start their next workout
// ('before_workout', gated inside startWorkout() below), or as a real push
// notification ('push', sent immediately from script.js - see sendPush()
// in push.js). A 'push' message is also inserted into this same table as a
// fallback, in case it's missed/dismissed or the athlete never enabled
// push on this device - it just falls into the same on-open bucket as
// 'on_open' rather than getting its own third bucket. Loaded once per
// session into these two caches; each queue is cleared and marked seen the
// moment it's actually shown, so re-opening the app or starting another
// workout later in the same session never shows the same message twice.
// ==========================================================================
let onOpenMessagesCache = []
let beforeWorkoutMessagesCache = []

async function loadCoachMessages() {
  const { data, error } = await saveWithRetry((signal) => supabase
    .from('coach_messages')
    .select('*')
    .eq('athlete_id', athlete.id)
    .is('seen_at', null)
    .order('created_at')
    .abortSignal(signal)
  )
  if (error) { console.log(error); return }
  // 'push' messages already arrived as a real notification, but if it was
  // missed/dismissed (or push was never enabled on this device), it still
  // needs to catch up here - falls into the same on-open bucket as
  // 'on_open' rather than getting its own third bucket
  beforeWorkoutMessagesCache = (data || []).filter(m => m.timing === 'before_workout')
  onOpenMessagesCache = (data || []).filter(m => m.timing !== 'before_workout')
}

// Never awaited by callers - a failed "mark seen" shouldn't block or alert
// on the athlete's own flow (same reasoning as notifyCoach above); worst
// case the same message shows again next time, which is harmless
async function markMessagesSeen(messages) {
  const ids = messages.map(m => m.id)
  if (ids.length === 0) return
  const { error } = await supabase.from('coach_messages').update({ seen_at: new Date().toISOString() }).in('id', ids)
  if (error) console.log(error)
}

// onContinue is null for the on_open case (the button just closes the
// modal) and the actual "now really start the workout" callback for the
// before_workout case - see startWorkout() below
function showCoachMessagesModal(messages, onContinue) {
  document.getElementById('coachMessageBody').innerHTML = messages
    .map(m => `<p class="coach-message-text">${escapeHtml(m.message)}</p>`)
    .join('')
  document.getElementById('coachMessageModal').classList.add('active')
  document.getElementById('coachMessageContinueBtn').textContent = onContinue ? 'Continue' : 'Got it'
  // Overwriting .onclick (not addEventListener) means each show cleanly
  // replaces the previous one instead of listeners piling up across a
  // long-lived session with several messages shown over time
  document.getElementById('coachMessageContinueBtn').onclick = function() {
    document.getElementById('coachMessageModal').classList.remove('active')
    if (onContinue) onContinue()
  }
}

function maybeShowOnOpenMessages() {
  if (onOpenMessagesCache.length === 0) return
  const messages = onOpenMessagesCache
  onOpenMessagesCache = []
  markMessagesSeen(messages)
  showCoachMessagesModal(messages, null)
}

// Also powers the on-demand Weekly Stats view (see renderWeeklyStats
// below) - scheduledCount/scheduledCompletedCount/totalVolume/hasVolumeData/
// prEvents are additive fields that view needs; totalWorkouts/totalSets/
// totalReps/totalDurationMs keep their exact original meaning and
// accumulation so the auto-popup above is unaffected
function computeWeekRecap(weekStart) {
  let totalWorkouts = 0
  let totalSets = 0
  let totalReps = 0
  let totalDurationMs = 0
  let scheduledCount = 0
  let scheduledCompletedCount = 0
  let totalVolume = 0
  let hasVolumeData = false

  for (let i = 0; i < 7; i++) {
    const dateStr = toDateStr(addDays(weekStart, i))
    const entries = entriesByDate[dateStr] || []
    for (const entry of entries) {
      // A self-logged workout (Strength or Field/Training) counts as
      // "scheduled" too, not just coach-assigned days - a Field/Training
      // entry in particular has zero program_exercises by design, so the
      // exercise-count check alone would silently drop it from the count
      const isScheduled = entry.day.program_exercises.length > 0 || !!(entry.program && entry.program.created_by_athlete)
      const session = completedSessionsByDayId[entry.day.id]
      if (isScheduled) {
        scheduledCount++
        if (session) scheduledCompletedCount++
      }
      if (!session) continue // only count workouts that were actually finished

      totalWorkouts++
      totalDurationMs += new Date(session.ended_at) - new Date(session.started_at)

      for (const pe of entry.day.program_exercises) {
        const sets = (logSetsByPE[pe.id] || []).filter(s => s.completed_at)
        totalSets += sets.length
        for (const s of sets) {
          const reps = parseInt(s.actual_reps)
          if (!isNaN(reps)) totalReps += reps
          if (pe.exercises && pe.exercises.tracks_weight && s.actual_weight != null && !isNaN(reps)) {
            totalVolume += reps * s.actual_weight
            hasVolumeData = true
          }
        }
      }
    }
  }

  return {
    totalWorkouts, totalSets, totalReps, totalDurationMs,
    scheduledCount, scheduledCompletedCount, totalVolume, hasVolumeData,
    prEvents: computeWeekPREvents(weekStart)
  }
}

// A little tiered feel-good message rather than one fixed line - a quiet
// week gets encouragement to jump back in, not silence or a guilt trip
function pickRecapMessage(totalWorkouts) {
  if (totalWorkouts === 0) return "A quiet week - let's get back into it this week 💪"
  if (totalWorkouts <= 2) return 'Nice work getting sessions in - keep building on it!'
  return 'Great consistency last week - keep it up! 🔥'
}

function showWeeklyRecapModal(stats) {
  const durationMin = Math.round(stats.totalDurationMs / 60000)
  const durationText = durationMin >= 60 ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m` : `${durationMin}m`

  document.getElementById('weeklyRecapBody').innerHTML = `
    <div class="workout-summary-stats" style="flex-wrap:wrap; gap:20px">
      <div><div class="workout-summary-stat-value">${stats.totalWorkouts}</div><div class="workout-summary-stat-label">Workouts</div></div>
      <div><div class="workout-summary-stat-value">${stats.totalSets}</div><div class="workout-summary-stat-label">Sets</div></div>
      <div><div class="workout-summary-stat-value">${stats.totalReps}</div><div class="workout-summary-stat-label">Reps</div></div>
      <div><div class="workout-summary-stat-value">${durationText}</div><div class="workout-summary-stat-label">Time</div></div>
    </div>
    <p style="margin-top:20px; color:#aaaacc; text-align:center">${pickRecapMessage(stats.totalWorkouts)}</p>
  `
  document.getElementById('weeklyRecapModal').classList.add('active')
}

// ==========================================================================
// ---- WEEKLY STATS (Stats tab, gated by athlete.can_view_weekly_stats) ----
// Same underlying computeWeekRecap() as the auto-popup above, just picked
// on demand for any of the last 8 Monday-Sunday weeks instead of always
// "last week". A full-page screen like every other tab (was a modal
// originally, before the bottom nav existed) - open on a default
// selection, re-render just the body in place on each pick.
// ==========================================================================
function renderWeeklyStats() {
  setActiveBottomTab('stats')
  const thisMonday = startOfWeek(new Date())

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button class="btn-cancel" id="backFromWeeklyStatsBtn">← Back</button>
      <h2 class="day-view-date">Weekly Stats</h2>
    </div>
    <div class="week-picker-list" id="weeklyStatsWeekList">
      ${Array.from({ length: 8 }, (_, i) => {
        const ws = addDays(thisMonday, -7 * i)
        const label = i === 0 ? 'This Week' : i === 1 ? 'Last Week' : `${i} Weeks Ago`
        return `<button type="button" class="week-picker-row ${i === 0 ? 'selected' : ''}" data-week-start="${toDateStr(ws)}">
          <span class="week-picker-label">${label}</span>
          <span class="week-picker-range">${formatShortDate(ws)} – ${formatShortDate(addDays(ws, 6))}</span>
        </button>`
      }).join('')}
    </div>
    <div id="weeklyStatsBody"></div>
  `

  document.getElementById('backFromWeeklyStatsBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

  document.getElementById('weeklyStatsWeekList').addEventListener('click', function(e) {
    const btn = e.target.closest('.week-picker-row')
    if (!btn) return
    document.querySelectorAll('#weeklyStatsWeekList .week-picker-row').forEach(b => b.classList.remove('selected'))
    btn.classList.add('selected')
    renderWeeklyStatsBody(parseDateStr(btn.dataset.weekStart))
  })

  renderWeeklyStatsBody(thisMonday)
}

// Weight-based badges (Volume/Weight/Est. 1RM) convert kg -> the athlete's
// unit and round for display, same as every other weight readout in this
// file; Reps/Sets badges are already unitless counts
function formatPRBadgeValue(value, isWeight) {
  if (isWeight) return `${Math.round(formatWeight(value, athlete.weight_unit)).toLocaleString()}${athlete.weight_unit || 'kg'}`
  return Math.round(value).toLocaleString()
}

function renderWeeklyStatsBody(weekStart) {
  const stats = computeWeekRecap(weekStart)
  const durationMin = Math.round(stats.totalDurationMs / 60000)
  const durationText = durationMin >= 60 ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m` : `${durationMin}m`

  document.getElementById('weeklyStatsBody').innerHTML = `
    <div class="workout-summary-stats" style="flex-wrap:wrap; gap:20px">
      <div><div class="workout-summary-stat-value">${stats.scheduledCompletedCount} / ${stats.scheduledCount}</div><div class="workout-summary-stat-label">Workouts</div></div>
      ${stats.hasVolumeData ? `<div><div class="workout-summary-stat-value">${Math.round(formatWeight(stats.totalVolume, athlete.weight_unit))}${athlete.weight_unit || 'kg'}</div><div class="workout-summary-stat-label">Volume</div></div>` : ''}
      <div><div class="workout-summary-stat-value">${durationText}</div><div class="workout-summary-stat-label">Training Time</div></div>
      <div><div class="workout-summary-stat-value">${stats.prEvents.length}</div><div class="workout-summary-stat-label">PRs</div></div>
    </div>
    ${stats.prEvents.length ? `<div class="summary-exercise-list" style="margin-top:20px">${stats.prEvents.map(e => `
      <div class="summary-exercise-row">
        <div class="summary-exercise-name">🏆 ${e.exerciseName}</div>
        ${e.badges.map(b => `<p class="summary-exercise-sets">${b.label}: ${formatPRBadgeValue(b.before, b.isWeight)} → ${formatPRBadgeValue(b.after, b.isWeight)}</p>`).join('')}
      </div>
    `).join('')}</div>` : ''}
    ${stats.scheduledCount === 0 && stats.totalWorkouts === 0 ? '<p class="no-metrics" style="margin-top:16px">Nothing logged this week</p>' : ''}
  `
}

// ==========================================================================
// ---- DAY PREVIEW (read-only, no logging inputs) ----
// ==========================================================================
function renderDayPreview(dateStr) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const isToday = dateStr === toDateStr(new Date())
  const entries = entriesByDate[dateStr] || []

  const bodyHtml = entries.length === 0
    ? '<p class="no-metrics">Rest day — nothing scheduled</p>'
    : entries.map(entry => renderDayPreviewGroup(entry, isToday, dateStr)).join('')

  pageContent.innerHTML = `
    <div class="day-view-header">
      <h2>${isToday ? 'Today' : formatDisplayDate(dateStr)}</h2>
      <button class="btn-cancel" id="backToWeekBtn">Go Back</button>
    </div>
    ${isToday ? `<p class="day-view-date">${formatDisplayDate(dateStr)}</p>` : ''}
    ${renderSyncBannerHtml(loadPendingQueue().length)}
    <div id="dayPreviewBody">${bodyHtml}</div>
  `

  document.getElementById('backToWeekBtn').addEventListener('click', function() {
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

  wireSyncBanner(function() { renderDayPreview(dateStr) })

  document.getElementById('dayPreviewBody').addEventListener('click', function(e) {
    const thumbBtn = e.target.closest('[data-video-url]')
    if (thumbBtn) playInlineVideo(thumbBtn, thumbBtn.dataset.videoUrl)
  })

  entries.forEach(entry => {
    const startBtn = document.getElementById('startWorkoutBtn-' + entry.day.id)
    if (startBtn) startBtn.addEventListener('click', function() { startWorkout(entry, dateStr) })

    const summaryBtn = document.getElementById('viewSummaryBtn-' + entry.day.id)
    if (summaryBtn) summaryBtn.addEventListener('click', function() {
      renderWorkoutSummary(completedSessionsByDayId[entry.day.id], entry)
    })

    const moveBtn = document.getElementById('moveWorkoutBtn-' + entry.day.id)
    if (moveBtn) moveBtn.addEventListener('click', function() { openMoveWorkoutModal(entry.day.id, dateStr) })
  })
}

function renderDayPreviewGroup(entry, isToday, dateStr) {
  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  const openSession = openSessionsByDayId[entry.day.id]
  const completedSession = completedSessionsByDayId[entry.day.id]

  // "Active" = today, with nothing ended yet - keep the preview clean (no
  // logged-value clutter) right up until Start/Continue is pressed. Once a
  // session's been explicitly ended, or the day's in the past, show what
  // was actually logged instead - that's the useful thing to see by then.
  const isActive = isToday && !completedSession
  const showLoggedValues = !isActive

  // completedSession's View Summary isn't gated on exercises.length - a
  // self-logged Field/Training day has zero program_exercises by design
  // (see saveFieldTraining) but still has a real summary to show. A
  // self-logged Strength day can also be genuinely empty (backed out of
  // "Add Own Workout" before adding an exercise) and still needs a way
  // back in - Field/Training never reaches here with 0 exercises since it
  // always has a completedSession the instant it's saved, so this can't
  // wrongly offer "Continue" on a Field/Training entry.
  // An open session (started, never ended) keeps showing "Continue
  // Workout" no matter how many days have passed since - it used to only
  // show on the day it was started, so forgetting to tap "End Workout"
  // meant the very next day the button just vanished with no way back in
  // short of hunting the day down manually.
  let actionButton = ''
  if (completedSession && !openSession) {
    actionButton = `<button type="button" class="start-workout-btn" id="viewSummaryBtn-${entry.day.id}">📋 View Summary</button>`
  } else if (openSession || (isToday && (exercises.length > 0 || entry.program.created_by_athlete))) {
    actionButton = `<button type="button" class="start-workout-btn" id="startWorkoutBtn-${entry.day.id}">${openSession ? '▶ Continue Workout' : '▶ Start Workout'}</button>`
  }

  // One header per run of consecutive exercises sharing the same non-null
  // section_label (exercises is already sorted by order_index above) -
  // reuses the same .builder-section-header class the coach's builders use
  let exercisesHtml = ''
  let lastLabel
  for (const pe of exercises) {
    if (pe.section_label !== lastLabel) {
      if (pe.section_label) exercisesHtml += `<div class="builder-section-header">${pe.section_label}</div>`
      lastLabel = pe.section_label
    }
    exercisesHtml += renderDayPreviewExercise(pe, showLoggedValues)
  }

  return `
    <div class="detail-group">
      <div class="day-preview-group-header">
        <h4 class="detail-group-title">${trainingDisplayName(entry)}</h4>
        ${athlete.can_reschedule_workouts ? `<button type="button" class="exercise-history-btn day-preview-move-btn" id="moveWorkoutBtn-${entry.day.id}">📅 Move</button>` : ''}
      </div>
      ${exercisesHtml}
      ${actionButton}
    </div>
  `
}

function renderDayPreviewExercise(pe, showLogged) {
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const target = targetLine(pe)

  let loggedText = ''
  if (showLogged) {
    const sets = (logSetsByPE[pe.id] || []).filter(s => s.completed_at).sort((a, b) => a.set_number - b.set_number)
    loggedText = sets.map(s => {
      const repsPart = isTimed ? formatTimedReps(s.actual_reps) : `${s.actual_reps || '-'} reps`
      const weightPart = tracksWeight && s.actual_weight != null ? ' @ ' + formatWeight(s.actual_weight, athlete.weight_unit) + (athlete.weight_unit || 'kg') : ''
      return repsPart + weightPart
    }).join(', ')
  }

  return `
    <div class="day-preview-exercise">
      <button type="button" class="day-preview-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="day-preview-thumb-placeholder">🏋</span>'}
      </button>
      <div class="day-preview-info">
        <div class="day-preview-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${target ? `<div class="day-preview-target">Target: ${target}</div>` : ''}
        ${loggedText ? `<div class="day-preview-logged">Logged: ${loggedText}</div>` : ''}
      </div>
    </div>
  `
}

// ==========================================================================
// ---- MOVE WORKOUT (reschedule a day, gated by athlete.can_reschedule_workouts) ----
// Sets program_days.date_override, which every dateStr-resolving query in
// this app (loadTrainingData here, plus the coach's own calendar/Overview/
// PDF report) checks first, ahead of the normal start_date + week_number +
// day_number computation - see resolveDate()'s call site above.
// ==========================================================================
let moveWorkoutDayId = null

function openMoveWorkoutModal(dayId, currentDateStr) {
  moveWorkoutDayId = dayId
  document.getElementById('moveWorkoutDateInput').value = currentDateStr
  document.getElementById('moveWorkoutModal').classList.add('active')
}

document.getElementById('closeMoveWorkoutBtn').addEventListener('click', function() {
  document.getElementById('moveWorkoutModal').classList.remove('active')
})

document.getElementById('cancelMoveWorkoutBtn').addEventListener('click', function() {
  document.getElementById('moveWorkoutModal').classList.remove('active')
})

document.getElementById('saveMoveWorkoutBtn').addEventListener('click', async function() {
  const newDate = document.getElementById('moveWorkoutDateInput').value
  if (!newDate) { customAlert('Please pick a date'); return }

  const { error } = await saveWithRetry((signal) => supabase
    .from('program_days')
    .update({ date_override: newDate })
    .eq('id', moveWorkoutDayId)
    .abortSignal(signal)
  )

  if (error) { console.log(error); customAlert('Something went wrong moving this workout'); return }

  document.getElementById('moveWorkoutModal').classList.remove('active')
  await loadTrainingData()
  renderWeekView(startOfWeek(parseDateStr(newDate)))
})

// ==========================================================================
// ---- ACTIVE WORKOUT (one exercise at a time) ----
// ==========================================================================
async function findOrCreateSession(programDayId) {
  const { data: existing, error: findError } = await saveWithRetry((signal) => supabase
    .from('workout_sessions')
    .select('*')
    .eq('program_day_id', programDayId)
    .eq('athlete_id', athlete.id)
    .is('ended_at', null)
    .maybeSingle()
    .abortSignal(signal)
  )

  if (findError) { console.log(findError) }
  if (existing) return existing

  const { data: newSession, error: insertError } = await saveWithRetry((signal) => supabase
    .from('workout_sessions')
    .insert([{ program_day_id: programDayId, athlete_id: athlete.id, local_date: toDateStr(new Date()) }])
    .select()
    .single()
    .abortSignal(signal)
  )

  if (insertError) {
    console.log(insertError)
    // Never let a failed session-creation insert take down the whole
    // workout - this used to throw, which silently killed "End Workout"
    // (the button's own click handler awaits this promise with no
    // try/catch, so the throw just vanished with zero feedback). Sets save
    // independently of this row (they're keyed by program_exercise_id, not
    // session id) - this session object only backs the duration/RPE
    // display, so a local placeholder lets the workout keep working
    // smoothly even when this one insert is down. That session's duration/
    // RPE just won't have a database row to attach to - a much smaller
    // loss than the workout appearing to do nothing.
    return { id: `local-${programDayId}`, program_day_id: programDayId, athlete_id: athlete.id, started_at: new Date().toISOString(), ended_at: null }
  }
  return newSession
}

// Groups a linked group of up to 4 exercises into one merged "slide" - the
// guided view walks slides, not raw exercises, so a group occupies exactly
// one slot wherever its earliest-ordered member falls (the coach doesn't
// need to keep linked exercises adjacent in the list). A section takes
// priority over a superset when an exercise carries both, since the
// section is the broader unit - confirmed a section should use the exact
// same step-through mechanics as a superset, just a different label.
// exercises is already in order_index order by the time this runs, so
// .filter() naturally keeps members in that same order.
function buildWorkoutSlides(exercises) {
  const slides = []
  const consumed = new Set()
  for (const pe of exercises) {
    if (consumed.has(pe.id)) continue
    const groupId = pe.section_instance_id || pe.superset_group_id
    if (groupId) {
      const members = exercises.filter(x => (x.section_instance_id || x.superset_group_id) === groupId)
      if (members.length > 1) {
        members.forEach(m => consumed.add(m.id))
        slides.push({
          type: 'group',
          groupKind: pe.section_instance_id ? 'section' : 'superset',
          label: pe.section_instance_id ? pe.section_label : null,
          members
        })
        continue
      }
      // no other member in today's exercise list (defensive) - falls
      // through to a normal single slide instead
    }
    slides.push({ type: 'single', pe })
  }
  return slides
}

// The round-robin order a group is stepped through in: every member's
// round 1, then every member's round 2, etc, skipping a member once it
// runs out of sets (a 3-set exercise linked with a 2-set one just stops
// appearing after round 2). Recomputed fresh each time a group is entered/
// re-entered (not cached) since logSetsByPE - and therefore each member's
// count - can change between visits (an athlete-added extra set).
function buildGroupSteps(members) {
  const info = members.map(pe => ({ pe, count: Math.max(pe.prescribed_sets || 1, (logSetsByPE[pe.id] || []).length) }))
  const rounds = Math.max(...info.map(m => m.count))
  const steps = []
  for (let round = 1; round <= rounds; round++) {
    for (const m of info) {
      if (round <= m.count) steps.push({ pe: m.pe, round })
    }
  }
  return steps
}

function slideIsFullyLogged(slide) {
  const pes = slide.type === 'group' ? slide.members : [slide.pe]
  return pes.every(function(pe) {
    const prescribed = pe.prescribed_sets || 1
    const logged = (logSetsByPE[pe.id] || []).filter(s => s.completed_at && s.set_number <= prescribed)
    return logged.length >= prescribed
  })
}

// Resumes at the first slide whose exercise(s) aren't all logged yet -
// derived from already-loaded logSetsByPE, no extra column needed
function findResumeIndex(slides) {
  for (let i = 0; i < slides.length; i++) {
    if (!slideIsFullyLogged(slides[i])) return i
  }
  return Math.max(slides.length - 1, 0)
}

// Same idea as findResumeIndex, one level down - the first step within a
// group whose specific (exercise, round) set isn't logged yet
function findResumeStepIndex(steps) {
  for (let i = 0; i < steps.length; i++) {
    const { pe, round } = steps[i]
    const logged = (logSetsByPE[pe.id] || []).some(s => s.completed_at && s.set_number === round)
    if (!logged) return i
  }
  return Math.max(steps.length - 1, 0)
}

// Gate for any queued 'before_workout' coach messages - shown once, right
// before Start/Continue Workout actually proceeds (both buttons call this
// same function, see renderDayPreviewGroup's actionButton wiring)
function startWorkout(entry, dateStr) {
  if (beforeWorkoutMessagesCache.length > 0) {
    const messages = beforeWorkoutMessagesCache
    beforeWorkoutMessagesCache = []
    markMessagesSeen(messages)
    showCoachMessagesModal(messages, function() { proceedToStartWorkout(entry, dateStr) })
    return
  }
  proceedToStartWorkout(entry, dateStr)
}

// Renders the first exercise immediately - findResumeIndex only needs data
// already loaded in memory, no network required. findOrCreateSession does
// need a round trip (look up an in-progress session, or create one), but
// nothing on screen actually needs the session row until End Workout is
// pressed, so it's kicked off in the background instead of being awaited
// here - awaiting it first was the actual cause of "pressing Start Workout
// does nothing for a second or more", especially on a slow connection.
function proceedToStartWorkout(entry, dateStr) {
  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  const isSelfLogged = !!(entry.program && entry.program.created_by_athlete)
  if (exercises.length === 0 && !isSelfLogged) { customAlert('No exercises in this training'); return }

  const sessionPromise = findOrCreateSession(entry.day.id).then(function(session) {
    openSessionsByDayId[entry.day.id] = session
    return session
  })

  // A self-logged workout has no coach-built list to start from - the
  // athlete builds it live, one exercise at a time, via the same "+ Add
  // Exercise" screen a later slide's button also opens
  if (exercises.length === 0) { renderOwnWorkoutAddExercise(entry, dateStr, sessionPromise); return }

  const slides = buildWorkoutSlides(exercises)
  const resumeIndex = findResumeIndex(slides)
  renderActiveExercise(entry, dateStr, slides, resumeIndex, sessionPromise)
}

// Set on every renderActiveExercise call (single or superset), read by
// maybeStartRestTimer to decide whether the checked exercise is the FIRST
// or SECOND member of a linked pair. Not reset anywhere else on purpose -
// checkSet can only ever fire while a guided slide's DOM (and its
// wireExerciseCardEvents listener) exists, and that DOM is only ever
// created by this function, which always sets this first - so it's
// impossible for a stale value to be read.
let currentSlideContext = null

// Set only while inside a group's step-through (renderGroupStep), read by
// checkSet's auto-advance branch - checkSet only ever receives peId/
// setNumber/dateStr/rowEl (see wireExerciseCardEvents), so this is how it
// reaches entry/slides/index/sessionPromise/steps/stepIndex without
// threading five new parameters through every intermediate call site.
// Same lifecycle guarantee as currentSlideContext above: only ever set by
// renderGroupStep, which always runs before its own DOM (and therefore any
// checkSet call against that DOM) can exist.
let currentGroupNav = null

// direction: 1 when arriving from a Next/swipe-left (new slide enters from
// the right), -1 from Previous/swipe-right (enters from the left), omitted
// for the very first exercise shown (no animation, nothing to slide from)
function renderActiveExercise(entry, dateStr, slides, index, sessionPromise, direction) {
  const slide = slides[index]

  // A linked group (superset or section) gets its own gate + step-through
  // instead of the single-exercise rendering below - see renderGroupGate/
  // renderGroupStep. A freshly-entered group (nothing logged yet) shows
  // the gate; revisiting a partially- or fully-done group skips straight
  // to where it left off, same "pick up where you left off" principle
  // findResumeIndex already applies one level up.
  if (slide.type === 'group') {
    const steps = buildGroupSteps(slide.members)
    const resumeStep = findResumeStepIndex(steps)
    const anythingLogged = steps.some(s => (logSetsByPE[s.pe.id] || []).some(x => x.completed_at && x.set_number === s.round))
    if (!anythingLogged) renderGroupGate(entry, dateStr, slides, index, sessionPromise, direction)
    else renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, resumeStep, direction)
    return
  }

  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const isLast = index === slides.length - 1
  const isSelfLogged = !!(entry.program && entry.program.created_by_athlete)
  // Coach-assigned workouts get the same "+ Add Exercise" flow as
  // self-logged ones when the coach has turned it on for this athlete -
  // addExerciseToOwnWorkout/removeEmptyOwnExercise are already generic
  // enough (see their comments) that no fork is needed beyond this gate
  const canAddExercises = isSelfLogged || !!athlete.can_add_exercises
  currentSlideContext = slide
  currentGroupNav = null

  pageContent.innerHTML = `
    <div class="active-exercise-header-row">
      <p class="active-exercise-progress">Exercise ${index + 1} of ${slides.length}</p>
      ${canAddExercises ? '<button type="button" class="own-add-exercise-btn" id="ownAddExerciseBtn">+ Add Exercise</button>' : ''}
    </div>
    ${renderSingleSlideBody(slide.pe, isSelfLogged)}
    <p class="swipe-hint"><span class="swipe-hint-arrow">‹</span> Swipe for next exercise <span class="swipe-hint-arrow">›</span></p>
    <div id="restTimerBar" class="rest-timer-bar"></div>
  `

  wireExerciseCardEvents('activeExerciseCard', dateStr, canAddExercises ? function(peId) {
    removeEmptyOwnExercise(entry, dateStr, sessionPromise, index, peId)
  } : null)

  const addExerciseBtn = document.getElementById('ownAddExerciseBtn')
  if (addExerciseBtn) {
    addExerciseBtn.addEventListener('click', function() {
      renderOwnWorkoutAddExercise(entry, dateStr, sessionPromise, index)
    })
  }

  // History (every exercise) and Swap (coach-prescribed only, gated inside
  // renderSingleSlideBody) share one delegated listener here rather than
  // folding into wireExerciseCardEvents, since both need entry/slides/
  // index/sessionPromise, which that function doesn't carry
  document.getElementById('activeExerciseCard').addEventListener('click', function(e) {
    const historyBtn = e.target.closest('.exercise-history-btn')
    if (historyBtn) {
      openExerciseHistoryModal(historyBtn.dataset.exerciseId, historyBtn.dataset.exerciseName, !!historyBtn.dataset.isTimed, !!historyBtn.dataset.tracksWeight, !!historyBtn.dataset.tracksDistance)
      return
    }
    const swapBtn = e.target.closest('.exercise-swap-btn')
    if (swapBtn) { openSwapModal(entry, dateStr, slides, index, sessionPromise, swapBtn.dataset.peId) }
  })

  attachSwipeHandlers(
    function onSwipeLeft() {
      if (isLast) renderEndOfWorkoutSlide(entry, dateStr, slides, sessionPromise, 1)
      else renderActiveExercise(entry, dateStr, slides, index + 1, sessionPromise, 1)
    },
    // Passing null (instead of a function that no-ops on index 0) matters:
    // attachSwipeHandlers plays the slide-out-off-screen animation whenever
    // a callback is present at all, whether or not it actually goes
    // anywhere - on the first exercise that meant the card would slide
    // fully off screen and just leave a blank gap, since there's no
    // previous exercise to replace it with.
    index > 0 ? function onSwipeRight() {
      renderActiveExercise(entry, dateStr, slides, index - 1, sessionPromise, -1)
    } : null
  )

  mountSlide(direction)
}

// ==========================================================================
// ---- GROUP STEP-THROUGH (superset / section) ----
// A linked group is done as one continuous round-robin sequence instead of
// a single merged card: "Start Superset/Section" gate, then exercise 1's
// set 1, exercise 2's set 1, ... straight through with no pause, a rest
// only once every member has done that round, then the next round starts
// automatically. See buildGroupSteps for the exact step order.
// ==========================================================================
function renderGroupGate(entry, dateStr, slides, index, sessionPromise, direction) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const slide = slides[index]
  currentSlideContext = slide
  currentGroupNav = null

  const kindLabel = slide.groupKind === 'section' ? '🧩 Section' : '🔗 Superset'
  const title = slide.label || (slide.groupKind === 'section' ? 'Section' : 'Superset')

  pageContent.innerHTML = `
    <div class="active-exercise-header-row">
      <p class="active-exercise-progress">Exercise ${index + 1} of ${slides.length}</p>
    </div>
    <div id="activeExerciseCard" class="workout-slide group-gate">
      <p class="group-gate-kind">${kindLabel}</p>
      <h2 class="group-gate-title">${title}</h2>
      <p class="group-gate-desc">${slide.members.length} exercises, back to back</p>
      <div class="group-gate-list">
        ${slide.members.map(function(pe) {
          const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
          const thumb = getYouTubeThumbnail(videoUrl)
          return `
            <div class="group-gate-item">
              <span class="group-gate-item-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '🏋'}</span>
              <span>${pe.exercises ? pe.exercises.name : 'Exercise'}</span>
            </div>
          `
        }).join('')}
      </div>
      <button type="button" class="btn-save start-workout-btn" id="groupStartBtn">▶ Start ${slide.groupKind === 'section' ? 'Section' : 'Superset'}</button>
    </div>
    <p class="swipe-hint"><span class="swipe-hint-arrow">‹</span> Swipe for next exercise <span class="swipe-hint-arrow">›</span></p>
    <div id="restTimerBar" class="rest-timer-bar"></div>
  `

  const steps = buildGroupSteps(slide.members)
  document.getElementById('groupStartBtn').addEventListener('click', function() {
    renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, 0, 1)
  })

  attachSwipeHandlers(
    function onSwipeLeft() {
      renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, 0, 1)
    },
    index > 0 ? function onSwipeRight() {
      renderActiveExercise(entry, dateStr, slides, index - 1, sessionPromise, -1)
    } : null
  )

  mountSlide(direction)
}

function renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, stepIndex, direction) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const slide = slides[index]
  const { pe, round } = steps[stepIndex]
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const logged = (logSetsByPE[pe.id] || []).find(s => s.set_number === round)
  const isSelfLogged = !!(entry.program && entry.program.created_by_athlete)
  currentSlideContext = slide
  currentGroupNav = { entry, dateStr, slides, index, sessionPromise, steps, stepIndex }

  const kindIcon = slide.groupKind === 'section' ? '🧩' : '🔗'
  const rounds = Math.max(...steps.map(s => s.round))

  pageContent.innerHTML = `
    <div class="active-exercise-header-row">
      <p class="active-exercise-progress">Exercise ${index + 1} of ${slides.length} · ${kindIcon} Round ${round} of ${rounds}</p>
    </div>
    <div id="activeExerciseCard" class="workout-slide">
      <button type="button" class="active-exercise-thumb" data-video-url="${videoUrl}" ${videoUrl ? '' : 'disabled'}>
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="active-exercise-thumb-placeholder">🏋</span>'}
      </button>
      <div class="active-exercise-title-row">
        <div class="active-exercise-title">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${exerciseActionButtonsHtml(pe, isSelfLogged, true)}
      </div>
      ${pe.notes ? `<p class="exercise-log-notes">${pe.notes}</p>` : ''}
      <div class="set-rows">${renderSetRow(pe, round, logged, isTimed, tracksWeight, false)}</div>
    </div>
    <p class="swipe-hint"><span class="swipe-hint-arrow">‹</span> Swipe to skip <span class="swipe-hint-arrow">›</span></p>
    <div id="restTimerBar" class="rest-timer-bar"></div>
  `

  wireExerciseCardEvents('activeExerciseCard', dateStr, null)

  document.getElementById('activeExerciseCard').addEventListener('click', function(e) {
    const historyBtn = e.target.closest('.exercise-history-btn')
    if (historyBtn) {
      openExerciseHistoryModal(historyBtn.dataset.exerciseId, historyBtn.dataset.exerciseName, !!historyBtn.dataset.isTimed, !!historyBtn.dataset.tracksWeight, !!historyBtn.dataset.tracksDistance)
    }
    // No Swap inside a group step - swapping one exercise mid-round has no
    // clean "which round does the new exercise start at" answer, so
    // exerciseActionButtonsHtml is told (via its 3rd arg) never to render
    // the Swap button here at all
  })

  attachSwipeHandlers(
    function onSwipeLeft() {
      goToNextGroupStep(entry, dateStr, slides, index, sessionPromise, steps, stepIndex)
    },
    function onSwipeRight() {
      if (stepIndex === 0) renderGroupGate(entry, dateStr, slides, index, sessionPromise, -1)
      else renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, stepIndex - 1, -1)
    }
  )

  mountSlide(direction)
}

// Shared by checkSet's auto-advance and the manual swipe-left "skip"
// fallback - decides whether the next step is later in the same round
// (advance immediately, no rest), the start of a new round (rest first,
// using the round's last-ordered member's rest_seconds/target - same rule
// this app already used for supersets before this rework), or past the
// end of the group (hand off to the normal top-level next-slide/
// end-of-workout flow).
function goToNextGroupStep(entry, dateStr, slides, index, sessionPromise, steps, stepIndex) {
  const next = stepIndex + 1
  if (next >= steps.length) {
    const isLast = index === slides.length - 1
    if (isLast) renderEndOfWorkoutSlide(entry, dateStr, slides, sessionPromise, 1)
    else renderActiveExercise(entry, dateStr, slides, index + 1, sessionPromise, 1)
    return
  }

  const finishedRound = steps[stepIndex].round
  const enteringNewRound = steps[next].round !== finishedRound
  if (!enteringNewRound) {
    renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, next, 1)
    return
  }

  const lastMemberOfRound = steps[stepIndex].pe
  const target = lastMemberOfRound.set_targets && lastMemberOfRound.set_targets[finishedRound - 1]
  const restSeconds = target && target.rest != null ? target.rest : lastMemberOfRound.rest_seconds
  if (restSeconds) {
    startRestTimer(restSeconds, function() {
      renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, next, 1)
    })
  } else {
    renderGroupStep(entry, dateStr, slides, index, sessionPromise, steps, next, 1)
  }
}

// Swap only makes sense on a still-unstarted, coach-prescribed exercise -
// once a set's logged, swapping would orphan it under the wrong exercise
// (exercise_log_sets links by program_exercise_id, not exercise_id), and an
// exercise the athlete already added/self-logged is already fully theirs
// to remove and re-add instead.
function canSwapExercise(pe, isSelfLogged) {
  if (isSelfLogged || pe.added_by_athlete || !athlete.can_change_exercises) return false
  return (logSetsByPE[pe.id] || []).every(s => !s.completed_at)
}

// History is unconditional (every exercise); Swap only shows when
// canSwapExercise allows it.
// hideSwap: true inside a group step (see renderGroupStep) - swapping one
// exercise mid-round has no clean "which round does the replacement start
// at" answer, so Swap is only ever offered outside a group's step-through
function exerciseActionButtonsHtml(pe, isSelfLogged, hideSwap) {
  const name = pe.exercises ? pe.exercises.name : 'Exercise'
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const tracksDistance = pe.exercises && pe.exercises.tracks_distance
  return `
    <div class="exercise-action-btns">
      <button type="button" class="exercise-history-btn" data-action="history" data-exercise-id="${pe.exercise_id}" data-exercise-name="${name}" data-is-timed="${isTimed ? '1' : ''}" data-tracks-weight="${tracksWeight ? '1' : ''}" data-tracks-distance="${tracksDistance ? '1' : ''}">📈 History</button>
      ${!hideSwap && canSwapExercise(pe, isSelfLogged) ? `<button type="button" class="exercise-swap-btn" data-action="swap" data-pe-id="${pe.id}">🔁 Swap</button>` : ''}
    </div>
  `
}

// A normal, ungrouped exercise's slide - takes isSelfLogged so it can gate
// the Swap button. A linked group (superset/section) never reaches this -
// see renderGroupGate/renderGroupStep instead.
function renderSingleSlideBody(pe, isSelfLogged) {
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)

  const loggedSets = logSetsByPE[pe.id] || []
  const rowCount = Math.max(pe.prescribed_sets || 1, loggedSets.length)
  let rowsHtml = ''
  for (let setNumber = 1; setNumber <= rowCount; setNumber++) {
    const logged = loggedSets.find(s => s.set_number === setNumber)
    const isExtra = setNumber > (pe.prescribed_sets || 0)
    rowsHtml += renderSetRow(pe, setNumber, logged, isTimed, tracksWeight, isExtra)
  }

  return `
    <div id="activeExerciseCard" class="workout-slide">
      <button type="button" class="active-exercise-thumb" data-video-url="${videoUrl}" ${videoUrl ? '' : 'disabled'}>
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="active-exercise-thumb-placeholder">🏋</span>'}
      </button>
      ${pe.section_label ? `<p class="active-exercise-section-label">${pe.section_label}</p>` : ''}
      <div class="active-exercise-title-row">
        <div class="active-exercise-title">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${exerciseActionButtonsHtml(pe, isSelfLogged)}
      </div>
      ${pe.notes ? `<p class="exercise-log-notes">${pe.notes}</p>` : ''}
      <div class="set-rows">${rowsHtml}</div>
      <button type="button" class="add-set-btn" data-action="add-set" data-pe-id="${pe.id}">+ Add Set</button>
    </div>
  `
}

// ==========================================================================
// ---- EXERCISE HISTORY ----
// Every exercise gets this, unconditionally - shows the athlete's own past
// logged sets for this exercise (matched by exercise_id, so it carries
// across different programs/weeks, same convention loadAndRenderPRBadges
// already uses), most recent session first, set-by-set - seeing "80kg x8,
// 80kg x7, 75kg x10" is what actually answers "what should I load today,"
// not just one aggregate number.
// ==========================================================================
async function loadExerciseHistory(exerciseId, months) {
  const { data: pastPEs, error: peError } = await fetchWithRetry((signal) => supabase
    .from('program_exercises')
    .select('id')
    .eq('exercise_id', exerciseId)
    .abortSignal(signal)
  )
  if (peError) { console.log(peError); return null }

  const peIds = pastPEs.map(pe => pe.id)
  if (peIds.length === 0) return []

  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)

  const { data: sets, error: setsError } = await fetchWithRetry((signal) => supabase
    .from('exercise_log_sets')
    .select('*')
    .in('program_exercise_id', peIds)
    .not('completed_at', 'is', null)
    .gte('date', toDateStr(cutoff))
    .abortSignal(signal)
  )
  if (setsError) { console.log(setsError); return null }

  const byDate = {}
  for (const s of sets) {
    if (!byDate[s.date]) byDate[s.date] = []
    byDate[s.date].push(s)
  }

  // Most recent first - bounded by the chosen time window, not a hard cap
  return Object.keys(byDate)
    .sort((a, b) => b.localeCompare(a))
    .map(date => ({
      date,
      sets: byDate[date].sort((a, b) => a.set_number - b.set_number),
      stats: sessionExerciseStats(byDate[date])
    }))
}

let exerciseHistoryState = { exerciseId: null, isTimed: false, tracksWeight: true, tracksDistance: false, months: 3 }

async function openExerciseHistoryModal(exerciseId, exerciseName, isTimed, tracksWeight, tracksDistance) {
  exerciseHistoryState = { exerciseId, isTimed, tracksWeight, tracksDistance, months: 3 }
  document.getElementById('exerciseHistoryTitle').textContent = exerciseName || 'History'
  document.querySelectorAll('#exerciseHistoryTimeFilters .time-filter-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.months === '3')
  })
  document.getElementById('exerciseHistoryModal').classList.add('active')
  await renderExerciseHistoryBody()
}

async function renderExerciseHistoryBody() {
  const { exerciseId, isTimed, tracksWeight, tracksDistance, months } = exerciseHistoryState
  const body = document.getElementById('exerciseHistoryBody')
  body.innerHTML = '<p class="no-metrics">Loading...</p>'

  const history = await loadExerciseHistory(exerciseId, months)
  if (!document.getElementById('exerciseHistoryModal').classList.contains('active')) return // closed while loading
  if (exerciseHistoryState.exerciseId !== exerciseId) return // a different exercise/filter was opened while this was loading

  if (history === null) { body.innerHTML = '<p class="no-metrics">Something went wrong loading history - check your connection and try again</p>'; return }
  if (history.length === 0) { body.innerHTML = `<p class="no-metrics">No history in the last ${months} month${months > 1 ? 's' : ''}</p>`; return }

  body.innerHTML = history.map(function(day) {
    const setsLine = day.sets.map(function(s) {
      const repsText = isTimed ? formatTimedReps(s.actual_reps) : `${s.actual_reps || '-'} reps`
      // Uses the unit THIS set was actually logged in (falls back to kg -
      // the real stored unit - for older rows saved before weight_unit
      // existed), not the athlete's current default, so switching your
      // default unit later doesn't silently reconvert past history
      const setUnit = s.weight_unit || 'kg'
      const weightText = tracksWeight && s.actual_weight != null ? ' @ ' + formatWeight(s.actual_weight, setUnit) + setUnit : ''
      const distanceText = tracksDistance && s.actual_distance != null ? ` · ${s.actual_distance}m` : ''
      return `<li class="detail-row"><span>Set ${s.set_number}</span><span class="detail-row-value">${repsText}${weightText}${distanceText}</span></li>`
    }).join('')
    const volumeText = tracksWeight && day.stats.volume > 0 ? ` · ${Math.round(formatWeight(day.stats.volume, athlete.weight_unit))}${athlete.weight_unit || 'kg'} total` : ''
    return `
      <div class="detail-group">
        <h4 class="detail-group-title">${formatShortDate(parseDateStr(day.date))}${volumeText}</h4>
        <ul class="detail-list">${setsLine}</ul>
      </div>
    `
  }).join('')
}

document.getElementById('exerciseHistoryTimeFilters').addEventListener('click', function(e) {
  const btn = e.target.closest('.time-filter-btn')
  if (!btn) return
  document.querySelectorAll('#exerciseHistoryTimeFilters .time-filter-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  exerciseHistoryState.months = parseInt(btn.dataset.months)
  renderExerciseHistoryBody()
})

document.getElementById('closeExerciseHistoryBtn').addEventListener('click', function() {
  document.getElementById('exerciseHistoryModal').classList.remove('active')
})

// ==========================================================================
// ---- SWAP EXERCISE ----
// Substitutes a different exercise from the library into an existing
// program_exercises row - keeps the same prescribed sets/reps/weight/rest,
// just changes which exercise fills the slot. Only reachable when
// canSwapExercise allowed the button to render in the first place (coach-
// prescribed, athlete.can_change_exercises on, nothing logged yet).
// ==========================================================================
function openSwapModal(entry, dateStr, slides, index, sessionPromise, peId) {
  document.getElementById('exerciseSwapModal').classList.add('active')
  document.getElementById('exerciseSwapSearchInput').value = ''

  loadExerciseLibrary().then(function(library) {
    if (library === null) return
    if (!document.getElementById('exerciseSwapModal').classList.contains('active')) return // closed before this resolved

    wireExercisePicker(
      document.getElementById('exerciseSwapSearchInput'),
      document.getElementById('exerciseSwapList'),
      library,
      function(newExerciseId) {
        swapExercise(entry, dateStr, slides, index, sessionPromise, peId, newExerciseId)
      }
    )
  })
}

document.getElementById('closeExerciseSwapBtn').addEventListener('click', function() {
  document.getElementById('exerciseSwapModal').classList.remove('active')
})

async function swapExercise(entry, dateStr, slides, index, sessionPromise, peId, newExerciseId) {
  const pe = entry.day.program_exercises.find(p => p.id === peId)
  if (!pe) return

  const { data, error } = await supabase
    .from('program_exercises')
    .update({
      exercise_id: newExerciseId,
      swapped_by_athlete: true,
      original_exercise_id: pe.original_exercise_id || pe.exercise_id,
      // Any field override was pinned for the OLD exercise - carrying it
      // over to whatever the athlete just swapped in wouldn't make sense
      tracks_weight_override: null,
      is_timed_override: null,
      is_unilateral_override: null,
      tracks_distance_override: null
    })
    .eq('id', peId)
    .select('*, exercises!exercise_id(name, category, type, video_url, foot_contacts, intensity_tier, tracks_weight, is_timed, is_unilateral, tracks_distance)')
    .single()

  if (error) { console.log(error); customAlert('Something went wrong swapping that exercise - please try again'); return }

  Object.assign(pe, data)
  document.getElementById('exerciseSwapModal').classList.remove('active')
  // Slide objects hold references to the same pe object mutated above, so
  // re-rendering the current slide is enough - no need to rebuild slides
  renderActiveExercise(entry, dateStr, slides, index, sessionPromise)
}

// Reached by pressing Next (or swiping left) on the last exercise - the
// only place "End Workout" lives now, instead of a persistent link on
// every slide
function renderEndOfWorkoutSlide(entry, dateStr, slides, sessionPromise, direction) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  pageContent.innerHTML = `
    <p class="active-exercise-progress">Workout Complete</p>
    <div class="workout-summary workout-slide">
      <h2>Nice work 💪</h2>
      <p style="color:#aaaacc">That's every exercise. Ready to finish up?</p>
      <button class="btn-save start-workout-btn" id="endWorkoutBtn">End Workout</button>
    </div>
    <p class="swipe-hint"><span class="swipe-hint-arrow">‹</span> Swipe to go back</p>
  `

  document.getElementById('endWorkoutBtn').addEventListener('click', function() {
    finishWorkout(entry, sessionPromise)
  })

  attachSwipeHandlers(
    null, // already the last slide, nothing to swipe forward to
    function onSwipeRight() {
      renderActiveExercise(entry, dateStr, slides, slides.length - 1, sessionPromise, -1)
    }
  )

  mountSlide(direction)
}

// ==========================================================================
// ---- SWIPE NAVIGATION ----
// Drags the current ".workout-slide" 1:1 with the finger, and snaps it out
// (then calls the nav callback) once a horizontal drag clears the
// threshold. Uses the Pointer Events API so touch, mouse, and pen all work
// through one code path. Pointer capture is only taken once a drag is
// confirmed horizontal - never on a plain tap - so taps on set-row inputs/
// buttons inside the slide are completely unaffected.
// ==========================================================================
function mountSlide(direction) {
  const slide = document.querySelector('.workout-slide')
  if (!slide || !direction) return
  slide.style.transition = 'none'
  slide.style.transform = `translateX(${direction * 100}%)`
  // Two rAFs: the first lets the browser paint the off-screen starting
  // position, the second then starts the transition to translateX(0)
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      slide.style.transition = 'transform 0.2s ease-out'
      slide.style.transform = 'translateX(0)'
      // Clear the transition once it's done so a later drag on this same
      // slide gets instant 1:1 tracking instead of fighting a leftover
      // animation duration
      setTimeout(function() { slide.style.transition = '' }, 220)
    })
  })
}

// Listens on the whole page area (not just the exercise card) so a swipe
// can start from the progress text, the padding around the card, the
// "Swipe for next exercise" hint, anywhere - only an actual video (an
// iframe, once the thumbnail's been tapped to play it) can't be swiped
// over, since touches landing on it never reach this listener at all.
// Only the card itself (.workout-slide) visually slides - pageContent is
// persistent across renders (only its innerHTML gets replaced), so unlike
// the old element-per-render approach, listeners here must be explicitly
// torn down before attaching a fresh set on the next render, or they'd
// pile up and old renders' stale closures would keep firing alongside it.
let swipeCleanup = null

function attachSwipeHandlers(onSwipeLeft, onSwipeRight) {
  if (swipeCleanup) { swipeCleanup(); swipeCleanup = null }

  const touchArea = pageContent
  let slide = null
  let startX = 0
  let startY = 0
  let currentX = 0
  let dragging = false
  let horizontal = false

  function onPointerDown(e) {
    if (e.target.closest('input, button, iframe, select, textarea')) return
    slide = touchArea.querySelector('.workout-slide')
    if (!slide) return
    startX = e.clientX
    startY = e.clientY
    currentX = startX
    dragging = true
    horizontal = false
  }

  function onPointerMove(e) {
    if (!dragging) return
    currentX = e.clientX
    const deltaX = currentX - startX
    const deltaY = e.clientY - startY

    if (!horizontal) {
      if (Math.abs(deltaX) < 10) return
      if (Math.abs(deltaX) < Math.abs(deltaY) * 1.5) { dragging = false; return } // vertical scroll, not a swipe
      horizontal = true
      slide.classList.add('dragging')
      slide.style.transition = 'none'
      touchArea.setPointerCapture(e.pointerId)
    }

    slide.style.transform = `translateX(${deltaX}px)`
  }

  function endDrag() {
    if (!dragging) return
    dragging = false
    if (!horizontal) return
    slide.classList.remove('dragging')

    const deltaX = currentX - startX
    const threshold = 70

    if (deltaX <= -threshold && onSwipeLeft) {
      slideOut(-1, onSwipeLeft)
    } else if (deltaX >= threshold && onSwipeRight) {
      slideOut(1, onSwipeRight)
    } else {
      slide.style.transition = 'transform 0.2s ease-out'
      slide.style.transform = 'translateX(0)'
    }
  }

  function slideOut(direction, callback) {
    slide.style.transition = 'transform 0.18s ease-in'
    slide.style.transform = `translateX(${direction * 100}%)`
    setTimeout(callback, 180)
  }

  // .workout-slide's own touch-action:pan-y (still set in CSS, unchanged)
  // only covered the card itself - now that a drag can start anywhere in
  // this wider area, the same "let vertical scroll through, don't fight
  // our horizontal drag" rule needs to apply here too, scoped to exactly
  // while a workout screen with swipe handling is showing (reset on
  // cleanup so it doesn't leak onto whatever screen replaces this one).
  touchArea.style.touchAction = 'pan-y'

  touchArea.addEventListener('pointerdown', onPointerDown)
  touchArea.addEventListener('pointermove', onPointerMove)
  touchArea.addEventListener('pointerup', endDrag)
  touchArea.addEventListener('pointercancel', endDrag)

  swipeCleanup = function() {
    touchArea.style.touchAction = ''
    touchArea.removeEventListener('pointerdown', onPointerDown)
    touchArea.removeEventListener('pointermove', onPointerMove)
    touchArea.removeEventListener('pointerup', endDrag)
    touchArea.removeEventListener('pointercancel', endDrag)
  }
}

// Goes straight to the summary the instant this is confirmed - it's built
// entirely from data already in memory (logSetsByPE, entry), so there's
// nothing worth waiting on here. Both saves below happen in the
// background: flushPendingQueue for any not-yet-synced sets (already
// durable on its own), and saveSessionEnd for marking this session ended,
// which falls into its own durable queue (see PENDING SESSION-END QUEUE
// below) if the immediate attempt fails - so a bad connection just means
// that timestamp syncs a little late, invisibly, instead of blocking the
// athlete with an error the way a single unprotected save used to.
async function finishWorkout(entry, session) {
  if (!(await customConfirm('Finish this workout?'))) return

  // session is the promise kicked off back in startWorkout - by now (after
  // swiping through the whole workout) it's almost always already resolved,
  // so this await is normally instant
  session = await session

  const endedAt = new Date().toISOString()
  const finishedSession = { ...session, ended_at: endedAt }

  // Update local state directly instead of a full loadTrainingData()
  // reload - the week view (reached via the summary's Done button) needs
  // this day to show "View Summary" instead of "Continue Workout" right
  // away, without waiting on a fresh fetch
  completedSessionsByDayId[entry.day.id] = finishedSession
  delete openSessionsByDayId[entry.day.id]

  clearTimeout(flushTimer) // don't wait out the debounce - flush what's pending right now
  flushPendingQueue() // not awaited - runs in the background regardless
  saveSessionEnd(session.id, endedAt) // not awaited
  notifyCoach('workout_completed', `${athlete.name} completed ${trainingDisplayName(entry)}`) // not awaited

  renderWorkoutSummary(finishedSession, entry)
}

function renderWorkoutSummary(finishedSession, entry) {
  clearRestTimer()
  pageWrap.classList.add('wide')
  cardWrap.classList.add('wide')

  const durationMs = new Date(finishedSession.ended_at) - new Date(finishedSession.started_at)
  const durationMin = Math.floor(durationMs / 60000)
  const durationSec = Math.floor((durationMs % 60000) / 1000)
  const durationText = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSec}s`
  // Rounded minutes, not the exact floor above - both the >180 cap check and
  // the edit input default work in whole minutes, not minutes+seconds
  const durationMinRounded = Math.round(durationMs / 60000)
  const needsDurationReview = durationMinRounded > 180

  // Volume = actual_weight x actual_reps, summed across every completed set
  // logged for this day's exercises - skips sets whose reps didn't parse as
  // a plain number (duration text, rep ranges left un-edited, etc.), and
  // skips any exercise that doesn't track weight at all. hasVolumeData
  // tracks whether any of that actually applied - a Field/Training session
  // (self-logged, zero exercises) or a coach-assigned day with no
  // weight-tracked exercises (a run, a field session, etc.) should hide the
  // tile entirely rather than show a meaningless "0kg"
  let totalVolume = 0
  let hasVolumeData = false
  for (const pe of entry.day.program_exercises) {
    if (!pe.exercises || !pe.exercises.tracks_weight) continue
    const sets = logSetsByPE[pe.id] || []
    for (const s of sets) {
      if (!s.completed_at || s.actual_weight == null) continue
      const reps = parseInt(s.actual_reps)
      if (!isNaN(reps)) { totalVolume += reps * s.actual_weight; hasVolumeData = true }
    }
  }

  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  const breakdownHtml = exercises.map(pe => {
    const isPlyo = pe.exercises && pe.exercises.type === 'plyometric'
    const sets = (logSetsByPE[pe.id] || []).filter(s => s.completed_at).sort((a, b) => a.set_number - b.set_number)
    if (sets.length === 0) return ''

    // foot_contacts/intensity_tier are fixed per exercise (set once in the
    // Exercise Library), not logged per set - plyo_load is just that fixed
    // rate applied across however many sets were actually completed today
    const plyoMultiplier = { low: 1, moderate: 1.5, high: 2 }[pe.exercises && pe.exercises.intensity_tier] || 1
    const plyoLoad = isPlyo ? (pe.exercises.foot_contacts || 0) * plyoMultiplier * sets.length : null

    return `
      <div class="summary-exercise-row">
        <div class="summary-exercise-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        <div class="pr-badges" id="prBadges-${pe.id}"></div>
        ${plyoLoad != null ? `<p class="plyo-load-line">Plyo Load: ${Math.round(plyoLoad)}</p>` : ''}
        <p class="summary-exercise-sets">${sets.length} set${sets.length === 1 ? '' : 's'}</p>
      </div>
    `
  }).join('')

  pageContent.innerHTML = `
    <div class="workout-summary">
      <h2>Workout Complete 💪</h2>
      <div class="workout-summary-stats">
        <div>
          <div class="workout-summary-stat-value">${durationText}</div>
          <div class="workout-summary-stat-label">Duration</div>
          <button type="button" class="duration-edit-btn" id="durationEditBtn">✏ Edit</button>
        </div>
        ${hasVolumeData ? `
        <div>
          <div class="workout-summary-stat-value">${Math.round(formatWeight(totalVolume, athlete.weight_unit))}${athlete.weight_unit || 'kg'}</div>
          <div class="workout-summary-stat-label">Total Volume</div>
        </div>
        ` : ''}
      </div>
      ${needsDurationReview ? `<p class="duration-warning">This looks long — ${durationMinRounded}m. Forget to stop the timer? Tap Edit to fix it.</p>` : ''}
      <div class="duration-edit-row" id="durationEditRow" style="display:none">
        <input type="number" id="durationEditInput" min="1" value="${durationMinRounded}">
        <span>minutes</span>
        <button type="button" class="btn-save" id="durationSaveBtn">Save</button>
        <button type="button" class="btn-cancel" id="durationCancelBtn">Cancel</button>
      </div>
    </div>

    <div class="rpe-picker">
      <p class="rpe-picker-label">Effort (RPE)</p>
      <div class="rpe-picker-row" id="rpePickerRow">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button type="button" class="rpe-btn ${finishedSession.session_rpe === n ? 'selected' : ''}" data-rpe="${n}">${n}</button>`).join('')}
      </div>
      <p class="rpe-picker-hint" id="rpePickerHint">${finishedSession.session_rpe ? RPE_DESCRIPTIONS[finishedSession.session_rpe] : 'Tap a number to rate how hard it felt'}</p>
      <div class="rpe-flag-followup" id="rpeFlagFollowup" style="display:${finishedSession.session_rpe >= 9 ? 'block' : 'none'}">
        <p class="rpe-flag-question">That's a high rating - what made it feel that hard?</p>
        <div class="rpe-flag-choice-row" id="rpeFlagChoiceRow">
          <button type="button" class="rpe-flag-choice-btn ${finishedSession.rpe_flag_reason === 'heavy_tiring' ? 'selected' : ''}" data-reason="heavy_tiring">😮‍💨 Just heavy / tiring</button>
          <button type="button" class="rpe-flag-choice-btn ${finishedSession.rpe_flag_reason === 'pain_injury' ? 'selected' : ''}" data-reason="pain_injury">🤕 Pain or injury</button>
        </div>
        <div class="rpe-flag-note-row" id="rpeFlagNoteRow" style="display:${finishedSession.rpe_flag_reason === 'pain_injury' ? 'block' : 'none'}">
          <label>What happened / what hurts?</label>
          <textarea id="rpeFlagNoteInput" rows="3" placeholder="e.g. Sharp pain in my left knee on the last set of squats">${finishedSession.rpe_flag_note || ''}</textarea>
          <button type="button" class="btn-save" id="rpeFlagNoteSaveBtn">Save note</button>
          <span class="rpe-flag-note-saved" id="rpeFlagNoteSaved" style="display:none">Saved ✓</span>
        </div>
      </div>
    </div>

    <div class="summary-exercise-list">${breakdownHtml || '<p class="no-metrics">Nothing logged</p>'}</div>
    <button class="btn-save start-workout-btn" id="summaryDoneBtn">Done</button>
  `

  document.getElementById('summaryDoneBtn').addEventListener('click', async function() {
    // Safety net: a typed-but-unsaved pain/injury note shouldn't be lost
    // just because the athlete tapped Done instead of "Save note"
    const noteRow = document.getElementById('rpeFlagNoteRow')
    const noteInput = document.getElementById('rpeFlagNoteInput')
    if (noteRow && noteInput && noteRow.style.display !== 'none' && noteInput.value !== (finishedSession.rpe_flag_note || '')) {
      await saveRpeFlagNote(finishedSession, noteInput.value)
    }
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

  wireSummaryRpePicker(finishedSession)
  wireRpeFlagFollowup(finishedSession)
  wireSummaryDurationEdit(finishedSession, entry)
  // Not awaited - the summary above is already fully usable from data
  // already in memory, same reasoning as why Start Workout no longer waits
  // on a network round trip before rendering. PR badges patch in once ready.
  loadAndRenderPRBadges(finishedSession, entry)
}

// Tapping a number saves instantly - same optimistic + saveWithRetry
// pattern as checkSet/uncheckSet, since this is one tap of one value, not a
// multi-field form (the coach builders' "one Save button" rule doesn't
// apply here)
function wireSummaryRpePicker(session) {
  const row = document.getElementById('rpePickerRow')
  if (!row) return

  row.addEventListener('click', async function(e) {
    const btn = e.target.closest('.rpe-btn')
    if (!btn) return
    const rpe = parseInt(btn.dataset.rpe)

    row.querySelectorAll('.rpe-btn').forEach(b => b.classList.remove('selected'))
    btn.classList.add('selected')
    session.session_rpe = rpe
    document.getElementById('rpePickerHint').textContent = RPE_DESCRIPTIONS[rpe]

    const followup = document.getElementById('rpeFlagFollowup')
    if (followup) followup.style.display = rpe >= 9 ? 'block' : 'none'

    // This session was never actually created in the database (see the
    // local- placeholder in findOrCreateSession) - nothing to update there
    if (session.id.startsWith('local-')) return

    const { error } = await saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .update({ session_rpe: rpe })
      .eq('id', session.id)
      .abortSignal(signal)
    )

    if (error) {
      console.log(error)
      customAlert('Something went wrong saving your effort rating: ' + describeError(error))
      return
    }

    // Dropping back below 9 clears any flag already answered - an
    // accidental high tap followed by a correction shouldn't leave a
    // stale pain/injury report behind
    if (rpe < 9 && session.rpe_flag_reason) {
      session.rpe_flag_reason = null
      session.rpe_flag_note = null
      session.rpe_flag_reviewed_at = null
      document.querySelectorAll('#rpeFlagChoiceRow .rpe-flag-choice-btn').forEach(b => b.classList.remove('selected'))
      const noteRow = document.getElementById('rpeFlagNoteRow')
      if (noteRow) noteRow.style.display = 'none'
      await saveWithRetry((signal) => supabase
        .from('workout_sessions')
        .update({ rpe_flag_reason: null, rpe_flag_note: null, rpe_flag_reviewed_at: null })
        .eq('id', session.id)
        .abortSignal(signal)
      )
    }
  })
}

// The RPE >= 9 follow-up: is this heavy/tiring, or pain/injury? Reason
// saves instantly like the RPE tap itself; the note (free text) gets its
// own explicit "Save note" button, plus a safety-net flush on the
// summary's Done button (see renderWorkoutSummary) in case it's skipped.
function wireRpeFlagFollowup(session) {
  const choiceRow = document.getElementById('rpeFlagChoiceRow')
  const noteRow = document.getElementById('rpeFlagNoteRow')
  const noteSaveBtn = document.getElementById('rpeFlagNoteSaveBtn')
  if (!choiceRow) return

  choiceRow.addEventListener('click', async function(e) {
    const btn = e.target.closest('.rpe-flag-choice-btn')
    if (!btn) return
    const reason = btn.dataset.reason

    choiceRow.querySelectorAll('.rpe-flag-choice-btn').forEach(b => b.classList.remove('selected'))
    btn.classList.add('selected')
    session.rpe_flag_reason = reason
    noteRow.style.display = reason === 'pain_injury' ? 'block' : 'none'

    // A new or changed reason needs the coach to look at it again
    const update = { rpe_flag_reason: reason, rpe_flag_reviewed_at: null }
    if (reason === 'heavy_tiring') {
      session.rpe_flag_note = null
      document.getElementById('rpeFlagNoteInput').value = ''
      update.rpe_flag_note = null
    }
    session.rpe_flag_reviewed_at = null

    if (session.id.startsWith('local-')) return
    const { error } = await saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .update(update)
      .eq('id', session.id)
      .abortSignal(signal)
    )
    if (error) {
      console.log(error)
      customAlert('Something went wrong saving that: ' + describeError(error))
    }
  })

  noteSaveBtn?.addEventListener('click', async function() {
    await saveRpeFlagNote(session, document.getElementById('rpeFlagNoteInput').value)
  })
}

// Shared by the explicit "Save note" button and the summaryDoneBtn
// safety-net flush (renderWorkoutSummary) - also resets
// rpe_flag_reviewed_at, since an edited note needs the coach to see it again
async function saveRpeFlagNote(session, note) {
  session.rpe_flag_note = note
  session.rpe_flag_reviewed_at = null

  if (!session.id.startsWith('local-')) {
    const { error } = await saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .update({ rpe_flag_note: note, rpe_flag_reviewed_at: null })
      .eq('id', session.id)
      .abortSignal(signal)
    )
    if (error) {
      console.log(error)
      customAlert('Something went wrong saving your note: ' + describeError(error))
      return
    }
  }

  const saved = document.getElementById('rpeFlagNoteSaved')
  if (saved) {
    saved.style.display = 'inline'
    setTimeout(() => { saved.style.display = 'none' }, 2000)
  }
}

// A correction, not part of the tap-to-log flow - reveals a plain minutes
// input rather than editing the raw timestamps directly, since athletes
// think in "it took about 50 minutes," not clock times
function wireSummaryDurationEdit(session, entry) {
  const editBtn = document.getElementById('durationEditBtn')
  const editRow = document.getElementById('durationEditRow')
  const input = document.getElementById('durationEditInput')
  const saveBtn = document.getElementById('durationSaveBtn')
  const cancelBtn = document.getElementById('durationCancelBtn')
  if (!editBtn) return

  editBtn.addEventListener('click', function() {
    editBtn.style.display = 'none'
    editRow.style.display = 'flex'
    input.focus()
  })

  cancelBtn.addEventListener('click', function() {
    editRow.style.display = 'none'
    editBtn.style.display = ''
  })

  saveBtn.addEventListener('click', async function() {
    const minutes = parseInt(input.value)
    if (isNaN(minutes) || minutes < 1) { customAlert('Enter a duration of at least 1 minute'); return }

    // This session was never actually created in the database (see the
    // local- placeholder in findOrCreateSession) - just update it locally
    // and re-render, since there's no row to save the correction to
    if (session.id.startsWith('local-')) {
      renderWorkoutSummary({ ...session, ended_at: new Date(new Date(session.started_at).getTime() + minutes * 60000).toISOString() }, entry)
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = 'Saving...'

    const newEndedAt = new Date(new Date(session.started_at).getTime() + minutes * 60000).toISOString()
    const { data, error } = await saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .update({ ended_at: newEndedAt })
      .eq('id', session.id)
      .select()
      .single()
      .abortSignal(signal)
    )

    if (error) {
      console.log(error)
      customAlert('Something went wrong saving the corrected duration: ' + describeError(error))
      saveBtn.disabled = false
      saveBtn.textContent = 'Save'
      return
    }

    // Re-render from scratch - recomputes the duration text/warning and
    // re-runs PR detection against the (now differently-dated) session
    renderWorkoutSummary(data, entry)
  })
}

// ==========================================================================
// ---- PR DETECTION ----
// Compares this session against every OTHER session ever logged for the
// same underlying exercise (matched by exercise_id, so history carries
// across different programs/weeks a coach has assigned it in - not just
// program_exercise_id, which is a new row every time it's reprogrammed).
// ==========================================================================

// Epley formula - the standard estimated-1RM most lifting apps use, since
// it fairly compares a heavy low-rep set against a lighter high-rep set,
// which comparing raw heaviest weight alone can't do
function estimatedOneRM(weight, reps) {
  return weight * (1 + reps / 30)
}

// One session's aggregate stats for one exercise, from its completed sets
function sessionExerciseStats(sets) {
  let volume = 0, totalReps = 0, maxWeight = 0, maxOneRM = 0
  for (const s of sets) {
    const reps = parseInt(s.actual_reps)
    const hasReps = !isNaN(reps)
    if (hasReps) totalReps += reps
    if (s.actual_weight != null) {
      if (s.actual_weight > maxWeight) maxWeight = s.actual_weight
      if (hasReps) {
        volume += reps * s.actual_weight
        const oneRM = estimatedOneRM(s.actual_weight, reps)
        if (oneRM > maxOneRM) maxOneRM = oneRM
      }
    }
  }
  return { volume, totalReps, maxWeight, maxOneRM, setCount: sets.length }
}

async function loadAndRenderPRBadges(session, entry) {
  const exerciseIds = [...new Set(entry.day.program_exercises.map(pe => pe.exercise_id))]
  if (exerciseIds.length === 0) return

  // Every program_exercises row (across every program/week this athlete has
  // ever had) that's ever pointed at one of today's exercises - RLS already
  // scopes this to the athlete's own programs
  const { data: pastPEs, error: peError } = await fetchWithRetry((signal) => supabase
    .from('program_exercises')
    .select('id, exercise_id')
    .in('exercise_id', exerciseIds)
    .abortSignal(signal)
  )
  if (peError) { console.log(peError); return }

  const exerciseIdByPEId = {}
  for (const pe of pastPEs) exerciseIdByPEId[pe.id] = pe.exercise_id
  const allPEIds = pastPEs.map(pe => pe.id)
  if (allPEIds.length === 0) return

  const { data: pastSets, error: setsError } = await fetchWithRetry((signal) => supabase
    .from('exercise_log_sets')
    .select('*')
    .in('program_exercise_id', allPEIds)
    .not('completed_at', 'is', null)
    .abortSignal(signal)
  )
  if (setsError) { console.log(setsError); return }

  // One bucket per (exercise_id, date) - a proxy for "one session", the
  // same date-based grouping this app already uses elsewhere (there's no
  // workout_sessions link on exercise_log_sets to group by directly)
  const buckets = {}
  for (const s of pastSets) {
    const exerciseId = exerciseIdByPEId[s.program_exercise_id]
    const key = `${exerciseId}|${s.date}`
    if (!buckets[key]) buckets[key] = []
    buckets[key].push(s)
  }

  const todayStr = session.local_date

  for (const pe of entry.day.program_exercises) {
    const todayKey = `${pe.exercise_id}|${todayStr}`
    const todaySets = buckets[todayKey] || []
    if (todaySets.length === 0) continue
    const todayStats = sessionExerciseStats(todaySets)

    let bestVolume = 0, bestReps = 0, bestWeight = 0, bestOneRM = 0, bestSets = 0
    let hasHistory = false
    for (const key in buckets) {
      if (key === todayKey || !key.startsWith(pe.exercise_id + '|')) continue
      hasHistory = true
      const stats = sessionExerciseStats(buckets[key])
      bestVolume = Math.max(bestVolume, stats.volume)
      bestReps = Math.max(bestReps, stats.totalReps)
      bestWeight = Math.max(bestWeight, stats.maxWeight)
      bestOneRM = Math.max(bestOneRM, stats.maxOneRM)
      bestSets = Math.max(bestSets, stats.setCount)
    }
    // Nothing to beat yet - a first-time exercise isn't a PR
    if (!hasHistory) continue

    // before/after/isWeight let the badge show the actual numbers, not just
    // that a PR happened - same shape + formatPRBadgeValue() the Weekly
    // Stats view's own PR list already uses (see computeWeekPREvents)
    const badges = []
    if (todayStats.volume > bestVolume) badges.push({ type: 'volume', label: 'Volume PR', before: bestVolume, after: todayStats.volume, isWeight: true })
    if (todayStats.maxWeight > bestWeight) badges.push({ type: 'weight', label: 'Weight PR', before: bestWeight, after: todayStats.maxWeight, isWeight: true })
    if (todayStats.totalReps > bestReps) badges.push({ type: 'reps', label: 'Reps PR', before: bestReps, after: todayStats.totalReps, isWeight: false })
    if (todayStats.setCount > bestSets) badges.push({ type: 'sets', label: 'Sets PR', before: bestSets, after: todayStats.setCount, isWeight: false })
    if (todayStats.maxOneRM > bestOneRM) badges.push({ type: 'onerm', label: 'Est. 1RM PR', before: bestOneRM, after: todayStats.maxOneRM, isWeight: true })
    if (badges.length === 0) continue

    const container = document.getElementById(`prBadges-${pe.id}`)
    if (container) container.innerHTML = badges.map(b => `
      <span class="pr-badge pr-badge-${b.type}">🏆 ${b.label}: ${formatPRBadgeValue(b.before, b.isWeight)} → ${formatPRBadgeValue(b.after, b.isWeight)}</span>
    `).join('')
  }
}

// Same bucket-by-(exercise_id, date) + beat-your-own-best comparison as
// loadAndRenderPRBadges above, generalized from "today" to any 7-day
// window and run entirely off data already in entriesByDate/logSetsByPE
// (loadTrainingData's queries are unbounded) instead of a fresh network
// query - used by the Weekly Stats view (computeWeekRecap) to report which
// PRs, if any, were set during a picked past week
function computeWeekPREvents(weekStart) {
  const buckets = {}
  for (const dateStr in entriesByDate) {
    for (const entry of entriesByDate[dateStr]) {
      for (const pe of entry.day.program_exercises) {
        const sets = (logSetsByPE[pe.id] || []).filter(s => s.completed_at)
        if (sets.length === 0) continue
        const key = `${pe.exercise_id}|${dateStr}`
        if (!buckets[key]) buckets[key] = { exerciseId: pe.exercise_id, exerciseName: pe.exercises ? pe.exercises.name : 'Exercise', date: dateStr, sets: [] }
        buckets[key].sets.push(...sets)
      }
    }
  }

  const weekDateStrs = new Set()
  for (let i = 0; i < 7; i++) weekDateStrs.add(toDateStr(addDays(weekStart, i)))

  const events = []
  for (const key in buckets) {
    const bucket = buckets[key]
    if (!weekDateStrs.has(bucket.date)) continue
    const stats = sessionExerciseStats(bucket.sets)

    let bestVolume = 0, bestReps = 0, bestWeight = 0, bestOneRM = 0, bestSets = 0, hasHistory = false
    for (const otherKey in buckets) {
      if (otherKey === key || !otherKey.startsWith(bucket.exerciseId + '|')) continue
      hasHistory = true
      const otherStats = sessionExerciseStats(buckets[otherKey].sets)
      bestVolume = Math.max(bestVolume, otherStats.volume)
      bestReps = Math.max(bestReps, otherStats.totalReps)
      bestWeight = Math.max(bestWeight, otherStats.maxWeight)
      bestOneRM = Math.max(bestOneRM, otherStats.maxOneRM)
      bestSets = Math.max(bestSets, otherStats.setCount)
    }
    if (!hasHistory) continue

    const badges = []
    if (stats.volume > bestVolume) badges.push({ label: 'Volume PR', before: bestVolume, after: stats.volume, isWeight: true })
    if (stats.maxWeight > bestWeight) badges.push({ label: 'Weight PR', before: bestWeight, after: stats.maxWeight, isWeight: true })
    if (stats.totalReps > bestReps) badges.push({ label: 'Reps PR', before: bestReps, after: stats.totalReps, isWeight: false })
    if (stats.setCount > bestSets) badges.push({ label: 'Sets PR', before: bestSets, after: stats.setCount, isWeight: false })
    if (stats.maxOneRM > bestOneRM) badges.push({ label: 'Est. 1RM PR', before: bestOneRM, after: stats.maxOneRM, isWeight: true })
    if (badges.length === 0) continue

    events.push({ exerciseName: bucket.exerciseName, date: bucket.date, badges })
  }
  return events.sort((a, b) => a.date.localeCompare(b.date))
}

// ==========================================================================
// ---- SET LOGGING ----
// Unchanged from the per-set logging built earlier - now dropped into the
// single active-exercise card above instead of an all-exercises list.
// ==========================================================================
function renderSetRow(pe, setNumber, logged, isTimed, tracksWeight, isExtra, exerciseLabel) {
  const checked = !!(logged && logged.completed_at)
  // A not-yet-checked set's draft (see draftSetValues above) wins over the
  // coach's target/previously-logged value - it's whatever the athlete
  // most recently typed, which is more current than either of those. A
  // checked set ignores it entirely - completed_at means the real saved
  // row is now the source of truth, and its inputs are disabled anyway.
  const draft = !checked ? draftSetValues[`${pe.id}-${setNumber}`] : null
  // Each set can have its own coach-set target now (a pyramid) - fall back
  // to the old shared prescribed_reps/prescribed_weight for sets beyond
  // what the coach targeted (an athlete-added extra set) or for
  // pre-pyramid data that has no set_targets at all
  const target = pe.set_targets && pe.set_targets[setNumber - 1]
  // draft.<field> is undefined when that field was never typed into (fall
  // through to logged/target as before) but explicitly null/'' once typed
  // then fully cleared - !== undefined (not != null) is what keeps a
  // deliberately-cleared field from reverting to the prescribed value
  const repsVal = draft && draft.reps !== undefined ? draft.reps : (logged ? (logged.actual_reps || '') : ((target ? target.reps : pe.prescribed_reps) || ''))
  // Each row starts out in the athlete's default unit (data-unit), but can
  // be flipped per-row with the unit toggle button below - actual_weight is
  // always stored in kg regardless of which unit was used to type it in.
  // The draft is cached in kg too (see wireExerciseCardEvents' input
  // listener), for the same reason - so it re-displays correctly in
  // whichever unit is currently active, not whichever unit happened to be
  // showing at the moment it was typed.
  const unit = athlete.weight_unit || 'kg'
  const loggedWeightKg = logged ? logged.actual_weight : (target ? target.weight : pe.prescribed_weight)
  const weightKg = draft && draft.weight !== undefined ? draft.weight : loggedWeightKg
  const weightVal = weightKg != null ? formatWeight(weightKg, unit) : ''
  // Only flag warmup/failure sets - a plain "Main Set" on every row would
  // just be noise, since that's the default for most sets in a workout
  const setType = target && target.type && target.type !== 'main' ? target.type : null
  const typeLabel = setType === 'warmup' ? 'Warmup' : setType === 'failure' ? 'Failure' : ''
  const isUnilateral = pe.exercises && pe.exercises.is_unilateral
  const repsPlaceholder = 'reps' + (isUnilateral ? ' each side' : '')
  const { mm, ss } = parseTimeToParts(repsVal)
  const tracksDistance = pe.exercises && pe.exercises.tracks_distance
  const distanceVal = draft && draft.distance !== undefined ? draft.distance : (logged ? (logged.actual_distance != null ? logged.actual_distance : '') : ((target && target.distance != null) ? target.distance : ''))

  return `
    <div class="set-row ${checked ? 'completed' : ''}" data-set-number="${setNumber}" data-unit="${unit}" data-pe-id="${pe.id}">
      <span class="set-label">${exerciseLabel ? `<span class="set-row-exercise-label">${exerciseLabel}</span>` : ''}Set ${setNumber}${typeLabel ? `<span class="set-type-badge set-type-${setType}">${typeLabel}</span>` : ''}${isUnilateral ? '<span class="set-type-badge set-type-unilateral">Each Side</span>' : ''}</span>
      ${isTimed ? `
        <div class="set-time-input">
          <input type="text" inputmode="numeric" class="set-time-mm" value="${String(mm).padStart(2, '0')}" maxlength="2" ${checked ? 'disabled' : ''}>
          <span class="set-time-sep">:</span>
          <input type="text" inputmode="numeric" class="set-time-ss" value="${String(ss).padStart(2, '0')}" maxlength="2" ${checked ? 'disabled' : ''}>
        </div>
      ` : `<input type="text" inputmode="numeric" class="set-reps-input" value="${repsVal}" placeholder="${repsPlaceholder}" ${checked ? 'disabled' : ''}>`}
      ${tracksWeight ? `
        <input type="number" inputmode="decimal" class="set-weight-input" value="${weightVal}" placeholder="${unit}" step="0.5" ${checked ? 'disabled' : ''}>
        <button type="button" class="set-unit-toggle" data-action="toggle-unit" title="Switch to ${unit === 'kg' ? 'lbs' : 'kg'}" ${checked ? 'disabled' : ''}>${unit}</button>
      ` : ''}
      ${tracksDistance ? `<input type="number" inputmode="numeric" class="set-distance-input" value="${distanceVal}" placeholder="meters" step="1" ${checked ? 'disabled' : ''}>` : ''}
      <button type="button" class="set-check-btn ${checked ? 'checked' : ''}" data-action="check-set" title="${checked ? 'Undo' : 'Mark done'}">${checked ? '✓' : ''}</button>
      ${isExtra && !checked ? '<button type="button" class="set-remove-btn" data-action="remove-set" title="Remove set">✕</button>' : ''}
    </div>
  `
}

// Flips one row's kg/lbs display without changing the weight it represents
// - converts the number currently typed in so switching units relabels it
// instead of silently reinterpreting it (100kg staying "100" after a
// switch would quietly turn it into 100lbs, which is wrong)
function toggleRowUnit(rowEl) {
  const weightInput = rowEl.querySelector('.set-weight-input')
  const unitBtn = rowEl.querySelector('.set-unit-toggle')
  if (!weightInput || !unitBtn) return

  const currentUnit = rowEl.dataset.unit || 'kg'
  const nextUnit = currentUnit === 'kg' ? 'lbs' : 'kg'
  const typed = parseFloat(weightInput.value)
  if (!isNaN(typed)) {
    const kgVal = weightToKg(typed, currentUnit)
    weightInput.value = formatWeight(kgVal, nextUnit)
  }

  rowEl.dataset.unit = nextUnit
  weightInput.placeholder = nextUnit
  unitBtn.textContent = nextUnit
  unitBtn.title = `Switch to ${nextUnit === 'kg' ? 'lbs' : 'kg'}`

  // Tapping the toggle button (not the input itself) steals focus, which
  // is what was dismissing the on-screen keyboard - refocusing the
  // weight input right after brings it straight back up instead of
  // leaving the athlete to tap back into the field themselves
  weightInput.focus()
}

// onExerciseEmptied(peId): called when a remove-set tap leaves an exercise
// with zero set rows left - only reachable for a self-logged exercise
// (prescribed_sets is null there, so even its first/only row carries a
// remove button; a coach-assigned exercise always keeps at least
// prescribed_sets rows, whose remove buttons never show in the first
// place - see renderSingleSlideBody's isExtra check)
function wireExerciseCardEvents(containerId, dateStr, onExerciseEmptied) {
  document.getElementById(containerId).addEventListener('click', async function(e) {
    const thumbBtn = e.target.closest('.active-exercise-thumb')
    if (thumbBtn && thumbBtn.dataset.videoUrl) {
      playInlineVideo(thumbBtn, thumbBtn.dataset.videoUrl)
      return
    }

    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const row = btn.closest('.set-row')
    // add-set buttons carry their own data-pe-id (there can be two on a
    // superset slide, one per exercise); check/uncheck/remove-set read it
    // off the row they're inside instead
    const peId = btn.dataset.peId || (row && row.dataset.peId)

    if (btn.dataset.action === 'add-set') {
      addSetRow(peId)
    } else if (btn.dataset.action === 'toggle-unit') {
      toggleRowUnit(row)
    } else if (btn.dataset.action === 'check-set') {
      const setNumber = parseInt(row.dataset.setNumber)
      if (row.classList.contains('completed')) {
        await uncheckSet(peId, setNumber, dateStr, row)
      } else {
        await checkSet(peId, setNumber, dateStr, row)
      }
    } else if (btn.dataset.action === 'remove-set') {
      delete draftSetValues[`${peId}-${row.dataset.setNumber}`]
      row.remove()
      if (onExerciseEmptied) {
        const remaining = document.getElementById(containerId).querySelectorAll(`.set-row[data-pe-id="${peId}"]`).length
        if (remaining === 0) onExerciseEmptied(peId)
      }
    }
  })

  // mm:ss time boxes: strip anything non-digit as it's typed, then pad back
  // to 2 digits (and clamp seconds to 59) once the athlete taps away - kept
  // as two small text inputs rather than type="number" so the "00" padding
  // actually stays visible instead of browsers stripping the leading zero
  const container = document.getElementById(containerId)
  // Selects the "00" the moment a box is tapped, so typing a digit replaces
  // it immediately instead of needing a manual delete first - focusin
  // (not focus) since this is delegated from the container, and plain
  // focus doesn't bubble
  container.addEventListener('focusin', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      e.target.select()
    }
  })
  container.addEventListener('input', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 2)
    }
  })
  container.addEventListener('focusout', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      const max = e.target.classList.contains('set-time-ss') ? 59 : 99
      const val = Math.min(parseInt(e.target.value) || 0, max)
      e.target.value = String(val).padStart(2, '0')
    }
  })

  // Saves every keystroke into draftSetValues (see its declaration) so a
  // typed-but-not-yet-checked value survives the next re-render instead of
  // silently reverting to the coach's target - see renderSetRow, which
  // reads from this cache first.
  container.addEventListener('input', function(e) {
    const row = e.target.closest('.set-row')
    if (!row) return
    const key = `${row.dataset.peId}-${row.dataset.setNumber}`
    if (!draftSetValues[key]) draftSetValues[key] = {}

    if (e.target.matches('.set-reps-input')) {
      draftSetValues[key].reps = e.target.value
    } else if (e.target.matches('.set-time-mm, .set-time-ss')) {
      const mmVal = row.querySelector('.set-time-mm').value
      const ssVal = row.querySelector('.set-time-ss').value
      draftSetValues[key].reps = (mmVal === '' && ssVal === '') ? '' : `${mmVal}:${ssVal}`
    } else if (e.target.matches('.set-weight-input')) {
      // Cached in kg (not whatever unit the row happens to be showing
      // right now) so it re-displays correctly if the athlete's default
      // unit changes later - same reasoning as actual_weight itself
      const rowUnit = row.dataset.unit || 'kg'
      draftSetValues[key].weight = e.target.value === '' ? null : weightToKg(parseFloat(e.target.value), rowUnit)
    } else if (e.target.matches('.set-distance-input')) {
      draftSetValues[key].distance = e.target.value
    }
  })
}

function addSetRow(peId) {
  const pe = findPE(peId)
  if (!pe) return
  const rowsContainer = document.getElementById('activeExerciseCard').querySelector('.set-rows')
  // "+ Add Set" isn't offered inside a group step (see renderGroupStep),
  // so this container only ever holds one exercise's own rows now - no
  // exerciseLabel/scoping-within-a-shared-container needed any more
  const ownRows = [...rowsContainer.querySelectorAll(`.set-row[data-pe-id="${peId}"]`)]
  const nextNumber = ownRows.length + 1
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const html = renderSetRow(pe, nextNumber, null, isTimed, tracksWeight, true)
  const lastOwnRow = ownRows[ownRows.length - 1]
  if (lastOwnRow) lastOwnRow.insertAdjacentHTML('afterend', html)
  else rowsContainer.insertAdjacentHTML('beforeend', html)
}

// Optimistic UI: the row flips to "checked" instantly, and logSetsByPE
// (the state every render reads from) is updated right away too - not just
// the DOM. Without that second part, swiping to another exercise before a
// slow save finished and then swiping back would re-render this row from
// stale data and show it as unchecked again, even though the tap "worked".
//
// A failed save never reverts what you tapped. It's also durable: every
// check/uncheck is written to a small localStorage queue *before* the
// network call even starts, so if the connection is bad enough that
// saveWithRetry (a few attempts with backoff and a per-attempt timeout)
// exhausts all its attempts - or the tab gets backgrounded/killed by the
// phone mid-retry, which a purely in-memory retry can't survive - the
// pending change is still sitting in the queue. It gets flushed again on
// the next page load and whenever the tab becomes visible again (see
// flushPendingQueue). Only once every attempt (live + later retries) has
// failed does the row get flagged "unsynced", and even then it stays as
// tapped rather than reverting.
// Upsert on (program_exercise_id, date, set_number) - re-checking an
// already-logged set updates it instead of creating a duplicate row.
async function checkSet(peId, setNumber, dateStr, rowEl) {
  const pe = findPE(peId)
  const isTimed = pe.exercises && pe.exercises.is_timed
  const repsInput = rowEl.querySelector('.set-reps-input')
  const mmInput = rowEl.querySelector('.set-time-mm')
  const ssInput = rowEl.querySelector('.set-time-ss')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const distanceInput = rowEl.querySelector('.set-distance-input')
  let actualReps
  if (isTimed) {
    const mm = parseInt(mmInput.value) || 0
    const ss = parseInt(ssInput.value) || 0
    actualReps = (mm === 0 && ss === 0) ? null : `${mm}:${String(ss).padStart(2, '0')}`
  } else {
    actualReps = repsInput.value.trim() || null
  }
  // Convert whatever unit this row is currently showing back to kg - that's
  // the only thing that ever gets saved
  const rowUnit = rowEl.dataset.unit || 'kg'
  const actualWeight = weightInput ? (weightInput.value ? weightToKg(parseFloat(weightInput.value), rowUnit) : null) : null
  const actualDistance = distanceInput ? (distanceInput.value ? parseFloat(distanceInput.value) : null) : null
  const removedBtn = rowEl.querySelector('.set-remove-btn')

  // This set is now actually saved - the draft (if any) has served its
  // purpose and would otherwise linger and shadow the real logged value on
  // a future re-render
  delete draftSetValues[`${peId}-${setNumber}`]

  rowEl.classList.add('completed')
  rowEl.classList.remove('unsynced')
  if (isTimed) { mmInput.disabled = true; ssInput.disabled = true } else { repsInput.disabled = true }
  if (weightInput) weightInput.disabled = true
  if (distanceInput) distanceInput.disabled = true
  const checkBtn = rowEl.querySelector('.set-check-btn')
  checkBtn.textContent = '✓'
  checkBtn.classList.add('checked')
  checkBtn.title = 'Undo'
  if (removedBtn) removedBtn.remove()
  // Short haptic tap so checking a set is felt, not just seen - much
  // shorter than the rest timer's own 300ms "time's up" buzz (see
  // playRestDoneSound) since this fires constantly through a workout and
  // should read as a light confirmation, not a full alert
  if (navigator.vibrate) navigator.vibrate(30)
  // Inside a group step-through, checking the set auto-advances (straight
  // to the next member, or a rest then the next round) instead of the
  // plain rest-timer-only behavior a normal single exercise gets
  if (currentSlideContext && currentSlideContext.type === 'group' && currentGroupNav) {
    const { entry, slides, index, sessionPromise, steps, stepIndex } = currentGroupNav
    goToNextGroupStep(entry, dateStr, slides, index, sessionPromise, steps, stepIndex)
  } else {
    maybeStartRestTimer(pe, rowEl)
  }

  const queueEntry = {
    program_exercise_id: peId,
    athlete_id: athlete.id,
    date: dateStr,
    set_number: setNumber,
    actual_reps: actualReps,
    actual_weight: actualWeight,
    actual_distance: actualDistance,
    weight_unit: actualWeight != null ? rowUnit : null,
    completed_at: new Date().toISOString(),
    deleted: false
  }

  if (!logSetsByPE[peId]) logSetsByPE[peId] = []
  logSetsByPE[peId] = logSetsByPE[peId].filter(s => s.set_number !== setNumber)
  logSetsByPE[peId].push(queueEntry)

  queueUpsert(queueEntry)
  scheduleFlush()
}

// Same reasoning as checkSet - unchecks immediately, queues + schedules the
// delete, and only flags "unsynced" (staying visually unchecked) if every
// attempt fails, rather than silently snapping back to checked. Never
// auto-advances (only checking does) - but if unchecking the set that just
// started a rest countdown (or a group's between-round rest), that timer
// no longer makes sense, so it's cleared rather than left counting down
// toward an advance the athlete just undid.
function uncheckSet(peId, setNumber, dateStr, rowEl) {
  const pe = findPE(peId)
  const isTimed = pe.exercises && pe.exercises.is_timed
  const repsInput = rowEl.querySelector('.set-reps-input')
  const mmInput = rowEl.querySelector('.set-time-mm')
  const ssInput = rowEl.querySelector('.set-time-ss')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const distanceInput = rowEl.querySelector('.set-distance-input')
  const checkBtn = rowEl.querySelector('.set-check-btn')
  const isExtra = setNumber > (pe.prescribed_sets || 0)

  clearRestTimer()
  rowEl.classList.remove('completed', 'unsynced')
  if (isTimed) { mmInput.disabled = false; ssInput.disabled = false } else { repsInput.disabled = false }
  if (weightInput) weightInput.disabled = false
  if (distanceInput) distanceInput.disabled = false
  checkBtn.textContent = ''
  checkBtn.classList.remove('checked')
  checkBtn.title = 'Mark done'
  if (isExtra && !rowEl.querySelector('.set-remove-btn')) {
    rowEl.insertAdjacentHTML('beforeend', '<button type="button" class="set-remove-btn" data-action="remove-set" title="Remove set">✕</button>')
  }
  logSetsByPE[peId] = (logSetsByPE[peId] || []).filter(s => s.set_number !== setNumber)

  const queueEntry = { program_exercise_id: peId, date: dateStr, set_number: setNumber, deleted: true }
  queueUpsert(queueEntry)
  scheduleFlush()
}

// ==========================================================================
// ---- PENDING SAVE QUEUE ----
// A tiny durable outbox in localStorage, keyed by (program_exercise_id,
// date, set_number) so only the latest action for a given set is ever
// queued. checkSet/uncheckSet write here before attempting to save, so the
// change survives even if the tab is killed mid-retry - flushPendingQueue
// picks up anything still sitting here on the next load or tab-foreground.
// ==========================================================================
function loadPendingQueue() {
  try {
    return JSON.parse(localStorage.getItem('tbflog-pending-sets') || '[]')
  } catch (e) {
    return []
  }
}

function savePendingQueueToStorage(queue) {
  try {
    localStorage.setItem('tbflog-pending-sets', JSON.stringify(queue))
  } catch (e) { /* storage full/unavailable - falls back to in-memory-only behavior for this session */ }
}

function queueKey(entry) {
  return `${entry.program_exercise_id}|${entry.date}|${entry.set_number}`
}

function queueUpsert(entry) {
  const queue = loadPendingQueue().filter(q => queueKey(q) !== queueKey(entry))
  queue.push(entry)
  savePendingQueueToStorage(queue)
}

function queueRemove(peId, dateStr, setNumber) {
  const target = queueKey({ program_exercise_id: peId, date: dateStr, set_number: setNumber })
  savePendingQueueToStorage(loadPendingQueue().filter(q => queueKey(q) !== target))
}

// Applies every still-pending queue entry onto logSetsByPE - called at the
// end of loadTrainingData() so a set that hasn't synced yet still shows as
// checked/unchecked after a fresh reload, instead of the server's
// (temporarily out of date) version winning
function applyPendingQueueLocally() {
  for (const entry of loadPendingQueue()) {
    if (entry.deleted) {
      logSetsByPE[entry.program_exercise_id] = (logSetsByPE[entry.program_exercise_id] || []).filter(s => s.set_number !== entry.set_number)
    } else {
      if (!logSetsByPE[entry.program_exercise_id]) logSetsByPE[entry.program_exercise_id] = []
      logSetsByPE[entry.program_exercise_id] = logSetsByPE[entry.program_exercise_id].filter(s => s.set_number !== entry.set_number)
      logSetsByPE[entry.program_exercise_id].push(entry)
    }
  }
}

// Checking/unchecking a set no longer saves it directly - it queues the
// change and calls scheduleFlush(), which debounces a run of taps into one
// flush cycle instead of firing on every tap. flushPendingQueue itself is
// also called directly (bypassing the debounce) from a few "catch up now"
// moments: page load, visibilitychange, the 20s interval below, the sync
// banner's Retry Now button, and finishWorkout. flushInFlight makes all of
// these safe to call at any time, even while another flush is already
// running - an overlapping call just queues one more run afterward instead
// of firing a second, competing request for the same rows. That overlap
// used to be exactly how two of these triggers could both fire an upsert
// for the same set at the same moment - the resulting Postgres row-lock
// contention is what caused the "canceling statement due to statement
// timeout" errors, not the RLS join chain (which resolves through primary-
// key lookups either way).
let flushTimer = null
let flushInFlight = false
let flushAgainNeeded = false
let firstQueuedAt = null

// Tapping a set schedules a flush ~1.5s later; each further tap within that
// window pushes it back out again, so a quick run of taps becomes one
// flush cycle - capped at 5s so a long flurry of taps still flushes
// promptly instead of being postponed indefinitely.
function scheduleFlush() {
  if (!firstQueuedAt) firstQueuedAt = Date.now()
  clearTimeout(flushTimer)
  const waitedTooLong = Date.now() - firstQueuedAt > 5000
  flushTimer = setTimeout(flushPendingQueue, waitedTooLong ? 0 : 1500)
}

// Entries are saved with a LIMITED amount of parallelism (3 at a time), not
// fully sequential and not fully parallel - the same cap added after a real
// past incident where firing every entry at once (plain Promise.all) on a
// weak gym connection made a 14-set backlog blow past the per-attempt
// timeout and abort together ("AbortError: Fetch is aborted"). The guard
// above is what changed here, not this part - each entry still saves with
// its own request via performQueuedSave, same as before.
async function flushPendingQueue() {
  if (flushInFlight) { flushAgainNeeded = true; return }
  flushInFlight = true
  clearTimeout(flushTimer)
  firstQueuedAt = null
  try {
    const entries = loadPendingQueue()
    if (entries.length === 0) return
    await runWithConcurrencyLimit(entries, 3, async function(entry) {
      const { data, error } = await performQueuedSave(entry)
      settleEntry(entry, !error, error, data && data[0])
    })
  } finally {
    flushInFlight = false
    if (flushAgainNeeded) {
      flushAgainNeeded = false
      scheduleFlush()
    }
  }
}

// Reconciles one queue entry's outcome with the pending queue and, if the
// athlete hasn't already swiped away from it, the row on screen.
function settleEntry(entry, success, error, savedRow) {
  const rowEl = findSetRowEl(entry.program_exercise_id, entry.set_number)
  if (success) {
    queueRemove(entry.program_exercise_id, entry.date, entry.set_number)
    if (rowEl) rowEl.classList.remove('unsynced')
    if (!entry.deleted) {
      logSetsByPE[entry.program_exercise_id] = (logSetsByPE[entry.program_exercise_id] || []).filter(s => s.set_number !== entry.set_number)
      logSetsByPE[entry.program_exercise_id].push(savedRow || entry)
    }
  } else {
    entry.lastError = describeError(error)
    queueUpsert(entry)
    if (rowEl) {
      rowEl.classList.add('unsynced')
      const checkBtn = rowEl.querySelector('.set-check-btn')
      if (checkBtn) checkBtn.title = 'Not synced yet - will keep retrying automatically'
    }
  }
}

function findSetRowEl(peId, setNumber) {
  return document.querySelector(`.set-row[data-pe-id="${peId}"][data-set-number="${setNumber}"]`)
}

// Runs fn over items with at most `limit` in flight at once.
async function runWithConcurrencyLimit(items, limit, fn) {
  const queue = [...items]
  const workerCount = Math.min(limit, queue.length)
  const workers = new Array(workerCount).fill(null).map(async function() {
    while (queue.length > 0) {
      const item = queue.shift()
      await fn(item)
    }
  })
  await Promise.all(workers)
}

// ==========================================================================
// ---- PENDING SESSION-END QUEUE ----
// Same durable-retry idea as the set-logging queue above, but much smaller:
// just session_id -> ended_at. finishWorkout no longer waits on this save
// at all (the summary screen is built entirely from data already in
// memory), so a slow/killed connection never blocks the athlete - this
// queue is what makes that safe, by making sure the "ended" timestamp
// eventually reaches the server even if the first attempt fails.
// ==========================================================================
function loadPendingSessionEnds() {
  try {
    return JSON.parse(localStorage.getItem('tbflog-pending-session-ends') || '[]')
  } catch (e) {
    return []
  }
}

function savePendingSessionEndsToStorage(queue) {
  try {
    localStorage.setItem('tbflog-pending-session-ends', JSON.stringify(queue))
  } catch (e) { /* storage full/unavailable - falls back to in-memory-only behavior for this session */ }
}

function queueSessionEnd(sessionId, endedAt) {
  const queue = loadPendingSessionEnds().filter(e => e.session_id !== sessionId)
  queue.push({ session_id: sessionId, ended_at: endedAt })
  savePendingSessionEndsToStorage(queue)
}

// Tries to save immediately; only falls into the durable queue if that
// attempt (already 3 tries via saveWithRetry) fails entirely - not awaited
// by finishWorkout, since nothing on screen needs this to finish
async function saveSessionEnd(sessionId, endedAt) {
  // This session was never actually created in the database (see the
  // local- placeholder in findOrCreateSession) - nothing to update, and
  // queueing it would just retry a doomed update against a fake id forever
  if (sessionId.startsWith('local-')) return

  const { error } = await saveWithRetry((signal) => supabase
    .from('workout_sessions')
    .update({ ended_at: endedAt })
    .eq('id', sessionId)
    .abortSignal(signal)
  )
  if (error) {
    console.log(error)
    queueSessionEnd(sessionId, endedAt)
  }
}

async function flushPendingSessionEnds() {
  const queue = loadPendingSessionEnds()
  await runWithConcurrencyLimit(queue, 3, async function(entry) {
    const { error } = await saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .update({ ended_at: entry.ended_at })
      .eq('id', entry.session_id)
      .abortSignal(signal)
    )
    if (!error) {
      savePendingSessionEndsToStorage(loadPendingSessionEnds().filter(e => e.session_id !== entry.session_id))
    }
  })
}

// Pulls a human-readable message out of whatever shape the failure came in
// as - a Supabase/PostgREST error object (.message), a thrown DOMException
// like AbortError (.message), or something unexpected (fall back to a raw
// dump so nothing is ever silently blank in the sync banner)
function describeError(error) {
  if (!error) return 'Unknown error'
  if (error.message) return error.message
  try { return JSON.stringify(error) } catch (e) { return String(error) }
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && athlete) {
    flushPendingQueue()
    flushPendingSessionEnds()
  }
  // Catches the rest timer up immediately on return instead of waiting up
  // to a second for the next setInterval tick - most noticeable right
  // after a rest finished entirely while backgrounded, where this is what
  // fires the "done" sound/callback the moment the athlete's back
  if (document.visibilityState === 'visible') tickRestTimer()
})

// Belt-and-suspenders on top of the visibilitychange retry above: iOS kills
// a backgrounded tab's in-flight network requests the moment the screen
// locks or the app switches away (confirmed - a set saved instantly with
// the screen kept on and Chrome in the foreground, but consistently aborted
// otherwise). The one retry on returning to the tab can itself land in a
// bad moment (e.g. wifi still reconnecting right after unlock) and then just
// sits there until the athlete notices the banner and taps Retry Now. This
// keeps quietly trying every 20s in the background instead, only while the
// tab is actually visible (no point racing a request that's guaranteed to
// be killed anyway).
setInterval(function() {
  if (document.visibilityState !== 'visible' || !athlete) return
  if (loadPendingQueue().length > 0) flushPendingQueue()
  if (loadPendingSessionEnds().length > 0) flushPendingSessionEnds()
}, 20000)

function performQueuedSave(entry) {
  if (entry.deleted) {
    return saveWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .delete()
      .eq('program_exercise_id', entry.program_exercise_id)
      .eq('date', entry.date)
      .eq('set_number', entry.set_number)
      .abortSignal(signal)
    )
  }
  return saveWithRetry((signal) => supabase
    .from('exercise_log_sets')
    .upsert([{
      program_exercise_id: entry.program_exercise_id,
      athlete_id: entry.athlete_id,
      date: entry.date,
      set_number: entry.set_number,
      actual_reps: entry.actual_reps,
      actual_weight: entry.actual_weight,
      actual_distance: entry.actual_distance,
      weight_unit: entry.weight_unit,
      completed_at: entry.completed_at
    }], { onConflict: 'program_exercise_id,date,set_number' })
    .select()
    .abortSignal(signal)
  )
}

// Retries a Supabase call a few times with backoff before giving up.
// Each attempt is capped with an AbortController timeout - fetch() has no
// timeout by default, so a stalled (not failed, just stuck) connection
// would otherwise hang on a single attempt indefinitely instead of ever
// reaching a retry. Normalizes a thrown/aborted attempt into the same
// {data, error} shape as a normal Supabase response so this never throws -
// safe to await from anywhere, including in a loop from flushPendingQueue.
async function saveWithRetry(operationFactory, maxAttempts = 3) {
  let result = { data: null, error: null }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    try {
      result = await operationFactory(controller.signal)
    } catch (err) {
      result = { data: null, error: err }
    } finally {
      clearTimeout(timeoutId)
    }
    if (!result.error) return result
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, attempt * 2000))
    }
  }
  return result
}

// ==========================================================================
// ---- REST TIMER ----
// Only fires between sets, not after the last one - if the row just checked
// is the last row in its exercise's list, there's nothing to rest before.
// Group (superset/section) rest timing is handled entirely by
// goToNextGroupStep instead - checkSet only ever calls this function for a
// normal single exercise (see checkSet's currentSlideContext branch).
// ==========================================================================
function maybeStartRestTimer(pe, rowEl) {
  const setNumber = parseInt(rowEl.dataset.setNumber)

  // Each set can have its own rest now (shorter after a warmup set than
  // after a top set) - fall back to the exercise's old shared rest_seconds
  // for a set beyond what the coach targeted, or for pre-pyramid data
  const target = pe.set_targets && pe.set_targets[setNumber - 1]
  const restSeconds = target && target.rest != null ? target.rest : pe.rest_seconds
  if (!restSeconds) return
  const rows = [...rowEl.parentElement.children]
  const isLastRow = rows[rows.length - 1] === rowEl
  if (isLastRow) return
  startRestTimer(restSeconds)
}

// onDone (optional) fires once, only when the countdown naturally reaches
// zero or Skip is tapped - both sites below capture it into a local `cb`
// before calling clearRestTimer(), so the plain clearRestTimer() cleanup
// call that already runs unconditionally at the top of
// renderActiveExercise/renderGroupGate/renderGroupStep/renderEndOfWorkoutSlide
// (navigating away for unrelated reasons) never fires it - only an actual
// finish-or-skip does. This is what lets a group step's rest pause
// auto-continue into the next round without also firing on every
// unrelated slide change.
let restTimerOnDone = null
// Wall-clock end time, not a tick counter - a backgrounded tab or a locked
// phone screen throttles or fully pauses setInterval, so a plain
// "remaining--" per tick just stalls instead of reflecting real elapsed
// time (the athlete comes back to the app and the timer looks frozen,
// still showing however much was left when it got backgrounded). Compared
// against a fixed end timestamp instead, the very next tick - even a late
// one, or the visibilitychange re-sync below - always recovers the true
// remaining time and finishes instantly if it's already elapsed, rather
// than continuing to count down slowly from a stale number.
let restTimerEndAt = null

function startRestTimer(totalSeconds, onDone) {
  clearRestTimer()
  restTimerOnDone = onDone || null
  const bar = document.getElementById('restTimerBar')
  if (!bar) return

  restTimerEndAt = Date.now() + totalSeconds * 1000
  bar.style.display = 'flex'
  bar.innerHTML = `
    <span class="rest-timer-label">Rest</span>
    <span class="rest-timer-time" id="restTimerTime">${formatTimer(totalSeconds)}</span>
    <button type="button" class="rest-timer-skip" id="restTimerSkipBtn">Skip</button>
  `
  document.getElementById('restTimerSkipBtn').addEventListener('click', function() {
    const cb = restTimerOnDone
    clearRestTimer()
    if (cb) cb()
  })

  restTimerInterval = setInterval(tickRestTimer, 1000)
  scheduleRestTimerPush(totalSeconds) // backup notification in case the athlete isn't looking when this ends - see the comment above these two functions, below
}

function tickRestTimer() {
  if (restTimerEndAt == null) return
  const remaining = Math.ceil((restTimerEndAt - Date.now()) / 1000)
  if (remaining <= 0) {
    playRestDoneSound()
    const cb = restTimerOnDone
    clearRestTimer()
    if (cb) cb()
    return
  }
  const timeEl = document.getElementById('restTimerTime')
  if (timeEl) timeEl.textContent = formatTimer(remaining)
}

function clearRestTimer() {
  if (restTimerInterval) clearInterval(restTimerInterval)
  restTimerInterval = null
  restTimerOnDone = null
  restTimerEndAt = null
  cancelRestTimerPush()
  const bar = document.getElementById('restTimerBar')
  if (bar) { bar.style.display = 'none'; bar.innerHTML = '' }
}

// ==========================================================================
// ---- REST TIMER PUSH NOTIFICATION (backup for when the athlete isn't
// looking at the app) ----
// The countdown above only works while this tab is actually running -
// playRestDoneSound() can't fire if the athlete has switched to another
// app (e.g. checking Instagram) and this tab got backgrounded/suspended.
// So every time a rest timer starts, a row is also written to
// scheduled_notifications for "now + rest length" - a separate process on
// Supabase's side (not this browser tab) checks that table every ~15
// seconds and sends a real push for anything due, completely independent
// of whether this tab is even still running. If clearRestTimer() runs
// before that push goes out (Skip pressed, the countdown finished
// naturally while the athlete WAS looking, or they navigated away), the
// row is deleted again so they don't get a redundant push for a rest
// period that's already over as far as they're concerned.
// ==========================================================================
// Bumped every time a timer starts or gets cleared - lets a still-in-flight
// insert recognize a newer/cleared timer has since taken over, so it can
// delete the row it just created instead of leaving a stray push scheduled
// for a rest period that's no longer active.
let restTimerNotifyToken = 0
let restTimerNotificationId = null

async function scheduleRestTimerPush(totalSeconds) {
  const token = ++restTimerNotifyToken
  restTimerNotificationId = null

  const fireAt = new Date(Date.now() + totalSeconds * 1000).toISOString()
  const { data, error } = await supabase
    .from('scheduled_notifications')
    .insert([{ user_id: session.user.id, fire_at: fireAt, title: 'Rest is over', body: 'Time to start your next set', url: window.location.href }])
    .select()
    .single()

  // Best-effort only - a failed insert just means no backup push goes out;
  // the in-app countdown and sound still work exactly as before
  if (error) { console.log(error); return }

  if (token !== restTimerNotifyToken) {
    // The timer this was for already ended/got cleared while this insert
    // was still in flight - this row is now stale, remove it
    supabase.from('scheduled_notifications').delete().eq('id', data.id)
    return
  }

  restTimerNotificationId = data.id
}

function cancelRestTimerPush() {
  restTimerNotifyToken++ // invalidates any insert from the timer just cleared, still in flight
  if (restTimerNotificationId) {
    supabase.from('scheduled_notifications').delete().eq('id', restTimerNotificationId) // not awaited - best effort, harmless even if it fails
    restTimerNotificationId = null
  }
}

function formatTimer(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// A short beep via the Web Audio API (an oscillator, no external asset)
// plus a vibration where supported - either can silently no-op, the timer
// still visually hit zero either way
function playRestDoneSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.2, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
    osc.start()
    osc.stop(ctx.currentTime + 0.4)
  } catch (e) { /* audio isn't essential, ignore if unsupported/blocked */ }

  if (navigator.vibrate) navigator.vibrate(300)
}

