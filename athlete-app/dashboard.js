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
// This file is the app's start-up: the session check, the bottom nav and
// route table, the account states, entering the Week view, and screen
// teardown. Everything else lives next to it:
//
//   state.js      values many files share (athlete, session, page elements,
//                 the in-progress workout bits)
//   data.js       loadTrainingData() and the data it fills in
//   format.js     dates, weight units, shared icons/descriptions
//   outbox.js     offline save queues + saveWithRetry
//   home-tour.js  first-time tour steps + the one-time set hint
//   screens/      home (week view), day preview, profile, chat, stats,
//                 tournaments, mobility, own workout, form fill-out,
//                 coach messages
//   workout/      the guided workout: active exercise, group step-through,
//                 swipe + summary, set logging, PRs, history/swap, rest timer
//
// A separate mini-app with its own Supabase client (see athleteClient.js).
// ==========================================================================
import { supabase } from './athleteClient.js?v=__V__'
import * as nav from './nav.js?v=__V__'
import { startOfWeek } from '../shared/dates.js?v=__V__'
import { pageContent, pageWrap, cardWrap, athlete, wk, setSession, setAthlete, setCoachMobilityEnabled, bumpWorkoutScreenSeq } from './state.js?v=__V__'
import { loadTrainingData } from './data.js?v=__V__'
import { runHomeTour } from './home-tour.js?v=__V__'
import { flushPendingQueue, flushPendingSessionEnds, saveWithRetry, startOutboxRetries } from './outbox.js?v=__V__'
import { refreshChatNavBadge, renderCommunication } from './screens/chat.js?v=__V__'
import { loadCoachMessages, maybeShowOnOpenMessages, maybeShowWeeklyRecap } from './screens/coach-messages.js?v=__V__'
import { renderDayPreview, wireLogWeightModal, wireMoveWorkoutModal } from './screens/day-preview.js?v=__V__'
import { renderFormFill } from './screens/form-fill.js?v=__V__'
import { currentWeekStart, renderWeekView } from './screens/home.js?v=__V__'
import { clearMobilityFlowTimer, clearMobilityTimer, renderMobilityAreaPicker, renderMobilityFlow, renderMobilityPicker, renderMobilityTimer } from './screens/mobility.js?v=__V__'
import { renderAddWorkoutChoice, renderAddWorkoutFieldForm, renderOwnWorkoutAddExercise, renderOwnWorkoutBuilder } from './screens/own-workout.js?v=__V__'
import { renderProfile } from './screens/profile.js?v=__V__'
import { renderWeeklyStats } from './screens/stats.js?v=__V__'
import { loadLatestBodyweight, loadTournaments, renderAddTournamentForm, renderTournaments } from './screens/tournaments.js?v=__V__'
import { renderActiveExercise } from './workout/active.js?v=__V__'
import { renderGroupGate, renderGroupStep } from './workout/group.js?v=__V__'
import { renderEndOfWorkoutSlide, wireExerciseHistoryModal, wireExerciseSwapModal } from './workout/history.js?v=__V__'
import { clearRestTimer } from './workout/rest-timer.js?v=__V__'
import { renderWorkoutSummary } from './workout/swipe.js?v=__V__'

const { data: { session } } = await supabase.auth.getSession()
setSession(session)
if (!session) {
  window.location.href = 'index.html'
}

// ==========================================================================
// ---- BOTTOM NAV ----
// Lives outside #pageContent (declared once in dashboard.html), so
// re-rendering pageContent for every screen never wipes it out - this is
// what makes it a persistent tab bar instead of per-screen chrome. Each tap
// first runs the current screen's leave guard (nav.confirmLeave), the same
// question a back gesture asks - only the mobility screens have one. Hidden
// entirely (see enterWeekView) until there's a real athlete to navigate
// for; every click here is guarded the same way the old header buttons
// were, as a safety net for the brief pre-load window.
// ==========================================================================
document.getElementById('navHomeBtn').addEventListener('click', async function() {
  if (athlete && await nav.confirmLeave()) renderWeekView(currentWeekStart || startOfWeek(new Date()))
})

// Also hidden entirely (see enterWeekView) unless the coach has
// can_view_weekly_stats on for this athlete
document.getElementById('navStatsBtn').addEventListener('click', async function() {
  if (athlete && await nav.confirmLeave()) renderWeeklyStats()
})

document.getElementById('navCommsBtn').addEventListener('click', async function() {
  if (athlete && await nav.confirmLeave()) renderCommunication()
})

