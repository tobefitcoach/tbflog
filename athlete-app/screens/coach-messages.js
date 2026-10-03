// ==========================================================================
// ATHLETE APP - weekly recap popup + coach messages
// (on-open and before-workout messages)
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import { escapeHtml } from '../../escape.js?v=__V__'
import { toDateStr, addDays, startOfWeek } from '../../shared/dates.js?v=__V__'
import { athlete, wk } from '../state.js?v=__V__'
import { completedSessionsByDayId, entriesByDate, logSetsByPE } from '../data.js?v=__V__'
import { saveWithRetry } from '../outbox.js?v=__V__'

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
export function maybeShowWeeklyRecap() {
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
// notification ('push', sent immediately from coach-app/screens/athletes.js - see sendPush()
// in push.js). A 'push' message is also inserted into this same table as a
// fallback, in case it's missed/dismissed or the athlete never enabled
// push on this device - it just falls into the same on-open bucket as
// 'on_open' rather than getting its own third bucket. Loaded once per
// session into these two caches; each queue is cleared and marked seen the
// moment it's actually shown, so re-opening the app or starting another
// workout later in the same session never shows the same message twice.
// ==========================================================================
let onOpenMessagesCache = []

export async function loadCoachMessages() {
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
  wk.beforeWorkoutMessagesCache = (data || []).filter(m => m.timing === 'before_workout')
  onOpenMessagesCache = (data || []).filter(m => m.timing !== 'before_workout')
}

// Never awaited by callers - a failed "mark seen" shouldn't block or alert
// on the athlete's own flow (same reasoning as notifyCoach above); worst
// case the same message shows again next time, which is harmless
export async function markMessagesSeen(messages) {
  const ids = messages.map(m => m.id)
  if (ids.length === 0) return
  const { error } = await supabase.from('coach_messages').update({ seen_at: new Date().toISOString() }).in('id', ids)
  if (error) console.log(error)
}

// onContinue is null for the on_open case (the button just closes the
// modal) and the actual "now really start the workout" callback for the
// before_workout case - see startWorkout() below
export function showCoachMessagesModal(messages, onContinue) {
  document.getElementById('coachMessageBody').innerHTML = messages
    .map(m => `<p class="coach-message-text">${escapeHtml(m.message)}</p>`)
    .join('')
  document.getElementById('coachMessageModal').classList.add('active')
  const continueBtn = document.getElementById('coachMessageContinueBtn')
  continueBtn.textContent = onContinue ? 'Continue' : 'Got it'
  // Only a plain dismiss in the on_open case - tagged so hardware
  // back/closeTopModal() can safely click it. Untagged in the
  // before_workout case, since that click also starts the workout: back
  // should just close the modal (see closeTopModal's fallback), never
  // trigger onContinue by proxy.
  if (onContinue) continueBtn.removeAttribute('data-modal-dismiss')
  else continueBtn.setAttribute('data-modal-dismiss', '')
  // Overwriting .onclick (not addEventListener) means each show cleanly
  // replaces the previous one instead of listeners piling up across a
  // long-lived session with several messages shown over time
  continueBtn.onclick = function() {
    document.getElementById('coachMessageModal').classList.remove('active')
    if (onContinue) onContinue()
  }
}

export function maybeShowOnOpenMessages() {
  if (onOpenMessagesCache.length === 0) return
  const messages = onOpenMessagesCache
  onOpenMessagesCache = []
  markMessagesSeen(messages)
  showCoachMessagesModal(messages, null)
}

// Also powers the on-demand Weekly Stats view (see renderWeeklyStats
// below) - scheduledCount/scheduledCompletedCount/totalVolume/hasVolumeData
// are additive fields that view needs (its PRs come separately, see
// computeWeekPREvents); totalWorkouts/totalSets/
// totalReps/totalDurationMs keep their exact original meaning and
// accumulation so the auto-popup above is unaffected
export function computeWeekRecap(weekStart) {
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
    scheduledCount, scheduledCompletedCount, totalVolume, hasVolumeData
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
    <p style="margin-top:20px; color:var(--c-text-muted); text-align:center">${pickRecapMessage(stats.totalWorkouts)}</p>
  `
  document.getElementById('weeklyRecapModal').classList.add('active')
}
