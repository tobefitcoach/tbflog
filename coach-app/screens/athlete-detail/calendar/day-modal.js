// ==========================================================================
// ATHLETE DETAIL - calendar: day detail popup
// What opens when the coach taps a workout, mobility session, tournament or
// form on the grid.
// ==========================================================================
import { supabase } from '../../../../coachClient.js?v=__V__'
import * as nav from '../../../nav.js?v=__V__'
import { openBuilderOverlay } from '../../../builder-overlay.js?v=__V__'
import { escapeHtml } from '../../../../escape.js?v=__V__'
import { getYouTubeThumbnail } from '../../../../shared/video.js?v=__V__'
import { root, mountToken, currentAthlete, cal } from '../state.js?v=__V__'
import { TOURNAMENT_IMPORTANCE_DESCRIPTIONS_CAL, WORKOUT_TYPE_LABELS_CAL, formatShortDateCal, loadCalendarMonth, trainingDisplayName } from './grid.js?v=__V__'
import { showToast } from '../toast.js?v=__V__'
import { customAlert, customConfirm } from '../../../../confirm-modal.js?v=__V__'
import { fetchWithRetry } from '../../../../network-retry.js?v=__V__'

// ==========================================================================
// ---- DAY DETAIL MODAL ----
// Reads straight from the in-memory calendarEntriesByDate/mobilityEntries
// ByDateCal/tournamentsByDateCal maps - no query. Opened per-ITEM now, not
// per-day - a day with two workouts back to back used to dump both into one
// scrolling popup with no clear seam between them, so clicking a day cell's
// empty background now does nothing; only clicking a specific workout/
// mobility/tournament badge opens its own modal, titled with that item's
// own name instead of the date.
// ==========================================================================
export function openWorkoutDetailModal(dateStr, dayId) {
  const entries = cal.calendarEntriesByDate[dateStr] || []
  const entry = entries.find(e => String(e.day.id) === String(dayId))
  if (!entry) return

  const session = cal.sessionByDayId[entry.day.id]
  const showReview = !!session

  // Nothing logged yet to review - go straight to the real Workout Builder
  // (shown in the overlay - see openWorkoutBuilderOverlay) for
  // editing, instead of this popup's own separate, more limited inline
  // editor. Only a day the athlete has already started/finished still opens
  // this popup, to show what they actually logged.
  if (!showReview) {
    openWorkoutBuilderOverlay(dayId, dateStr)
    return
  }

  cal.currentDayDateForModal = dateStr
  root.querySelector('#dayDetailTitle').textContent = trainingDisplayName(entry)

  const exercises = entry.day.program_exercises

  root.querySelector('#dayDetailContent').innerHTML = `
    <div class="detail-group" data-review="true" data-program-day-id="${entry.day.id}">
      <div style="display:flex; justify-content:flex-end; align-items:center; gap:8px; margin-bottom:8px">
        ${entry.day.moved_by_athlete ? '<span class="athlete-modified-badge">Moved by athlete</span>' : ''}
        <select class="workout-type-select" data-action="set-workout-type" data-day-id="${entry.day.id}">
          ${Object.entries(WORKOUT_TYPE_LABELS_CAL).map(([value, text]) => `<option value="${value}" ${(entry.day.workout_type || 'gym') === value ? 'selected' : ''}>${text}</option>`).join('')}
        </select>
      </div>
      ${renderSessionSummaryCal(session)}
      ${exercises.length === 0
        ? '<p class="no-metrics">No exercises</p>'
        : exercises.map(pe => renderLoggedExerciseCardCal(pe)).join('')}
      <button type="button" class="unit-btn" data-action="toggle-review-edit" style="margin-top:8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg> Edit Plan Instead</button>
    </div>
  `

  root.querySelector('#dayDetailModal').classList.add('active')
}

// Same Workout Builder overlay the calendar's "+ New Training" flow already
// uses (see #trainingBuilderOverlayModal/#trainingBuilderHost in the
// TEMPLATE) - { dayId } instead of { id } puts the builder into "edit this
// scheduled day's program_exercises" mode rather than "edit a Workout
// Library template's training_exercises" mode (see isDayMode in
// screens/training-builder.js). Reused for both a still-empty day and one
// that already has exercises, so a coach gets the exact same
// search-the-library-and-drag / drag-to-reorder experience as building a
// Workout Library entry, whether they're starting from scratch or adjusting
// what's already scheduled.
export function openWorkoutBuilderOverlay(dayId, dateStr) {
  cal.currentDayDateForModal = dateStr
  cal.trainingBuilderOverlayMode = 'edit-day'
  root.querySelector('#dayDetailModal').classList.remove('active')
  root.querySelector('#trainingBuilderOverlayModal').classList.add('active')
  openBuilderOverlay(root.querySelector('#trainingBuilderHost'), { dayId })
}

