// ==========================================================================
// ATHLETE APP - rest timer
// Wall-clock rest countdown and its push-notification backup.
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import { session, workoutScreenSeq } from '../state.js?v=__V__'

let restTimerInterval = null

// ==========================================================================
// ---- REST TIMER ----
// Only fires between sets, not after the last one - if the row just checked
// is the last row in its exercise's list, there's nothing to rest before.
// Group (superset/section) rest timing is handled entirely by
// goToNextGroupStep instead - checkSet only ever calls this function for a
// normal single exercise (see checkSet's currentSlideContext branch).
// ==========================================================================
export function maybeStartRestTimer(pe, rowEl) {
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

let restTimerOriginSeq = 0

export function startRestTimer(totalSeconds, onDone) {
  clearRestTimer()
  restTimerOnDone = onDone || null
  restTimerOriginSeq = workoutScreenSeq
  const bar = document.getElementById('restTimerBar')
  if (!bar) return

  restTimerEndAt = Date.now() + totalSeconds * 1000
  renderRestTimerBar(totalSeconds)

  restTimerInterval = setInterval(tickRestTimer, 1000)
  scheduleRestTimerPush(totalSeconds) // backup notification in case the athlete isn't looking when this ends - see the comment above these two functions, below
}

// The auto-continue callback (a superset's next round) only fires while the
// athlete is still on the screen the rest started on - if they've swiped
// elsewhere since, the rest just ends instead of pulling them back
function takeRestTimerCallback() {
  const cb = restTimerOnDone
  return restTimerOriginSeq === workoutScreenSeq ? cb : null
}

function renderRestTimerBar(remainingSeconds) {
  const bar = document.getElementById('restTimerBar')
  if (!bar) return
  bar.style.display = 'flex'
  bar.innerHTML = `
    <span class="rest-timer-label">Rest</span>
    <span class="rest-timer-time" id="restTimerTime">${formatTimer(remainingSeconds)}</span>
    <button type="button" class="rest-timer-skip" id="restTimerSkipBtn">Skip</button>
  `
  document.getElementById('restTimerSkipBtn').addEventListener('click', function() {
    const cb = takeRestTimerCallback()
    clearRestTimer()
    if (cb) cb()
  })
}

// Each workout slide renders its own empty #restTimerBar, so a rest that's
// still running when the athlete swipes needs its bar drawn again on the
// new slide (called from mountSlide)
export function restoreRestTimerBar() {
  if (restTimerEndAt == null) return
  const remaining = Math.ceil((restTimerEndAt - Date.now()) / 1000)
  if (remaining > 0) renderRestTimerBar(remaining)
}

export function tickRestTimer() {
  if (restTimerEndAt == null) return
  const remaining = Math.ceil((restTimerEndAt - Date.now()) / 1000)
  if (remaining <= 0) {
    playRestDoneSound()
    const cb = takeRestTimerCallback()
    clearRestTimer()
    if (cb) cb()
    return
  }
  const timeEl = document.getElementById('restTimerTime')
  if (timeEl) timeEl.textContent = formatTimer(remaining)
}

export function clearRestTimer() {
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

export function formatTimer(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// A short beep via the Web Audio API (an oscillator, no external asset)
// plus a vibration where supported - either can silently no-op, the timer
// still visually hit zero either way
export function playRestDoneSound() {
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
