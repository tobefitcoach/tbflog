// ==========================================================================
// ATHLETE APP - daily mobility / stretching
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { toDateStr, startOfWeek } from '../../shared/dates.js?v=__V__'
import { pageContent, athlete } from '../state.js?v=__V__'
import { loadTrainingData } from '../data.js?v=__V__'
import { CHEVRON_LEFT } from '../format.js?v=__V__'
import { insertOnce, saveWithRetry } from '../outbox.js?v=__V__'
import { currentWeekStart, renderWeekView } from './home.js?v=__V__'
import { formatTimer, playRestDoneSound } from '../workout/rest-timer.js?v=__V__'

let mobilityTimerInterval = null
let stretchLibraryCache = null              // stretches visible to this athlete (RLS-scoped to their coach)
let athleteStretchPreferencesCache = null   // Map<stretch_id, 'liked'|'disliked'>
let mobilityFlowInterval = null             // countdown for the guided flow screen, parallel to mobilityTimerInterval

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
export async function renderMobilityAreaPicker() {
  const myToken = nav.enter('mobilityAreas', {})
  pageContent.innerHTML = '<p>Loading...</p>'

  const [stretches] = await Promise.all([loadStretchLibrary(), loadAthleteStretchPreferences()])
  if (!nav.isCurrent(myToken)) return

  if (stretches.length === 0) {
    renderMobilityPicker([]) // nothing filmed yet - straight to the plain duration picker + blank timer
    return
  }

  const distinctAreas = [...new Set(stretches.flatMap(s => s.body_areas || []))].sort()
  const selectedAreas = new Set()

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="icon-btn" id="mobilityAreaBackBtn" aria-label="Back">${CHEVRON_LEFT}</button>
      <h2 class="day-view-date">Daily Mobility/Stretching</h2>
    </div>
    <p style="color:var(--c-text-muted); font-size:13px; margin-bottom:16px">What do you want to focus on today? Pick up to 2 - the rest of the session still flows across your whole body, these just show up more.</p>
    <div class="chip-row" id="mobilityAreaChips">
      ${distinctAreas.map(a => `<button type="button" class="chip-btn" data-area="${a}">${a}</button>`).join('')}
    </div>
    <button type="button" class="chip-btn chip-btn-clear" id="mobilityAreaNoPreference" style="margin-top:8px">Full Body / No preference</button>
    <button type="button" class="btn-save start-workout-btn" id="mobilityAreaNextBtn" style="margin-top:16px">Continue</button>
  `

  document.getElementById('mobilityAreaBackBtn').addEventListener('click', nav.back)

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

export function renderMobilityPicker(selectedAreas) {
  nav.enter('mobilityPicker', { selectedAreas })

  const presets = [10, 15, 20]
  const hasLibrary = stretchLibraryCache && stretchLibraryCache.length > 0

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="icon-btn" id="mobilityBackBtn" aria-label="Back">${CHEVRON_LEFT}</button>
      <h2 class="day-view-date">Daily Mobility/Stretching</h2>
    </div>
    <p style="color:var(--c-text-muted); font-size:13px; margin-bottom:16px">Pick how long you want to stretch or work on mobility.</p>
    <div class="duration-preset-row">
      ${presets.map(m => `<button type="button" class="duration-preset-btn" data-minutes="${m}">${m} min</button>`).join('')}
    </div>
    <div class="form-group" style="margin-top:16px">
      <label>Or a custom length (minutes)</label>
      <input type="number" id="mobilityCustomMinutes" min="1" placeholder="e.g. 12">
    </div>
    <button type="button" class="btn-save start-workout-btn" id="mobilityStartBtn" style="margin-top:16px">▶ Start</button>
  `

  // nav.back() reproduces the old hasLibrary branch for free: the actual
  // previous frame is 'mobilityAreas' when this screen was reached through
  // the area picker, or 'home' directly when the no-library path skipped
  // straight here (see the top of renderMobilityAreaPicker).
  document.getElementById('mobilityBackBtn').addEventListener('click', nav.back)

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

export function renderMobilityTimer(totalSeconds) {
  nav.enter('mobilityTimer', { totalSeconds }, {
    // Writes nothing until the session ends, so leaving any way (back
    // gesture, a bottom-nav tab) asks first and then ends it under the
    // same half-time rule as the End button
    guard: () => endTimerSession({ goHome: false })
  })
  const startedAt = new Date()
  let ended = false
  // Wall clock, not a counter: setInterval is throttled while the app is in
  // the background, so counting ticks undercounts a session left running
  const doneSeconds = () => Math.min(totalSeconds, Math.floor((Date.now() - startedAt.getTime()) / 1000))

  pageContent.innerHTML = `
    <div class="mobility-timer-screen">
      <p class="mobility-timer-label"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"></circle><path d="M12 6v6"></path><path d="M8 8l4 2 4-2"></path><path d="M9 20l3-6 3 6"></path></svg> Mobility / Stretching</p>
      <p class="mobility-timer-time" id="mobilityTimerTime">${formatTimer(totalSeconds)}</p>
      <button type="button" class="btn-save" id="mobilityEndBtn" style="margin-top:24px">End Session</button>
    </div>
  `

  mobilityTimerInterval = setInterval(function() {
    if (ended) return
    const done = doneSeconds()
    const timeEl = document.getElementById('mobilityTimerTime')
    if (timeEl) timeEl.textContent = formatTimer(totalSeconds - done)
    if (done >= totalSeconds) {
      ended = true
      clearMobilityTimer()
      playRestDoneSound()
      finishMobilitySession(startedAt, undefined, totalSeconds, totalSeconds)
    }
  }, 1000)

  async function endTimerSession({ goHome }) {
    if (ended) return true
    const done = doneSeconds()
    if (!(await customConfirm(mobilityEndPrompt(done, totalSeconds)))) return false
    if (ended) return true // the timer ran out while the question was open
    ended = true
    clearMobilityTimer()
    finishMobilitySession(startedAt, undefined, done, totalSeconds, { goHome, told: true })
    return true
  }

  document.getElementById('mobilityEndBtn').addEventListener('click', function() {
    endTimerSession({ goHome: true })
  })
}

export function clearMobilityTimer() {
  if (mobilityTimerInterval) clearInterval(mobilityTimerInterval)
  mobilityTimerInterval = null
}

// A mobility session ended early is only saved if at least half the
// planned time was done, and is saved as the time actually done (stop a
// 10-minute session at 7 and it's logged as 7 minutes; stop a 20-minute
// one at 7 and nothing is saved).
function mobilityCountsAsDone(doneSeconds, plannedSeconds) {
  return doneSeconds * 2 >= plannedSeconds
}

function formatMobilityLength(seconds) {
  return seconds < 60 ? `${seconds} sec` : `${Math.floor(seconds / 60)} min`
}

function mobilityEndPrompt(doneSeconds, plannedSeconds) {
  const progress = `You've done ${formatMobilityLength(doneSeconds)} of ${formatMobilityLength(plannedSeconds)}`
  return mobilityCountsAsDone(doneSeconds, plannedSeconds)
    ? `End this mobility session? ${progress}, so it will be saved as a ${formatMobilityLength(doneSeconds)} session.`
    : `End this mobility session? ${progress}. Sessions shorter than half the planned time aren't saved.`
}

// selectedAreas is the up-to-2 focus areas chosen in renderMobilityAreaPicker
// (or undefined from renderMobilityTimer's no-library path, where there was
// never a library to pick areas from) - stored so the coach can see what the
// athlete was focusing on from the calendar day-detail view.
//
// goHome: false when the session ended because the athlete is leaving for
// another screen (back gesture / tab) - save in the background, don't
// pull them back to Home. told: the end prompt already said whether it
// would be saved, so a discarded session needs no second message.
async function finishMobilitySession(startedAt, selectedAreas, doneSeconds, plannedSeconds, { goHome = true, told = false } = {}) {
  if (!mobilityCountsAsDone(doneSeconds, plannedSeconds)) {
    if (!told) customAlert("This mobility session wasn't saved: less than half of the planned time was done.")
    if (goHome) renderWeekView(currentWeekStart || startOfWeek(new Date()))
    return
  }

  const { error } = await insertOnce('workout_sessions', {
    id: crypto.randomUUID(),
    athlete_id: athlete.id,
    program_day_id: null,
    session_type: 'mobility',
    started_at: startedAt.toISOString(),
    // Started + time actually done, so the calendar shows the real length
    // (pauses in the guided flow don't count)
    ended_at: new Date(startedAt.getTime() + doneSeconds * 1000).toISOString(),
    local_date: toDateStr(startedAt),
    mobility_focus_areas: selectedAreas && selectedAreas.length ? selectedAreas : null
  })

  if (error) {
    console.log(error)
    customAlert('Something went wrong saving that mobility session - check your connection and try again')
  } else {
    customAlert(`Mobility session logged (${formatMobilityLength(doneSeconds)})!`)
  }

  await loadTrainingData()
  if (goHome) renderWeekView(currentWeekStart || startOfWeek(new Date()))
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
      // stretch back-to-back (comparing by .id, not object identity, still
      // works correctly for a two-sided pair below - both entries share
      // the same underlying stretch's id)
      do {
        pool = weightedShuffle()
      } while (candidates.length > 1 && queue.length > 0 && pool[0].id === queue[queue.length - 1].id)
    }
    const next = pool.shift()
    const holdSeconds = next.default_hold_seconds || 30
    if (next.is_unilateral) {
      // One filmed clip, shown twice in a row - second pass is a shallow
      // clone flagged __otherSide so renderMobilityFlow's updateChrome() can
      // show a "switch sides" cue, same video_url/id/hold either way (the
      // id match is what lets the like/dislike buttons and the lap-repeat
      // check above treat both halves as the one stretch they are)
      queue.push(next)
      queue.push({ ...next, __otherSide: true })
      elapsed += holdSeconds * 2
    } else {
      queue.push(next)
      elapsed += holdSeconds
    }
  }
  return queue
}