// Mobility never creates a programs/program_days row, so it's read straight
// from mobilityEntriesByDateCal instead of calendarEntriesByDate
export function openMobilityDetailModal(dateStr) {
  const mobility = cal.mobilityEntriesByDateCal[dateStr]
  if (!mobility) return

  cal.currentDayDateForModal = dateStr
  root.querySelector('#dayDetailTitle').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="4" r="2"></circle><path d="M12 6v6"></path><path d="M8 8l4 2 4-2"></path><path d="M9 20l3-6 3 6"></path></svg> Mobility / Stretching'

  const mobilityFocusText = mobility.mobility_focus_areas && mobility.mobility_focus_areas.length
    ? mobility.mobility_focus_areas.map(escapeHtml).join(', ')
    : 'Full Body / No preference'

  root.querySelector('#dayDetailContent').innerHTML = `
    <p class="workout-preview-target">${Math.round((new Date(mobility.ended_at) - new Date(mobility.started_at)) / 60000)} min · Focus: ${mobilityFocusText}</p>
  `

  root.querySelector('#dayDetailModal').classList.add('active')
}

// A tournament is its own row, not tied to any scheduled workout
export function openTournamentDetailModal(dateStr) {
  const tournament = cal.tournamentsByDateCal[dateStr]
  if (!tournament) return

  cal.currentDayDateForModal = dateStr
  root.querySelector('#dayDetailTitle').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg> ${escapeHtml(tournament.name)}`

  const tournamentDateRange = tournament.date !== tournament.end_date
    ? `${formatShortDateCal(tournament.date)} – ${formatShortDateCal(tournament.end_date)}`
    : null

  const addedByCoach = !!tournament.created_by_coach
  const ratingLine = tournament.importance != null
    ? `Importance ${tournament.importance}/5 — ${TOURNAMENT_IMPORTANCE_DESCRIPTIONS_CAL[tournament.importance]}`
    : 'Importance rating unavailable'

  root.querySelector('#dayDetailContent').innerHTML = `
    ${tournamentDateRange ? `<p class="workout-preview-target">${tournamentDateRange}</p>` : ''}
    <p class="workout-preview-target">${ratingLine}</p>
    <p class="coach-tournament-origin">${addedByCoach
      ? 'Added by you. Your athlete can see this tournament on their calendar, but not your rating.'
      : 'Added by the athlete, with their own rating.'}</p>
    ${addedByCoach ? `<div class="form-actions form-actions-end"><button type="button" class="btn-cancel" id="deleteCoachTournamentBtn">Delete Tournament</button></div>` : ''}
  `

  if (addedByCoach) {
    root.querySelector('#deleteCoachTournamentBtn').addEventListener('click', async function() {
      if (!(await customConfirm(`Delete "${tournament.name}" from ${currentAthlete?.name || 'the athlete'}'s calendar?`))) return
      const { error } = await fetchWithRetry((signal) => supabase
        .from('tournaments')
        .delete()
        .eq('id', tournament.id)
        .abortSignal(signal)
      )
      if (!root) return
      if (error) { console.log(error); customAlert('Something went wrong deleting that - try again'); return }
      root.querySelector('#dayDetailModal').classList.remove('active')
      await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
      showToast('Tournament deleted')
    })
  }

  root.querySelector('#dayDetailModal').classList.add('active')
}