document.getElementById('navProfileBtn').addEventListener('click', async function() {
  if (athlete && await nav.confirmLeave()) renderProfile()
})

// Tabs are sticky, not re-asserted by every screen: only the tab-root
// renderers below (renderWeekView/renderWeeklyStats/renderCommunication/
// renderProfile) call this.
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

// ==========================================================================
// ---- NAVIGATION HISTORY (shadow mode) ----
// Gives every screen a real history entry (see nav.js for why) without yet
// changing how anything gets THERE - every on-screen "<- Back" button and
// nav-bar tap still calls its target renderer directly, exactly as before.
// nav.enter() is called from the top of each of the 21 routable renderers
// below; ROUTES is what lets a popstate (today: a real browser's back
// button: eventually, Android hardware back / iOS edge-swipe once that's
// wired up in a later pass) replay the right one. Function declarations are
// hoisted, so referencing them here before their own definitions further
// down the file is fine - by the time nav.init() actually runs, they all
// already exist.
//
// The 4 pre-app states (wrong role / waiting to be linked / complete
// profile / intro) are deliberately NOT routed - they render before this
// point in the app's lifecycle is even reachable, and there's nothing
// meaningful for back to do on any of them yet.
//
// "workout" is one route name backed by 4 different renderers
// (renderActiveExercise/GroupGate/GroupStep/EndOfWorkoutSlide) - each is
// just a different way of showing "the guided workout, right now", so
// collapse:true at every one of their call sites keeps swiping through a
// whole workout to a single history entry. args.variant says which to
// replay.
const ROUTES = {
  home:             a => renderWeekView(a.weekStart),
  stats:            () => renderWeeklyStats(),
  chat:             () => renderCommunication(),
  profile:          () => renderProfile(),
  dayPreview:       a => renderDayPreview(a.dateStr),
  formFill:         a => renderFormFill(a.fa, a.dateStr),
  tournaments:      () => renderTournaments(),
  addTournament:    () => renderAddTournamentForm(),
  mobilityAreas:    () => renderMobilityAreaPicker(),
  mobilityPicker:   a => renderMobilityPicker(a.selectedAreas),
  mobilityTimer:    a => renderMobilityTimer(a.totalSeconds),
  mobilityFlow:     a => renderMobilityFlow(a.queue, a.totalSeconds, a.selectedAreas),
  addWorkoutChoice: () => renderAddWorkoutChoice(),
  addWorkoutField:  a => renderAddWorkoutFieldForm(a.type),
  ownBuilder:       a => renderOwnWorkoutBuilder(a.entry, a.dateStr, a.sessionPromise),
  ownAddExercise:   a => renderOwnWorkoutAddExercise(a.entry, a.dateStr, a.sessionPromise, a.returnIndex),
  workout: a => {
    if (a.variant === 'groupGate') renderGroupGate(a.entry, a.dateStr, a.slides, a.index, a.sessionPromise, a.direction)
    else if (a.variant === 'groupStep') renderGroupStep(a.entry, a.dateStr, a.slides, a.index, a.sessionPromise, a.steps, a.stepIndex, a.direction)
    else if (a.variant === 'endOfWorkout') renderEndOfWorkoutSlide(a.entry, a.dateStr, a.slides, a.sessionPromise, a.direction)
    else renderActiveExercise(a.entry, a.dateStr, a.slides, a.index, a.sessionPromise, a.direction)
  },
  workoutSummary: a => renderWorkoutSummary(a.session, a.entry),
}

nav.init(ROUTES, function(frame) { setActiveBottomTab(frame.tab) }, { beforeEnter: teardownScreen })

// Runs at the start of every screen, from nav.enter() (wired in nav.init
// above) - not called by hand, so no renderer can forget it. Previously
// each renderer called it itself and over half didn't, so e.g. tapping
// Profile mid-mobility-timer left the timer running. Before that, each one only cleared
// the rest timer, so leaving a mobility screen any way other than its own
// Cancel/Finish button (tapping Home, say) left its interval ticking against
// a torn-down DOM and silently dropped the session. Clearing all three
// unconditionally is safe: the two rest-timer completion paths capture
// restTimerOnDone into a local before calling clearRestTimer (see the comment
// above restTimerOnDone), so this never fires a group step's auto-advance.
//
// keepRest: the four workout-slide renderers (exercise, superset gate/step,
// end slide) pass it in their nav.enter opts so a rest timer started on one exercise keeps counting
// down as the athlete swipes to the next - the bar is redrawn on each new
// slide by restoreRestTimerBar() (called from mountSlide). Every other
// screen still clears it, so leaving the workout ends the rest.
function teardownScreen(opts) {
  if (opts && opts.keepRest) bumpWorkoutScreenSeq()
  else clearRestTimer()
  clearMobilityTimer()
  clearMobilityFlowTimer()
  if (wk.swipeCleanup) { wk.swipeCleanup(); wk.swipeCleanup = null }
}