async function startMobilityFlow(selectedAreas, totalSeconds) {
  const queue = buildMobilityQueue(stretchLibraryCache, athleteStretchPreferencesCache, selectedAreas, totalSeconds)
  if (queue.length === 0) {
    customAlert("No stretches available yet - ask your coach to add some to the library.")
    return
  }
  renderMobilityFlow(queue, totalSeconds, selectedAreas)
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
export function renderMobilityFlow(queue, totalSeconds, selectedAreas) {
  nav.enter('mobilityFlow', { queue, totalSeconds, selectedAreas }, {
    collapse: true,
    // Same as the End button: ask, then end under the half-time rule -
    // without pulling the athlete back to Home, since they're leaving
    guard: () => endFlowEarly({ goHome: false })
  })

  const startedAt = new Date()
  let index = 0
  let remaining = queue[0].default_hold_seconds || 30
  let paused = false
  // Ticks up once per second the countdown actually runs (so a manual
  // pause or a between-exercise grace period doesn't count against it) -
  // this, not queue position, is what the progress bar tracks: pick a
  // 10-minute session and the bar is full once 10 minutes of it have
  // actually elapsed, regardless of how many stretches that turned out to be.
  let elapsedActiveSeconds = 0
  // showOtherSideTransition's two chained setTimeouts, tracked so leaving
  // the flow mid-transition (finishFlow) can cancel whichever is still
  // pending instead of letting it fire later against a torn-down screen.
  let pendingSideTransitionTimeouts = []

  pageContent.innerHTML = `
    <div class="workout-active" style="display:none"></div>
    <div class="mobility-flow-screen">
      <video class="mobility-flow-video active" id="mobilityVideoA" muted playsinline loop></video>
      <video class="mobility-flow-video" id="mobilityVideoB" muted playsinline loop></video>
      <div class="mobility-side-transition" id="mobilitySideTransition">
        <span class="mobility-side-transition-text">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
          Other Side
        </span>
      </div>
      <!-- Painted AFTER the full-bleed videos above (and BEFORE the overlay
           content below still lays out fine, since this is absolutely
           positioned and out of flow) - it used to be the FIRST child here,
           which meant the opaque .active video painted right on top of it
           and hid it completely despite the bar logic working correctly the
           whole time. -->
      <div class="mobility-flow-progress"><div class="mobility-flow-progress-fill" id="mobilityFlowProgressFill"></div></div>
      <div class="mobility-flow-overlay">
        <div class="mobility-flow-top">
          <button type="button" class="mobility-flow-icon-btn" id="mobilityFlowEndBtn">✕</button>
          <span class="mobility-flow-name" id="mobilityFlowName"></span>
          <button type="button" class="mobility-flow-icon-btn" id="mobilityFlowPauseBtn">⏸</button>
        </div>
        <div class="mobility-flow-bottom">
          <button type="button" class="mobility-flow-pref-btn" id="mobilityFlowDislikeBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path></svg></button>
          <span class="mobility-flow-time" id="mobilityFlowTime"></span>
          <button type="button" class="mobility-flow-pref-btn" id="mobilityFlowLikeBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg></button>
          <button type="button" class="mobility-flow-skip-btn" id="mobilityFlowSkipBtn">Skip ⏭</button>
        </div>
      </div>
    </div>
  `

  const videos = [document.getElementById('mobilityVideoA'), document.getElementById('mobilityVideoB')]
  let frontIndex = 0

  function loadStretchIntoVideo(videoEl, stretch) {
    // A two-sided stretch's "other side" pass replays the SAME clip (only
    // one side was ever filmed, see buildMobilityQueue) - mirroring it
    // horizontally is a cheap way to make it actually look like the other
    // side instead of visibly repeating the exact same footage
    videoEl.classList.toggle('mirrored', !!(stretch && stretch.__otherSide))
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
    // Guards against a stray timer (see pendingSideTransitionTimeouts below)
    // firing after the athlete has already navigated off this screen -
    // pageContent has been replaced by then, so every element here is gone.
    const nameEl = document.getElementById('mobilityFlowName')
    if (!nameEl) return
    const newName = queue[index].name + (queue[index].__otherSide ? ' · Other Side' : '')
    // Fade the label through instead of snapping it, so a new exercise's
    // name doesn't just jump-cut in sync with the video crossfade below
    if (nameEl.textContent !== newName) {
      nameEl.style.opacity = '0'
      setTimeout(function() { nameEl.textContent = newName; nameEl.style.opacity = '1' }, 200)
    }
    const timeEl = document.getElementById('mobilityFlowTime')
    if (timeEl) timeEl.textContent = formatTimer(remaining)
    updatePrefButtons(queue[index].id)
    updateProgressBar()
  }

  function updateProgressBar() {
    const pct = Math.min(100, Math.round((elapsedActiveSeconds / totalSeconds) * 100))
    const fill = document.getElementById('mobilityFlowProgressFill')
    if (fill) fill.style.width = pct + '%'
  }

  // Grace period after every exercise change, on top of the prescribed hold
  // - the video/name update immediately (so the athlete can see what's next
  // and start moving), but the countdown stays frozen for this long before
  // it actually starts ticking, so getting into position never eats into
  // the real hold time. Same duration used for the "Other Side" interstitial
  // below, just spent behind that black screen instead of the video.
  const TRANSITION_PAUSE_MS = 2200

  function swapToCurrentIndex() {
    frontIndex = 1 - frontIndex
    videos[frontIndex].classList.add('active')
    videos[1 - frontIndex].classList.remove('active')
    remaining = queue[index].default_hold_seconds || 30
    updateChrome()
    preloadNext()
  }

  // Pauses the countdown (display included, since the ticker's own "if
  // (paused) return" skips updating it too) without touching the hold total
  // - restores whatever paused actually was before, so this can't
  // accidentally un-pause an athlete who paused manually right as a
  // transition started.
  function pauseCountdownBriefly(ms) {
    const wasPaused = paused
    paused = true
    setTimeout(function() { paused = wasPaused }, ms)
  }

  // Held between the two passes of a two-sided stretch - the actual video
  // swap happens while the interstitial is still fully opaque (see the
  // inner setTimeout), so what's revealed when it fades back out is already
  // the preloaded, mirrored other-side clip playing, not a jump-cut mid-swap.
  function showOtherSideTransition(onSwap) {
    const wasPaused = paused
    paused = true
    const el = document.getElementById('mobilitySideTransition')
    if (!el) return
    el.classList.add('active')
    const outerTimeout = setTimeout(function() {
      onSwap()
      const innerTimeout = setTimeout(function() {
        el.classList.remove('active')
        paused = wasPaused
      }, TRANSITION_PAUSE_MS - 1700)
      pendingSideTransitionTimeouts.push(innerTimeout)
    }, 1700)
    pendingSideTransitionTimeouts.push(outerTimeout)
  }

  function advance() {
    index++
    if (index >= queue.length) { finishFlow(); return }
    if (queue[index].__otherSide) {
      showOtherSideTransition(swapToCurrentIndex)
    } else {
      swapToCurrentIndex()
      pauseCountdownBriefly(TRANSITION_PAUSE_MS)
    }
  }

  let ended = false

  // Reached the end of the queue, or ended early after the prompt (told).
  // elapsedActiveSeconds, not wall time, is what counts: pauses and the
  // between-stretch grace periods aren't mobility done.
  function finishFlow({ goHome = true, told = false } = {}) {
    ended = true
    clearMobilityFlowTimer()
    pendingSideTransitionTimeouts.forEach(clearTimeout)
    pendingSideTransitionTimeouts = []
    finishMobilitySession(startedAt, selectedAreas, elapsedActiveSeconds, totalSeconds, { goHome, told })
  }

  async function endFlowEarly({ goHome }) {
    if (ended) return true
    if (!(await customConfirm(mobilityEndPrompt(elapsedActiveSeconds, totalSeconds)))) return false
    if (!ended) finishFlow({ goHome, told: true })
    return true
  }

  loadStretchIntoVideo(videos[0], queue[0])
  updateChrome()
  preloadNext()

  mobilityFlowInterval = setInterval(function() {
    if (paused || ended) return
    remaining--
    elapsedActiveSeconds++
    const timeEl = document.getElementById('mobilityFlowTime')
    if (timeEl) timeEl.textContent = formatTimer(remaining)
    updateProgressBar()
    if (remaining <= 0) advance()
  }, 1000)

  document.getElementById('mobilityFlowPauseBtn').addEventListener('click', function() {
    paused = !paused
    this.textContent = paused ? '▶' : '⏸'
    videos.forEach(function(v) { if (paused) v.pause(); else v.play().catch(function() {}) })
  })

  document.getElementById('mobilityFlowSkipBtn').addEventListener('click', advance)

  document.getElementById('mobilityFlowEndBtn').addEventListener('click', function() {
    endFlowEarly({ goHome: true })
  })

  document.getElementById('mobilityFlowLikeBtn').addEventListener('click', function() {
    toggleStretchPreference(queue[index].id, 'liked')
  })
  document.getElementById('mobilityFlowDislikeBtn').addEventListener('click', function() {
    toggleStretchPreference(queue[index].id, 'disliked')
  })
}

export function clearMobilityFlowTimer() {
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