// Queried fresh (not read from formAssignmentsByDateCal) since the answers
// aren't preloaded for the whole month - only fetched once the coach
// actually opens one specific assignment
export async function openFormDetailModal(assignmentId) {
  const token = mountToken
  const { data: assignment, error } = await supabase
    .from('form_assignments')
    .select('*, forms(name, form_questions(*))')
    .eq('id', assignmentId)
    .single()

  if (!nav.isCurrent(token)) return
  if (error) { console.log(error); customAlert('Something went wrong loading that form'); return }

  root.querySelector('#dayDetailTitle').textContent = assignment.forms ? assignment.forms.name : 'Form'

  if (!assignment.completed_at) {
    root.querySelector('#dayDetailContent').innerHTML = '<p class="no-metrics">Not completed yet</p>'
    root.querySelector('#dayDetailModal').classList.add('active')
    return
  }

  const questions = ((assignment.forms && assignment.forms.form_questions) || []).sort((a, b) => a.order_index - b.order_index)

  const { data: answers, error: answersError } = await supabase.from('form_answers').select('*').eq('assignment_id', assignmentId)
  if (!nav.isCurrent(token)) return
  if (answersError) console.log(answersError)
  const answersByQuestion = {}
  for (const a of (answers || [])) answersByQuestion[a.question_id] = a

  root.querySelector('#dayDetailContent').innerHTML = `
    <p class="workout-preview-target">Completed ${new Date(assignment.completed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
    ${questions.map(q => {
      const a = answersByQuestion[q.id]
      const answerText = a ? (q.type === 'scale_1_5' ? (a.answer_scale != null ? `${a.answer_scale}/5` : '—') : (a.answer_text || '—')) : '—'
      return `
        <div class="form-question-card">
          <p style="color:#aaaacc; font-size:12px; margin-bottom:4px">${escapeHtml(q.question_text)}</p>
          <p style="white-space:pre-wrap">${escapeHtml(answerText)}</p>
        </div>
      `
    }).join('')}
  `

  root.querySelector('#dayDetailModal').classList.add('active')
}

// Shown at the top of a done/in-progress day's review - just duration + RPE,
// same numbers the athlete's own post-workout summary shows (see
// renderWorkoutSummary in the athlete app's dashboard.js), formatted for a
// one-line glance
function renderSessionSummaryCal(session) {
  if (!session.ended_at) {
    const startedTime = new Date(session.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return `<p class="workout-preview-target" style="margin-bottom:12px"><span class="status-dot-progress"></span> In progress — started ${startedTime}</p>`
  }
  const durationMin = Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 60000)
  const parts = [`⏱ ${durationMin} min`]
  if (session.session_rpe != null) parts.push(`RPE ${session.session_rpe}/10`)

  // Read-only here - "Mark Reviewed" lives on the Overview tab's report
  // inbox, so that stays a single source of truth for that write and
  // Calendar is purely context when browsing history
  const flagHtml = session.rpe_flag_reason === 'pain_injury'
    ? `<p class="pain-flag-note ${session.rpe_flag_reviewed_at ? 'reviewed' : ''}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg> Reported pain/injury${session.rpe_flag_reviewed_at ? ' (reviewed)' : ''}: ${escapeHtml(session.rpe_flag_note) || '<em>No description given</em>'}</p>`
    : ''

  const noteHtml = session.athlete_note
    ? `<p class="athlete-session-note"><strong>Athlete note:</strong> ${escapeHtml(session.athlete_note)}</p>`
    : ''

  return `<p class="workout-preview-target" style="margin-bottom:${flagHtml || noteHtml ? '4px' : '12px'}">${parts.join(' · ')}</p>${flagHtml}${noteHtml}`
}

// Read-only exercise card for a done workout - what the athlete actually
// logged (actual_reps/actual_weight) instead of the coach's set_targets,
// so a coach opening it sees a real review instead of the plan. Editing a
// day's exercises happens in the Workout Builder overlay
// (openWorkoutBuilderOverlay), not in this popup.
function renderLoggedExerciseCardCal(pe) {
  const isUnilateral = pe.exercises && pe.exercises.is_unilateral
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const sets = (cal.logSetsByPECal[pe.id] || []).filter(s => s.completed_at).sort((a, b) => a.set_number - b.set_number)

  const rowsHtml = sets.length === 0
    ? '<p class="no-metrics">Not logged yet</p>'
    : `<p class="summary-exercise-sets">${sets.length} set${sets.length === 1 ? '' : 's'}</p>`

  return `
    <div class="builder-exercise-card">
      <div class="builder-exercise-card-header">
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
        </button>
        <div class="builder-exercise-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${isUnilateral ? '<span class="builder-unilateral-badge">Each Side</span>' : ''}
        ${pe.added_by_athlete ? '<span class="athlete-modified-badge">Added by athlete</span>' : ''}
        ${pe.swapped_by_athlete ? '<span class="athlete-modified-badge">Swapped by athlete</span>' : ''}
      </div>
      ${rowsHtml}
    </div>
  `
}

