// ==========================================================================
// ATHLETE APP - offline queues + retry
// The pending set-save queue and the pending session-end queue, flushed when
// the connection returns, and saveWithRetry.
// ==========================================================================
import { supabase } from './athleteClient.js?v=__V__'
import { athlete } from './state.js?v=__V__'
import { logSetsByPE } from './data.js?v=__V__'
import { tickRestTimer } from './workout/rest-timer.js?v=__V__'

// ==========================================================================
// ---- PENDING SAVE QUEUE ----
// A tiny durable outbox in localStorage, keyed by (program_exercise_id,
// date, set_number) so only the latest action for a given set is ever
// queued. checkSet/uncheckSet write here before attempting to save, so the
// change survives even if the tab is killed mid-retry - flushPendingQueue
// picks up anything still sitting here on the next load or tab-foreground.
// ==========================================================================
export function loadPendingQueue() {
  try {
    return JSON.parse(localStorage.getItem('tbflog-pending-sets') || '[]')
  } catch (e) {
    return []
  }
}

export function savePendingQueueToStorage(queue) {
  try {
    localStorage.setItem('tbflog-pending-sets', JSON.stringify(queue))
  } catch (e) { /* storage full/unavailable - falls back to in-memory-only behavior for this session */ }
}

function queueKey(entry) {
  return `${entry.program_exercise_id}|${entry.date}|${entry.set_number}`
}

export function queueUpsert(entry) {
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
export function applyPendingQueueLocally() {
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
export let flushTimer = null
let flushInFlight = false
let flushAgainNeeded = false
let firstQueuedAt = null

// Tapping a set schedules a flush ~1.5s later; each further tap within that
// window pushes it back out again, so a quick run of taps becomes one
// flush cycle - capped at 5s so a long flurry of taps still flushes
// promptly instead of being postponed indefinitely.
export function scheduleFlush() {
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
export async function flushPendingQueue() {
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
export async function saveSessionEnd(sessionId, endedAt) {
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

export async function flushPendingSessionEnds() {
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
export function describeError(error) {
  if (!error) return 'Unknown error'
  if (error.message) return error.message
  try { return JSON.stringify(error) } catch (e) { return String(error) }
}

// Retry the queues when the app comes back to the foreground, and every
// 20s while visible. Called once from dashboard.js at startup.
export function startOutboxRetries() {
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
}

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
      actual_duration: entry.actual_duration,
      actual_weight: entry.actual_weight,
      actual_distance: entry.actual_distance,
      weight_unit: entry.weight_unit,
      completed_at: entry.completed_at
    }], { onConflict: 'program_exercise_id,date,set_number' })
    .select()
    .abortSignal(signal)
  )
}

// Retries a Supabase call a few times with backoff before giving up - the
// shared window.fetchWithRetry (network-retry.js, loaded by dashboard.html
// before this app), which this used to be an exact copy of. Never throws:
// a failed attempt comes back in the usual {data, error} shape, so it's
// safe to await from anywhere, including in a loop from flushPendingQueue.
export function saveWithRetry(operationFactory, maxAttempts = 3) {
  return window.fetchWithRetry(operationFactory, maxAttempts)
}
