// ==========================================================================
// ATHLETE APP - workout: swipe navigation between exercises, finishing a
// workout, and the workout summary (RPE, pain/injury follow-up, notes,
// duration).
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { escapeHtml } from '../../escape.js?v=__V__'
import { startOfWeek } from '../../shared/dates.js?v=__V__'
import { pageContent, athlete, wk } from '../state.js?v=__V__'
import { completedSessionsByDayId, logSetsByPE, openSessionsByDayId } from '../data.js?v=__V__'
import { RPE_DESCRIPTIONS, formatTimedReps, formatWeight, trainingDisplayName } from '../format.js?v=__V__'
import { maybeShowSetHint } from '../home-tour.js?v=__V__'
import { describeError, dropPendingSessionEnd, flushPendingQueue, flushTimer, saveSessionEnd, saveWithRetry } from '../outbox.js?v=__V__'
import { currentWeekStart, renderWeekView } from '../screens/home.js?v=__V__'
import { notifyCoach } from '../screens/tournaments.js?v=__V__'
import { loadAndRenderPRBadges } from './prs.js?v=__V__'
import { restoreRestTimerBar } from './rest-timer.js?v=__V__'
import { customAlert, customConfirm } from '../../confirm-modal.js?v=__V__'

// ==========================================================================
// ---- SWIPE NAVIGATION ----
// Drags the current ".workout-slide" 1:1 with the finger, and snaps it out
// (then calls the nav callback) once a horizontal drag clears the
// threshold. Uses the Pointer Events API so touch, mouse, and pen all work
// through one code path. Pointer capture is only taken once a drag is
// confirmed horizontal - never on a plain tap - so taps on set-row inputs/
// buttons inside the slide are completely unaffected.
// ==========================================================================
export function mountSlide(direction) {
  restoreRestTimerBar()
  maybeShowSetHint()
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

export function attachSwipeHandlers(onSwipeLeft, onSwipeRight) {
  if (wk.swipeCleanup) { wk.swipeCleanup(); wk.swipeCleanup = null }

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

  wk.swipeCleanup = function() {
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
export async function finishWorkout(entry, session) {
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

export function renderWorkoutSummary(finishedSession, entry) {
  // popTo collapses any 'workout' frame(s) sitting between here and Day
  // Preview - reached from finishWorkout(), the workout already ended, so
  // back must land on Day Preview, not re-enter it. Reached directly from a
  // completed Day Preview's "View Summary" instead, the current frame IS
  // already dayPreview, so this is a no-op push right on top of it, same
  // as any other drill-down.
  nav.enter('workoutSummary', { session: finishedSession, entry }, { popTo: 'dayPreview' })

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

    // One row per set with a thin divider between them (.detail-row/
    // .detail-list), not a single "N sets" count - this is the screen that
    // now carries the full detail Day Preview's expand used to show (see
    // its own comment). Same reps/duration/weight/distance formatting as
    // the read-only Exercise History modal (renderExerciseHistoryBody) and
    // the same tracks*/isTimed derivation exerciseActionButtonsHtml uses,
    // so a set reads identically wherever it's shown in this app.
    const tracksReps = !pe.exercises || pe.exercises.tracks_reps !== false
    const isTimed = pe.exercises && pe.exercises.is_timed
    const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
    const tracksDistance = pe.exercises && pe.exercises.tracks_distance
    const setsHtml = sets.map(s => {
      const repsParts = []
      if (tracksReps) repsParts.push(`${s.actual_reps || '-'} reps`)
      if (isTimed) {
        const durationSource = s.actual_duration != null ? s.actual_duration : (!tracksReps ? s.actual_reps : null)
        if (durationSource != null) repsParts.push(formatTimedReps(durationSource))
      }
      const repsText = repsParts.join(' · ')
      // The unit THIS set was actually logged in (falls back to kg for
      // older rows saved before weight_unit existed), not the athlete's
      // current default - same reasoning as Exercise History.
      const setUnit = s.weight_unit || 'kg'
      const weightText = tracksWeight && s.actual_weight != null ? ' @ ' + formatWeight(s.actual_weight, setUnit) + setUnit : ''
      const distanceText = tracksDistance && s.actual_distance != null ? ` · ${s.actual_distance}m` : ''
      return `<li class="detail-row"><span>Set ${s.set_number}</span><span class="detail-row-value">${repsText}${weightText}${distanceText}</span></li>`
    }).join('')

    return `
      <div class="summary-exercise-row">
        <div class="summary-exercise-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        <div class="pr-badges" id="prBadges-${pe.id}"></div>
        ${plyoLoad != null ? `<p class="plyo-load-line">Plyo Load: ${Math.round(plyoLoad)}</p>` : ''}
        <ul class="detail-list">${setsHtml}</ul>
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
          <button type="button" class="duration-edit-btn" id="durationEditBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg> Edit</button>
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
          <button type="button" class="rpe-flag-choice-btn ${finishedSession.rpe_flag_reason === 'heavy_tiring' ? 'selected' : ''}" data-reason="heavy_tiring">Just heavy / tiring</button>
          <button type="button" class="rpe-flag-choice-btn ${finishedSession.rpe_flag_reason === 'pain_injury' ? 'selected' : ''}" data-reason="pain_injury">Pain or injury</button>
        </div>
        <div class="rpe-flag-note-row" id="rpeFlagNoteRow" style="display:${finishedSession.rpe_flag_reason === 'pain_injury' ? 'block' : 'none'}">
          <label>What happened / what hurts?</label>
          <textarea id="rpeFlagNoteInput" rows="3" placeholder="e.g. Sharp pain in my left knee on the last set of squats">${finishedSession.rpe_flag_note || ''}</textarea>
          <button type="button" class="btn-save" id="rpeFlagNoteSaveBtn">Save note</button>
          <span class="rpe-flag-note-saved" id="rpeFlagNoteSaved" style="display:none">Saved ✓</span>
        </div>
      </div>
    </div>

    <div class="rpe-flag-note-row workout-note-row">
      <label for="workoutNoteInput">Note for your coach (optional)</label>
      <textarea id="workoutNoteInput" rows="3" maxlength="1000" placeholder="e.g. Shoulder felt tight on bench, no sled at the gym so I swapped it">${escapeHtml(finishedSession.athlete_note || '')}</textarea>
      <button type="button" class="btn-save" id="workoutNoteSaveBtn">Save note</button>
      <span class="rpe-flag-note-saved" id="workoutNoteSaved" style="display:none">Saved ✓</span>
    </div>

    <div class="summary-exercise-list">${breakdownHtml || '<p class="no-metrics">Nothing logged</p>'}</div>
    <!-- Disabled until an RPE is picked (see wireSummaryRpePicker) - Training
         Load/ACWR/Monotony/Strain are computed entirely from session_rpe
         (see loadOverviewStats), and with no validation here it was too easy
         to tap straight past an optional rating and never notice those
         numbers had gone permanently blank. Already-rated sessions
         (revisiting a past day's summary) start enabled as normal. -->
    <button class="btn-save start-workout-btn" id="summaryDoneBtn" ${finishedSession.session_rpe ? '' : 'disabled'}>Done</button>
  `

  document.getElementById('summaryDoneBtn').addEventListener('click', async function() {
    // Safety net: a typed-but-unsaved pain/injury note shouldn't be lost
    // just because the athlete tapped Done instead of "Save note"
    const noteRow = document.getElementById('rpeFlagNoteRow')
    const noteInput = document.getElementById('rpeFlagNoteInput')
    if (noteRow && noteInput && noteRow.style.display !== 'none' && noteInput.value !== (finishedSession.rpe_flag_note || '')) {
      await saveRpeFlagNote(finishedSession, noteInput.value)
    }
    // Same safety net for the note to the coach
    const workoutNoteInput = document.getElementById('workoutNoteInput')
    if (workoutNoteInput && workoutNoteInput.value.trim() !== (finishedSession.athlete_note || '')) {
      await saveWorkoutNote(finishedSession, entry, workoutNoteInput.value)
    }
    renderWeekView(currentWeekStart || startOfWeek(new Date()))
  })

  document.getElementById('workoutNoteSaveBtn').addEventListener('click', function() {
    saveWorkoutNote(finishedSession, entry, document.getElementById('workoutNoteInput').value)
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
    const doneBtn = document.getElementById('summaryDoneBtn')
    if (doneBtn) doneBtn.disabled = false

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
// Free-text note from the athlete to the coach, separate from the RPE
// follow-up's pain note (that one only appears on a 9-10 rating and is about
// pain/injury) - this works for any workout. Stored on the session so the
// coach sees it next to that day's RPE, and the coach also gets a
// notification when it's saved with text in it. Needs
// workout_sessions.athlete_note (see sql-history.sql); until that migration
// has run, the update fails and the athlete is told nothing was saved.
async function saveWorkoutNote(session, entry, rawNote) {
  const note = rawNote.trim()
  if (note === (session.athlete_note || '')) return

  if (!session.id.startsWith('local-')) {
    const { error } = await saveWithRetry((signal) => supabase
      .from('workout_sessions')
      .update({ athlete_note: note || null })
      .eq('id', session.id)
      .abortSignal(signal)
    )
    if (error) {
      console.log(error)
      customAlert('Something went wrong saving your note: ' + describeError(error))
      return
    }
  }

  session.athlete_note = note
  if (note) {
    const preview = note.length > 140 ? note.slice(0, 140) + '...' : note
    notifyCoach('workout_note', `${athlete.name} left a note on ${trainingDisplayName(entry)}: "${preview}"`) // not awaited
  }

  const saved = document.getElementById('workoutNoteSaved')
  if (saved) {
    saved.style.display = 'inline'
    setTimeout(() => { saved.style.display = 'none' }, 2000)
  }
}

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
    dropPendingSessionEnd(session.id)

    // Re-render from scratch - recomputes the duration text/warning and
    // re-runs PR detection against the (now differently-dated) session
    renderWorkoutSummary(data, entry)
  })
}