// Ad-hoc trainings only ever cover the one day they were created for, so
// deleting the whole `programs` row is exactly "delete this training"
// (cascades its week/day/exercises). An assigned template instance can span
// many weeks, so only that one program_days row is removed - the rest of
// the assigned program stays on the calendar untouched.
//
// Deleting a workout also deletes everything the athlete logged on it (sets
// and the session cascade from the day), so a logged one gets a clear
// warning instead of the plain question.
export async function deleteTraining(mode, programId, programDayId) {
  const logged = await loggedSummaryForDay(programDayId)
  const plainQuestion = mode === 'adhoc'
    ? 'Delete this workout?'
    : 'Remove this day from the assigned program? (The rest of the program stays intact.)'
  if (!(await customConfirm(logged ? loggedDeleteWarning(logged) : plainQuestion))) return

  const token = mountToken
  const { error } = mode === 'adhoc'
    ? await supabase.from('programs').delete().eq('id', programId)
    : await supabase.from('program_days').delete().eq('id', programDayId)

  if (!nav.isCurrent(token)) return
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  root.querySelector('#dayDetailModal').classList.remove('active')
  await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
}

// What the athlete has logged on one workout: { sets, date } when they
// logged anything, null when nothing, { unknown: true } when the check
// itself failed (so the caller warns rather than assume it's safe).
async function loggedSummaryForDay(programDayId) {
  if (!programDayId) return { unknown: true }
  const [setsRes, sessionsRes] = await Promise.all([
    supabase
      .from('exercise_log_sets')
      .select('date, program_exercises!inner(day_id)', { count: 'exact' })
      .eq('program_exercises.day_id', programDayId)
      .not('completed_at', 'is', null)
      .order('date', { ascending: true })
      .limit(1),
    supabase
      .from('workout_sessions')
      .select('local_date')
      .eq('program_day_id', programDayId)
      .limit(1)
  ])
  if (setsRes.error || sessionsRes.error) {
    console.log(setsRes.error || sessionsRes.error)
    return { unknown: true }
  }
  const sets = setsRes.count || 0
  const session = sessionsRes.data && sessionsRes.data[0]
  if (sets === 0 && !session) return null
  const date = (setsRes.data[0] && setsRes.data[0].date) || (session && session.local_date)
  return { sets, date }
}

function loggedDeleteWarning(logged) {
  const name = currentAthlete ? currentAthlete.name.split(' ')[0] : 'The athlete'
  if (logged.unknown) {
    return `Couldn't check whether ${name} logged this workout. If they did, deleting it also permanently deletes everything they logged.\n\nDelete anyway?`
  }
  const when = logged.date ? formatShortDateCal(logged.date) : null
  const details = [when, logged.sets ? `${logged.sets} set${logged.sets === 1 ? '' : 's'}` : null].filter(Boolean).join(', ')
  return `${name} already logged this workout${details ? ` (${details})` : ''}.\n\nDeleting it also permanently deletes everything they logged: sets, duration, RPE and notes.\n\nDelete anyway?`
}

// A logged mobility session has no program/day/exercises of its own to
// speak of - just delete the workout_sessions row directly. No "copy"
// equivalent makes sense here (there's nothing to schedule ahead of time).
export async function deleteMobilitySession(sessionId) {
  if (!(await customConfirm('Delete this mobility session?'))) return

  const token = mountToken
  const { error } = await supabase.from('workout_sessions').delete().eq('id', sessionId)
  if (!nav.isCurrent(token)) return
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  root.querySelector('#dayDetailModal').classList.remove('active')
  await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
}

// Deleting the assignment cascades to its form_answers (if any were
// already submitted) - the form template itself is untouched, so it's
// still there to assign again another day
export async function deleteFormAssignment(assignmentId) {
  if (!(await customConfirm('Delete this form assignment? Any answers already submitted will be lost too.'))) return

  const token = mountToken
  const { error } = await supabase.from('form_assignments').delete().eq('id', assignmentId)
  if (!nav.isCurrent(token)) return
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  root.querySelector('#dayDetailModal').classList.remove('active')
  await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
}