document.getElementById('weeklyRecapCloseBtn').addEventListener('click', function() {
  document.getElementById('weeklyRecapModal').classList.remove('active')
  // Chained rather than both firing at app-entry independently - two
  // modal-overlays active at once would just overlap. Coach messages wait
  // for the recap to be dismissed first when both would otherwise show.
  maybeShowOnOpenMessages()
})

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
    .select('id, name, date_of_birth, gender, height, can_preview_next_week, weight_unit, weekly_recap_enabled, can_self_log_workouts, can_add_exercises, can_change_exercises, can_reschedule_workouts, can_view_weekly_stats, mobility_enabled, tournaments_enabled, coach_id, intro_seen, avatar_url')
    .eq('user_id', session.user.id)
    .maybeSingle()
    .abortSignal(signal)
  )

  if (foundAthlete) {
    setAthlete(foundAthlete)
    // needs_password is stamped into signup metadata by sendInviteEmail()
    // (coach-app/screens/athletes.js and athlete-detail/index.js) the moment the invite creates this
    // account, and cleared once they actually set one below - this is more
    // reliable than trying to sniff the invite-link redirect itself
    // (Supabase's exact redirect shape depends on internal auth flow
    // settings, which turned out not to match a hash-based `type=magiclink`
    // assumption in practice).
    if (session.user.user_metadata?.needs_password) { renderCompleteProfilePrompt(); return }
    await enterAppMaybeIntro()
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
  pageWrap.classList.add('centered')
  cardWrap.classList.add('centered')
  pageContent.innerHTML = `
    <h2>Wrong login</h2>
    <p>This is the athlete login, and this account isn't set up as an athlete. If you're a coach, use the main Tobe-Fit login instead.</p>
    <button class="btn-save" id="signOutBtn">Sign Out</button>
  `
  document.getElementById('signOutBtn').addEventListener('click', async function() {
    await supabase.auth.signOut()
    // Same role-cache clear as the other 2 sign-out sites below - see their
    // comment (and app/index.js's header) for why. Sent to the chooser
    // rather than back to the athlete login, since this screen exists
    // because the signed-in account ISN'T an athlete - reloading the
    // athlete login would just show the exact same message again.
    localStorage.removeItem('tbflog-known-role')
    window.location.href = '../app/index.html'
  })
}

function renderWaitingToBeLinked() {
  pageWrap.classList.add('centered')
  cardWrap.classList.add('centered')
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
// app to check email every time). Also doubles as a data-correction step:
// the coach may have typo'd the athlete's name/DOB/gender when creating
// the profile, so the athlete confirms/fixes those here rather than the
// coach having to get it right blind - whatever they submit overwrites the
// athletes row directly. No skip option: this is the one moment the
// athlete's own answer is authoritative, so it isn't optional.
function renderCompleteProfilePrompt() {
  pageWrap.classList.add('centered')
  cardWrap.classList.add('centered')
  pageContent.innerHTML = `
    <h2>Welcome, ${athlete.name}!</h2>
    <p>Let's finish setting up your account. Confirm your details below and set a password so you can log back in directly next time, without needing another email link.</p>
    <div class="form-group">
      <label>Full Name</label>
      <input type="text" id="onboardNameInput" value="${(athlete.name || '').replace(/"/g, '&quot;')}" />
    </div>
    <div class="form-group">
      <label>Date of Birth</label>
      <input type="date" id="onboardDOBInput" value="${athlete.date_of_birth || ''}" />
    </div>
    <div class="form-group">
      <label>Gender</label>
      <select id="onboardGenderInput">
        <option value="Male" ${athlete.gender === 'Male' ? 'selected' : ''}>Male</option>
        <option value="Female" ${athlete.gender === 'Female' ? 'selected' : ''}>Female</option>
        <option value="Other" ${athlete.gender === 'Other' ? 'selected' : ''}>Other</option>
      </select>
    </div>
    <div class="form-group">
      <label>Height (cm)</label>
      <input type="number" id="onboardHeightInput" placeholder="e.g. 180" value="${athlete.height || ''}" />
    </div>
    <div class="form-group">
      <label>New Password</label>
      <input type="password" id="newPasswordInput" placeholder="At least 6 characters" />
    </div>
    <button class="btn-save" id="saveProfileBtn">Save & Continue</button>
  `

  document.getElementById('saveProfileBtn').addEventListener('click', async function() {
    const name = document.getElementById('onboardNameInput').value.trim()
    const dob = document.getElementById('onboardDOBInput').value
    const gender = document.getElementById('onboardGenderInput').value
    const heightRaw = parseInt(document.getElementById('onboardHeightInput').value)
    const password = document.getElementById('newPasswordInput').value

    if (!name) { customAlert('Please enter your full name'); return }
    if (!dob) { customAlert('Please enter your date of birth'); return }
    if (Number.isNaN(heightRaw)) { customAlert('Please enter your height'); return }
    if (!password || password.length < 6) { customAlert('Please enter a password of at least 6 characters'); return }

    const { error: authError } = await supabase.auth.updateUser({
      password,
      data: { ...session.user.user_metadata, needs_password: false }
    })
    if (authError) {
      console.log(authError)
      customAlert('Something went wrong saving your password - please try again.')
      return
    }

    const { error: profileError } = await saveWithRetry((signal) => supabase
      .from('athletes')
      .update({ name, date_of_birth: dob, gender, height: heightRaw })
      .eq('id', athlete.id)
      .abortSignal(signal)
    )
    if (profileError) {
      console.log(profileError)
      customAlert('Password saved, but something went wrong saving your details - please try again.')
      return
    }

    athlete.name = name
    athlete.date_of_birth = dob
    athlete.gender = gender
    athlete.height = heightRaw
    enterAppMaybeIntro()
  })
}

// ==========================================================================
// ---- FIRST-TIME TOUR ----
// First-time tour. Shown once, right after an athlete finishes the
// profile/password step above (or the next time they open the app, for
// anyone whose intro_seen was reset), and on demand from Profile's
// "Replay" button. It runs on the real Home screen, highlighting one thing
// at a time (see tour.js), so athletes see where things are instead of
// reading about them. Steps for features this athlete doesn't have (no
// mobility, tournaments, stats, or own workouts) are skipped by tour.js
// because their element isn't on the page.
// ==========================================================================
async function enterAppMaybeIntro() {
  await enterWeekView({ tour: !athlete.intro_seen })
}

async function enterWeekView({ tour = false } = {}) {
  // Clears the display:none set inline in dashboard.html's markup, rather
  // than setting an inline 'flex' - an inline style always wins over a
  // stylesheet rule regardless of specificity, which permanently defeated
  // the body:has(.workout-active) .bottom-nav{display:none} CSS rule below
  // from this point on. Clearing it instead just lets that rule (and
  // .bottom-nav's own default display:flex) govern visibility normally.
  document.getElementById('bottomNav').style.display = ''
  document.getElementById('bottomNavBlur').style.display = ''
  document.getElementById('navStatsBtn').style.display = athlete.can_view_weekly_stats ? '' : 'none'
  const { data: coachProfile } = await saveWithRetry((signal) => supabase
    .from('profiles')
    .select('mobility_enabled')
    .eq('id', athlete.coach_id)
    .maybeSingle()
    .abortSignal(signal)
  )
  setCoachMobilityEnabled(coachProfile ? coachProfile.mobility_enabled !== false : true)
  await loadTrainingData()
  await loadTournaments()
  await loadLatestBodyweight()
  await loadCoachMessages()
  refreshChatNavBadge()
  setInterval(refreshChatNavBadge, 45000)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') refreshChatNavBadge()
  })
  renderWeekView(startOfWeek(new Date()))
  flushPendingQueue() // not awaited - picks up anything left over from a previous session
  flushPendingSessionEnds()
  // The tour goes first; the recap and coach messages wait until it's
  // closed, so only one overlay is ever on screen
  if (tour) await runHomeTour()
  // Only one modal-overlay should ever be active at once - if the recap
  // actually shows, its own close button chains into
  // maybeShowOnOpenMessages() afterward instead of this firing right away
  const recapShown = maybeShowWeeklyRecap()
  if (!recapShown) maybeShowOnOpenMessages()
}

// ==========================================================================
// ---- STATIC MODAL WIRING + QUEUE RETRIES ----
// Listeners on markup that's in dashboard.html from the start. These used
// to sit at the top level of this file, after checkAccountState() - run
// here, at the same point, so the order is unchanged.
// ==========================================================================
wireMoveWorkoutModal()
wireLogWeightModal()
wireExerciseHistoryModal()
wireExerciseSwapModal()
startOutboxRetries()
